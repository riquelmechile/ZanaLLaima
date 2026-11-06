import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {restoreFixture} from './helpers/r8-restore.mjs';
import {restoreBackup,databasePath,authorizationStatus} from '../src/store.mjs';
import {capturePathAnchors} from '../src/write-effect.mjs';
import {createMission,startBatch} from '../src/core.mjs';
import {heartbeatUnit} from '../src/lifecycle.mjs';
const getEpoch=path=>{
 const db=new DatabaseSync(path);
 try{return db.prepare("SELECT value FROM metadata WHERE key='restore_epoch'").get()?.value??null;}
 finally{db.close();}
};
const putEpoch=(path,value)=>{
 const db=new DatabaseSync(path);
 try{db.prepare("INSERT INTO metadata(key,value) VALUES('restore_epoch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value);}
 finally{db.close();}
};
for(const corrupt of ['zzzz','~']){
 test('R8-W1 invalid backup epoch '+JSON.stringify(corrupt)+' fences at now',async()=>{
  const f=await restoreFixture();try{
   putEpoch(f.backup,corrupt);
   const start=Date.now();
   await restoreBackup(f.backup,f.file,{offline:true});
   const epoch=getEpoch(databasePath(f.file));
   assert.ok(Number.isFinite(Date.parse(epoch)));
   assert.ok(Date.parse(epoch)>=start-1000,'Invalid epoch must not disable security fence');
   assert.equal((await authorizationStatus(f.file)).valid,false);
  }finally{await f.close();}
 });
}
test('R9-W4 epoch futuro ISO se acota a ahora',async()=>{
 const f=await restoreFixture();try{
  const start=Date.now(),future=new Date(start+86400000).toISOString();
  putEpoch(f.backup,'zzzz');
  putEpoch(databasePath(f.file),future);
  await restoreBackup(f.backup,f.file,{offline:true});
  const epoch=Date.parse(getEpoch(databasePath(f.file)));
  assert.ok(epoch>=start-1000&&epoch<=Date.now(),
   'Epoch futuro no puede bloquear autorizaciones para siempre');
 }finally{await f.close();}
});
test('R8-W6 scope pointing to a regular file stops anchor traversal safely',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'r8-capture-file-'));try{
  await mkdir(join(dir,'docs'));await writeFile(join(dir,'docs','file.txt'),'readable');
  const result=await capturePathAnchors(['docs/file.txt'],dir);
  assert.equal(result.workspaceRoot,dir);
  assert.ok(result.anchors['docs']);
  assert.equal(result.anchors['docs/file.txt'],undefined);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('R8-W6 heartbeat at expiresAt and after DONE are always rejected',()=>{
 const m=createMission({objective:'Lease boundary at exact expiration',
  authorization:{writesAllowed:false,allowedPaths:[]},
  units:[{id:'read',effect:'READ',instruction:'Read only'}]});
 const packet=startBatch(m).batch.packets[0];
 const args={unitId:'read',token:packet.token,leaseGeneration:packet.leaseGeneration};
 m.units[0].run.expiresAt=new Date(Date.now()-1000).toISOString();
 assert.throws(()=>heartbeatUnit(m,args),/Lease expired/);
 m.units[0].run.expiresAt=new Date(Date.now()+600000).toISOString();
 m.units[0].status='DONE';
 assert.throws(()=>heartbeatUnit(m,args),/stale/);
});
