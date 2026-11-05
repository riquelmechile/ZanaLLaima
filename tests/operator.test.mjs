import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMission, startBatch, completeUnit } from '../src/core.mjs';
import { closeMission, cancelMission } from '../src/lifecycle.mjs';
import { verifyWorkspacePaths } from '../src/paths.mjs';
import { transact, readState, applyOperatorAction, authorizationStatus,
  archiveMission, readMissionArchive, storageStatus } from '../src/store.mjs';

async function setup(){
  const dir=await mkdtemp(join(tmpdir(),'zana-operator-'));
  const file=join(dir,'state.json');
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const publicPath=join(dir,'operator-public.pem');
  await writeFile(publicPath,publicKey.export({type:'spki',format:'pem'}));
  const workspace=join(dir,'workspace');
  await mkdir(workspace);
  await mkdir(join(workspace,'docs'));
  process.env.ZANA_OPERATOR_PUBLIC_KEY_PATH=publicPath;
  process.env.ZANA_WORKSPACE_ROOT=workspace;
  const cleanup=async()=>{
    delete process.env.ZANA_OPERATOR_PUBLIC_KEY_PATH;
    delete process.env.ZANA_WORKSPACE_ROOT;
    await rm(dir,{recursive:true,force:true});
  };
  const signed=(kind,missionId,additional={})=>{
    const payload={kind,missionId,nonce:randomUUID(),
      issuedAt:new Date().toISOString(),
      expiresAt:new Date(Date.now()+600000).toISOString(),...additional};
    return {payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),privateKey).toString('base64')};
  };
  return {dir:workspace,file,signed,cleanup};
}
const proposal=()=>({objective:'Write an operator-approved guide',
  authorization:{writesAllowed:true,allowedPaths:['docs']},
  units:[{id:'guide',effect:'WRITE',instruction:'Write guide carefully',paths:['docs']}]});

test('signed operator grant is required and revocation fences uncertain effects',async()=>{
  const f=await setup();
  try{
    const initial=await transact(()=>createMission(proposal()),f.file);
    assert.equal((await authorizationStatus(f.file)).valid,false);
    await assert.rejects(transact((m,ctx)=>{startBatch(m,{},ctx.writeGrant);return m;},f.file),/No runnable batch/);
    const grant=f.signed('GRANT_WRITE',initial.id,{paths:['docs']});
    const issued=await applyOperatorAction(grant,f.file);
    assert.equal(issued.writeGrant.valid,true);
    assert.equal((await authorizationStatus(f.file)).valid,true);
    await assert.rejects(applyOperatorAction(grant,f.file),/already consumed/);
    let first;
    await transact((m,ctx)=>{first=startBatch(m,{},ctx.writeGrant).batch.packets[0];return m;},f.file);
    const revoked=f.signed('REVOKE_WRITE',initial.id,{grantId:grant.payload.nonce});
    await applyOperatorAction(revoked,f.file);
    assert.equal((await readState(f.file)).units[0].status,'OUTCOME_UNKNOWN');
    assert.equal((await authorizationStatus(f.file)).valid,false);
    await assert.rejects(transact((m,ctx)=>completeUnit(m,'guide',first.token,{
      success:true,summary:'Verified guide contents',evidence:['Source review evidence']},
      first.leaseGeneration,ctx.writeGrant),f.file),/stale/);
    const reconcile=f.signed('RECONCILE_WRITE',initial.id,{unitId:'guide',
      token:first.token,leaseGeneration:first.leaseGeneration,
      decision:'CONFIRMED_NO_EFFECT',
      evidence:['Operator checked that the guide file was never modified']});
    await applyOperatorAction(reconcile,f.file);
    assert.equal((await readState(f.file)).units[0].status,'PENDING');
    const newGrant=f.signed('GRANT_WRITE',initial.id,{paths:['docs']});
    await applyOperatorAction(newGrant,f.file);
    let second;
    await transact((m,ctx)=>{second=startBatch(m,{},ctx.writeGrant).batch.packets[0];return m;},f.file);
    assert.notEqual(first.token,second.token);
    assert.equal(second.leaseGeneration,first.leaseGeneration+1);
    await transact((m,ctx)=>completeUnit(m,'guide',second.token,{
      success:true,summary:'Verified guide and relevant invariants',
      evidence:['Operator authorized scope and exact file reviewed']},
      second.leaseGeneration,ctx.writeGrant),f.file);
    await transact(m=>{closeMission(m);return m;},f.file);
    assert.equal((await archiveMission(f.file)).archived,true);
    assert.equal(await readState(f.file),null);
    assert.equal((await readMissionArchive({},f.file)).items.length,1);
    await transact(()=>createMission({objective:'Followup task without a previous mission',
      authorization:{writesAllowed:false,allowedPaths:[]},
      units:[{id:'check',effect:'READ',instruction:'Inspect current status'}]}),f.file);
    assert.equal((await storageStatus(f.file)).backend,'SQLITE_WAL');
  }finally{await f.cleanup();}
});

test('invalid grants, widening scope and replayed signatures fail closed',async()=>{
  const f=await setup();
  try{
    const m=await transact(()=>createMission(proposal()),f.file);
    const wide=f.signed('GRANT_WRITE',m.id,{paths:['secrets']});
    await assert.rejects(applyOperatorAction(wide,f.file),/exceeds/);
    const grant=f.signed('GRANT_WRITE',m.id,{paths:['docs']});
    const tampered=structuredClone(grant);tampered.payload.paths=['docs','secrets'];
    await assert.rejects(applyOperatorAction(tampered,f.file),/signature/);
    await applyOperatorAction(grant,f.file);
    assert.equal((await authorizationStatus(f.file)).valid,true);
    assert.equal((await readState(f.file)).status,'ACTIVE');
  }finally{await f.cleanup();}
});

test('workspace path inspection rejects symbolic links and traversal',async()=>{
  const f=await setup();
  try{
    const external=join(f.dir,'external');
    await mkdir(external);
    await symlink(external,join(f.dir,'docs','link'));
    await assert.rejects(verifyWorkspacePaths(['docs/link/file.txt'],f.dir),/Symlink/);
    await assert.rejects(verifyWorkspacePaths(['../outside'],f.dir),/Unsafe path/);
    const safe=await verifyWorkspacePaths(['docs/guide.md'],f.dir);
    assert.equal(safe.scopeVerified,true);
    assert.equal(safe.assurance,'PATH_INSPECTED_NOT_ATOMIC_WRITE_ENFORCEMENT');
  }finally{await f.cleanup();}
});

test('a crashed write remains uncertain and never replays automatically',async()=>{
  const f=await setup();
  try{
    const m=await transact(()=>createMission(proposal()),f.file);
    await applyOperatorAction(f.signed('GRANT_WRITE',m.id,{paths:['docs']}),f.file);
    let claimed;
    await transact((state,ctx)=>{
      claimed=startBatch(state,{},ctx.writeGrant,5).batch.packets[0];
      return state;
    },f.file);
    const target=join(f.dir,'docs','guide.md');
    const child=spawnSync(process.execPath,['-e',
      "require('node:fs').writeFileSync(process.argv[1],'written once');process.exit(57)",
      target],{encoding:'utf8'});
    assert.equal(child.status,57,child.stderr);
    await transact(state=>{
      state.units[0].run.expiresAt=new Date(Date.now()-1000).toISOString();
      state.revision++;return state;
    },f.file);
    const recovery=spawnSync(process.execPath,['src/cli.mjs','recover-expired'],
      {cwd:process.cwd(),encoding:'utf8',
        env:{...process.env,ZANA_STATE_FILE:f.file}});
    assert.equal(recovery.status,0,recovery.stderr);
    assert.equal(JSON.parse(recovery.stdout).changed[0].status,'OUTCOME_UNKNOWN');
    assert.equal(await readFile(target,'utf8'),'written once');
    await assert.rejects(transact((state,ctx)=>{
      startBatch(state,{},ctx.writeGrant);return state;
    },f.file),/No runnable batch/);
    await applyOperatorAction(f.signed('RECONCILE_WRITE',m.id,{
      unitId:'guide',token:claimed.token,leaseGeneration:claimed.leaseGeneration,
      decision:'CONFIRMED_DONE',
      evidence:['Operator inspected guide.md on disk and confirmed its final content']}),f.file);
    assert.equal((await readState(f.file)).units[0].status,'DONE');
    assert.equal(await readFile(target,'utf8'),'written once');
  }finally{await f.cleanup();}
});

test('an expired signed approval cannot open a WRITE claim',async()=>{
  const f=await setup();
  try{
    const m=await transact(()=>createMission(proposal()),f.file);
    const expired=f.signed('GRANT_WRITE',m.id,{paths:['docs']});
    expired.payload.expiresAt=new Date(Date.now()-10).toISOString();
    await assert.rejects(applyOperatorAction(expired,f.file),/expired/);
    assert.equal((await authorizationStatus(f.file)).valid,false);
  }finally{await f.cleanup();}
});

test('cancel revokes active authorization and requires signed reconciliation',async()=>{
  const f=await setup();
  try{
    const m=await transact(()=>createMission(proposal()),f.file);
    await applyOperatorAction(f.signed('GRANT_WRITE',m.id,{paths:['docs']}),f.file);
    let packet;
    await transact((state,ctx)=>{
      packet=startBatch(state,{},ctx.writeGrant).batch.packets[0];return state;
    },f.file);
    await transact(state=>{cancelMission(state);return state;},f.file);
    assert.equal((await readState(f.file)).status,'CANCELLING');
    assert.equal((await authorizationStatus(f.file)).valid,false);
    assert.equal((await readState(f.file)).units[0].status,'OUTCOME_UNKNOWN');
    await assert.rejects(archiveMission(f.file),/closed or cancelled/);
    await applyOperatorAction(f.signed('RECONCILE_WRITE',m.id,{unitId:'guide',
      token:packet.token,leaseGeneration:packet.leaseGeneration,
      decision:'CONFIRMED_NO_EFFECT',
      evidence:['Operator checked the disk and no document was created']}),f.file);
    assert.equal((await readState(f.file)).status,'CANCELLED');
    assert.equal((await archiveMission(f.file)).archived,true);
  }finally{await f.cleanup();}
});
