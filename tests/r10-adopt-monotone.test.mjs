import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {copyFile,rename,stat} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {restoreFixture} from './helpers/r8-restore.mjs';
import {storageAdoptQuarantine,authorizationStatus,applyOperatorAction,databasePath,storageStatus} from '../src/store.mjs';

test('R10-C2: adoptar Q_old nunca revive un GRANT que Q_new revocó',async()=>{
 const f=await restoreFixture();
 try{
  const base=databasePath(f.file),oldId=randomUUID(),newId=randomUUID();
  const qOld=base+'.quarantine.'+oldId,qNew=base+'.quarantine.'+newId;
  const oldGrant=f.signed('GRANT_WRITE',{paths:['docs']});
  await copyFile(f.backup,qOld);
  const live=new DatabaseSync(base);
  try{live.exec('PRAGMA wal_checkpoint(TRUNCATE)');}
  finally{live.close();}
  await rename(base,qNew);
  const before=await storageStatus(f.file);
  const details=before.restoreArtifacts.quarantineDetails;
  assert.equal(details?.length,2,'storage-status debe auditar cada cuarentena');
  for(const row of details){
   assert.ok(Number.isInteger(row.revision),'falta revision '+row.path);
   assert.equal(typeof row.updatedAt,'string');
   assert.ok(Number.isInteger(row.revocations),'falta cantidad revocaciones');
  }
  const adopted=await storageAdoptQuarantine(oldId,f.file,{confirm:true});
  assert.equal(adopted.adopted,true);
  assert.equal((await authorizationStatus(f.file)).valid,false,'Se revivió un GRANT revocado');

  const adoptedDB=new DatabaseSync(base,{readOnly:true});
  try{
   assert.equal(adoptedDB.prepare('SELECT revoked FROM operator_grants WHERE grant_id=?')
     .get(f.grant.payload.nonce)?.revoked,1);
   assert.ok(adoptedDB.prepare('SELECT nonce FROM operator_actions WHERE nonce=?')
     .get(f.revocation.payload.nonce),'Se perdió el nonce consumido del REVOKE');
   const epoch=adoptedDB.prepare("SELECT value FROM metadata WHERE key='restore_epoch'").get()?.value;
   assert.ok(epoch&&Number.isFinite(Date.parse(epoch))&&Date.parse(epoch)<=Date.now(),
     'Sin epoch ciego tras adoptar DB de historia incompleta');
  }finally{adoptedDB.close();}
  await assert.rejects(applyOperatorAction(f.revocation,f.file),
    /nonce|epoch|consumed|already|issuedAt/i,'REVOKE original no se debe re-aplicar');
  await assert.rejects(applyOperatorAction(oldGrant,f.file),/epoch|issuedAt/i,
    'GRANT firmado antes de adopt no debe poder reactivarse');
  await delay(20);
  const fresh=f.signed('GRANT_WRITE',{paths:['docs']});
  const result=await applyOperatorAction(fresh,f.file);
  assert.equal(result.kind,'GRANT_WRITE');
  assert.equal((await authorizationStatus(f.file)).valid,true,
    'Nueva autorización del operador después de adoptar debe funcionar');
 }finally{await f.close();}
});
