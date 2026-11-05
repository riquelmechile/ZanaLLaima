import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rename,stat,link} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {restoreFixture} from './helpers/r8-restore.mjs';
import {runCli} from '../src/cli.mjs';
import {databasePath,authorizationStatus,storageStatus} from '../src/store.mjs';

test('R9 W3: adoptar cuarentena exacta tras pérdida de DB conserva revocación, nonces y evento',async()=>{
 const f=await restoreFixture();
 try{
  const path=databasePath(f.file),id=randomUUID(),q=path+'.quarantine.'+id;
  const db=new DatabaseSync(path);
  try{db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{db.close();}
  const before=f.events();
  const sec=new DatabaseSync(path,{readOnly:true});
  const previousActions=sec.prepare('SELECT COUNT(*) AS n FROM operator_actions').get().n;
  try{assert.ok(previousActions>=2);}finally{sec.close();}
  await rename(path,q);
  await assert.rejects(runCli('storage-adopt-quarantine',[id]),/confirm/i);
  const adopted=await runCli('storage-adopt-quarantine',[id,'--confirm']);
  assert.equal(adopted.adopted,true);
  assert.equal(adopted.quarantineId,id);
  assert.equal((await authorizationStatus(f.file)).valid,false);
  assert.equal((await storageStatus(f.file)).events,before+1);
  const recovered=new DatabaseSync(path,{readOnly:true});
  try{
    assert.equal(recovered.prepare('SELECT COUNT(*) AS n FROM operator_actions').get().n,previousActions);
    assert.equal(recovered.prepare(
      "SELECT COUNT(*) AS n FROM state_events WHERE category='QUARANTINE_ADOPTED'").get().n,1);
  }finally{recovered.close();}
  await assert.rejects(stat(q),{code:'ENOENT'});
 }finally{await f.close();}
});
test('R9 W3: no adoptar cuarentena si existe DB viva o id inválido',async()=>{
 const f=await restoreFixture();
 try{
  await assert.rejects(runCli('storage-adopt-quarantine',[randomUUID(),'--confirm']),
    /existente|presente|live|already|cannot|no se puede|No está|NOT_FOUND/i);
  await assert.rejects(runCli('storage-adopt-quarantine',['../../evil','--confirm']),/id|UUID|inval/i);
 }finally{await f.close();}
});

test('R10-W2: tras SIGKILL entre link y rm, adoptar mismo UUID completa hardlink sin pérdida',async()=>{
 const f=await restoreFixture();
 try{
  const path=databasePath(f.file),id=randomUUID(),q=path+'.quarantine.'+id;
  const db=new DatabaseSync(path);
  try{db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{db.close();}
  await rename(path,q);
  const first=await runCli('storage-adopt-quarantine',[id,'--confirm']);
  assert.equal(first.adopted,true);
  // Estado durable exacto que deja un crash después de link pero antes de rm:
  // la DB publicada y la cuarentena comparten dev/ino y nlink=2.
  await link(path,q);
  const published=await stat(path),duplicate=await stat(q);
  assert.equal(published.ino,duplicate.ino);
  const recovered=await runCli('storage-adopt-quarantine',[id,'--confirm']);
  assert.equal(recovered.adopted,true);
  assert.equal(recovered.recovered,true);
  await assert.rejects(stat(q),{code:'ENOENT'});
  assert.equal((await authorizationStatus(f.file)).valid,false);
 }finally{await f.close();}
});
