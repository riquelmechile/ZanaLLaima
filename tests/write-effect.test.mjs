import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,rename,symlink,link} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMission} from '../src/core.mjs';
import {readState,storageStatus,transact,applyOperatorAction} from '../src/store.mjs';
import {operations} from '../src/actions.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
const outcome={success:true,summary:'Verified the committed file content',
  evidence:['Confirmed the actual filesystem state and SHA']};
async function fixture({budget={}}={}){
  const dir=await mkdtemp(join(tmpdir(),'zana-effect-v5-'));
  const publicPath=join(dir,'public.pem'),file=join(dir,'state.json');
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  await writeFile(publicPath,publicKey.export({type:'spki',format:'pem'}));
  await mkdir(join(dir,'docs'));
  const old={state:process.env.ZANA_STATE_FILE,operator:process.env.ZANA_OPERATOR_PUBLIC_KEY_PATH,
    root:process.env.ZANA_WORKSPACE_ROOT};
  process.env.ZANA_STATE_FILE=file;
  process.env.ZANA_OPERATOR_PUBLIC_KEY_PATH=publicPath;
  process.env.ZANA_WORKSPACE_ROOT=dir;
  const mission=await transact(()=>createMission({
    objective:'Apply one signed filesystem effect',
    authorization:{writesAllowed:true,allowedPaths:['docs']},budget,
    units:[{id:'write',effect:'WRITE',paths:['docs'],
      instruction:'Write an approved file using the MCP effect boundary'}],
  }),file);
  const signed=(kind,extra={})=>{
    const payload={kind,missionId:mission.id,nonce:randomUUID(),
      issuedAt:new Date().toISOString(),
      expiresAt:new Date(Date.now()+600000).toISOString(),...extra};
    return {payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),privateKey).toString('base64')};
  };
  const grant=signed('GRANT_WRITE',{paths:['docs']});
  await applyOperatorAction(grant,file);
  const packet=(await operations.start({})).packets[0];
  return {dir,file,signed,grant,packet,
    args:(overrides={})=>({unitId:'write',token:packet.token,leaseGeneration:packet.leaseGeneration,
      path:'docs/guide.txt',content:'first safe content',...overrides}),
    cleanup:async()=>{
      for(const [key,value] of Object.entries({ZANA_STATE_FILE:old.state,
        ZANA_OPERATOR_PUBLIC_KEY_PATH:old.operator,ZANA_WORKSPACE_ROOT:old.root})){
        if(value===undefined)delete process.env[key];else process.env[key]=value;
      }
      await rm(dir,{recursive:true,force:true});
    }};
}
async function absent(path){await assert.rejects(readFile(path),{code:'ENOENT'});}
test('signed write effect records a unique receipt and enables completion',async()=>{
  const f=await fixture();
  try{
    await assert.rejects(operations.complete({unitId:'write',token:f.packet.token,
      leaseGeneration:f.packet.leaseGeneration,outcome}),/zana_apply_write/);
    const result=await operations.applyWrite(f.args());
    assert.equal(result.preSha256,null);
    assert.equal(result.postSha256,sha('first safe content'));
    assert.equal(await readFile(join(f.dir,'docs/guide.txt'),'utf8'),'first safe content');
    assert.equal((await storageStatus(f.file)).writeEffectReceipts,1);
    await operations.complete({unitId:'write',token:f.packet.token,
      leaseGeneration:f.packet.leaseGeneration,outcome});
    assert.equal((await readState(f.file)).units[0].status,'DONE');
    await assert.rejects(operations.applyWrite(f.args()),/required state|already attempted/);
  }finally{await f.cleanup();}
});
test('traversal, absolute paths and unsanctioned scopes fail before effect',async()=>{
  const f=await fixture();
  try{
    for(const path of ['../escape','/tmp/bad','docs//bad','docs/../bad','docs\\bad','secrets/a','README.md'])
      await assert.rejects(operations.applyWrite(f.args({path})),/Unsafe|outside/);
    assert.equal((await readState(f.file)).units[0].status,'RUNNING');
    await absent(join(f.dir,'docs/guide.txt'));
  }finally{await f.cleanup();}
});
test('wrong preimage hash rejects without changing filesystem or claim',async()=>{
  const f=await fixture();
  try{
    await writeFile(join(f.dir,'docs/guide.txt'),'original');
    await assert.rejects(operations.applyWrite(f.args({expectedPreSha256:sha('incorrect')})),
      /expectedPreSha256 differs/);
    assert.equal(await readFile(join(f.dir,'docs/guide.txt'),'utf8'),'original');
    assert.equal((await readState(f.file)).units[0].status,'RUNNING');
  }finally{await f.cleanup();}
});
test('symlink replacement after reservation cannot escape the workspace',async()=>{
  const f=await fixture();
  try{
    const external=join(f.dir,'external');
    await mkdir(external);
    await rename(join(f.dir,'docs'),join(f.dir,'docs-original'));
    await symlink(external,join(f.dir,'docs'),'dir');
    await assert.rejects(operations.applyWrite(f.args()),/ELOOP|symlink|changed|ENOTDIR/i);
    await absent(join(external,'guide.txt'));
  }finally{await f.cleanup();}
});
test('nested symlinks and hardlinked targets are blocked',async()=>{
  const f=await fixture();
  try{
    const external=join(f.dir,'external');
    await mkdir(external);
    await symlink(external,join(f.dir,'docs','nested'),'dir');
    await assert.rejects(operations.applyWrite(f.args({path:'docs/nested/pwn.txt'})),
      /symlink|ELOOP|ENOTDIR|directory/i);
    await absent(join(external,'pwn.txt'));
    const shared=join(f.dir,'docs','shared.txt');
    await writeFile(shared,'shared');
    await link(shared,join(f.dir,'docs','guide.txt'));
    await assert.rejects(operations.applyWrite(f.args()),/hardlink/);
    assert.equal(await readFile(shared,'utf8'),'shared');
  }finally{await f.cleanup();}
});
test('stale token, generation, expired lease and revoked grant reject effects',async()=>{
  const f=await fixture();
  try{
    await assert.rejects(operations.applyWrite(f.args({token:randomUUID()})),/Stale/);
    await assert.rejects(operations.applyWrite(f.args({leaseGeneration:999})),/Stale/);
    await transact(m=>{m.units[0].run.expiresAt=new Date(Date.now()-1000).toISOString();
      m.revision++;return m;},f.file);
    await assert.rejects(operations.applyWrite(f.args()),/Lease expired/);
    await absent(join(f.dir,'docs/guide.txt'));
    await transact(m=>{m.units[0].run.expiresAt=new Date(Date.now()+60000).toISOString();
      m.revision++;return m;},f.file);
    await applyOperatorAction(f.signed('REVOKE_WRITE',{grantId:f.grant.payload.nonce}),f.file);
    await assert.rejects(operations.applyWrite(f.args()),/required state|revoked/);
    assert.equal((await readState(f.file)).units[0].status,'OUTCOME_UNKNOWN');
  }finally{await f.cleanup();}
});
test('UTF-8 byte budget and deleteFile preimage are enforced',async()=>{
  const f=await fixture({budget:{maxResultBytes:1024}});
  try{
    await assert.rejects(operations.applyWrite(f.args({content:'漢'.repeat(500)})),/byte budget/);
    assert.equal((await readState(f.file)).units[0].status,'RUNNING');
    await assert.rejects(operations.applyWrite(f.args({deleteFile:true,content:undefined})),
      /Cannot delete missing file/);
    await writeFile(join(f.dir,'docs/guide.txt'),'remove me');
    const result=await operations.applyWrite(f.args({
      content:undefined,deleteFile:true,expectedPreSha256:sha('remove me')}));
    assert.equal(result.preSha256,sha('remove me'));
    assert.equal(result.postSha256,null);
    await absent(join(f.dir,'docs/guide.txt'));
  }finally{await f.cleanup();}
});
test('crash between atomic effect and SQLite receipt remains uncertain; no replay',async()=>{
  const f=await fixture();
  try{
    const code="import {applyWriteEffect} from './src/write-operations.mjs'; await applyWriteEffect(JSON.parse(process.argv[1]),process.argv[2],{afterEffect:()=>process.exit(63)});";
    const child=spawnSync(process.execPath,['--input-type=module','-e',code,
      JSON.stringify(f.args({content:'committed before crash'})),f.file],{
        cwd:process.cwd(),encoding:'utf8',env:{...process.env}});
    assert.equal(child.status,63,child.stderr);
    assert.equal(await readFile(join(f.dir,'docs/guide.txt'),'utf8'),'committed before crash');
    const m=await readState(f.file);
    assert.equal(m.units[0].status,'OUTCOME_UNKNOWN');
    assert.equal(m.units[0].run.effectIntent.status,'INTENT_DURABLE');
    assert.equal((await storageStatus(f.file)).writeEffectReceipts,0);
    await assert.rejects(operations.applyWrite(f.args()),/required state/);
    await applyOperatorAction(f.signed('RECONCILE_WRITE',{
      unitId:'write',token:f.packet.token,leaseGeneration:f.packet.leaseGeneration,
      decision:'CONFIRMED_DONE',
      evidence:['Operator inspected the actual file and verified its content hash']}),f.file);
    assert.equal((await readState(f.file)).units[0].status,'DONE');
  }finally{await f.cleanup();}
});
