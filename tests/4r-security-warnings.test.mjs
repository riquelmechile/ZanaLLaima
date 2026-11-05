import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createMission} from '../src/core.mjs';
import {validateWriteRequest,capturePathAnchors,workspaceRoot} from '../src/write-effect.mjs';
import {verifyWorkspacePaths} from '../src/paths.mjs';
import {operatorPublicKey,verifySignedAction} from '../src/operator.mjs';
import {readVerifierKey} from '../src/delivery.mjs';
import {reconcileWrite} from '../src/lifecycle.mjs';
import {transact,databasePath} from '../src/store.mjs';

const tmp=()=>mkdtempSync(join(tmpdir(),'zana-r4-security-'));
const proposal=(p='docs')=>({objective:'Verify the scope boundary in every authorized layer',
  authorization:{writesAllowed:true,allowedPaths:[p]},
  units:[{id:'write',effect:'WRITE',paths:[p],instruction:'Write the scoped document'}]});
const bad=['.git/config','docs/.git/config','.zana/state.sqlite','docs/.zana/local',
  '~','docs/~','docs/\0file','a'.repeat(241),'docs/../escape','../up',
  '/tmp/absolute','docs\\evil','docs//double'];

test('WARNING paths: mission, grant, effect and workspace inspection reject the same unsafe paths',async()=>{
  const dir=tmp();
  try{
    mkdirSync(join(dir,'docs'));
    const mission=createMission(proposal());
    const pair=generateKeyPairSync('ed25519');
    for(const path of bad){
      assert.throws(()=>createMission(proposal(path)),/Unsafe/,
        'Mission accepted '+JSON.stringify(path));
      assert.throws(()=>validateWriteRequest({path,content:'x'},1024),/Unsafe/,
        'Effect accepted '+JSON.stringify(path));
      await assert.rejects(verifyWorkspacePaths([path],dir),/Unsafe/,
        'Workspace inspection accepted '+JSON.stringify(path));
      const payload={kind:'GRANT_WRITE',missionId:mission.id,nonce:randomUUID(),
        issuedAt:new Date().toISOString(),
        expiresAt:new Date(Date.now()+600000).toISOString(),paths:[path]};
      const envelope={payload,signature:sign(null,
        Buffer.from(JSON.stringify(payload)),pair.privateKey).toString('base64')};
      await assert.rejects(async()=>verifySignedAction(envelope,mission,pair.publicKey),
        /Invalid permitted paths|Unsafe/, 'Signed grant accepted '+JSON.stringify(path));
    }
    const policy=await import('../src/paths.mjs');
    assert.equal(typeof policy.validateRelativePath,'function');
    assert.equal(typeof policy.inScope,'function');
    assert.equal(policy.inScope('docs/file.txt',['docs']),true);
    assert.equal(policy.inScope('docs/.git/config',['docs']),false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('WARNING workspace: state DB cannot live beneath a writable workspace root',async()=>{
  const dir=tmp(),previous=process.env.ZANA_STATE_FILE;
  try{
    process.env.ZANA_STATE_FILE=join(dir,'.zana','state.json');
    await assert.rejects(workspaceRoot(dir),/state|database|workspace/i);
  }finally{
    if(previous===undefined)delete process.env.ZANA_STATE_FILE;
    else process.env.ZANA_STATE_FILE=previous;
    rmSync(dir,{recursive:true,force:true});
  }
});

test('WARNING reconciliation: whitespace-only evidence is rejected by lifecycle',()=>{
  const m=createMission(proposal());
  m.units[0].status='OUTCOME_UNKNOWN';
  const token=randomUUID();
  m.units[0].attempts=1;
  m.units[0].run={token,leaseGeneration:1};
  assert.throws(()=>reconcileWrite(m,{unitId:'write',token,leaseGeneration:1,
    decision:'CONFIRMED_DONE',evidence:['            ']}),/evidence/i);
});

test('WARNING capturePathAnchors: 50 rejected scopes do not leak directory FDs',async()=>{
  if(process.platform!=='linux')return;
  const dir=tmp();
  try{
    mkdirSync(join(dir,'docs'));mkdirSync(join(dir,'docs','nested'));
    symlinkSync('/tmp',join(dir,'docs','nested','bad'));
    const count=()=>readdirSync('/proc/self/fd').length;
    const before=count();
    for(let i=0;i<50;i++)
      await assert.rejects(capturePathAnchors(['docs/nested/bad/x.txt'],dir),
        /Symlink|symlink|ELOOP|ENOTDIR/);
    assert.ok(count()<=before+3,'Open FD leak: '+before+' -> '+count());
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('WARNING public key: private PEM must never pass as an operator or verifier key',async()=>{
  const dir=tmp();
  try{
    const kp=generateKeyPairSync('ed25519');
    const file=join(dir,'wrong-public.pem');
    writeFileSync(file,kp.privateKey.export({type:'pkcs8',format:'pem'}));
    await assert.rejects(operatorPublicKey(file),/PUBLIC KEY|public key|Private/i);
    assert.throws(()=>readVerifierKey(file),/PUBLIC KEY|public key|Private/i);
    writeFileSync(file,kp.publicKey.export({type:'spki',format:'pem'}));
    assert.equal((await operatorPublicKey(file)).key.asymmetricKeyType,'ed25519');
    assert.equal(readVerifierKey(file).asymmetricKeyType,'ed25519');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('WARNING SQLite: automatic ROLLBACK retains original RAISE error',async()=>{
  const dir=tmp(),file=join(dir,'state.json');
  try{
    await transact(()=>createMission({objective:'Persist source revision with rollback',
      authorization:{writesAllowed:false,allowedPaths:[]},
      units:[{id:'read',effect:'READ',instruction:'Inspect an artifact'}]}),file);
    const db=new DatabaseSync(databasePath(file));
    try{
      db.exec("CREATE TRIGGER rollback_injected BEFORE UPDATE ON active_mission "+
        "BEGIN SELECT RAISE(ROLLBACK, 'INJECTED_SQLITE_ROLLBACK'); END");
    }finally{db.close();}
    await assert.rejects(transact(m=>{m.revision++;return m;},file),/INJECTED_SQLITE_ROLLBACK/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
