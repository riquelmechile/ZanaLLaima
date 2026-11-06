import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {restoreFixture} from './helpers/r8-restore.mjs';
import {databasePath,applyOperatorAction} from '../src/store.mjs';

test('R10-W4: epoch futuro en DB viva se acota a ahora y persiste incluso si falla acción',async()=>{
 const f=await restoreFixture();
 try{
  const path=databasePath(f.file),future='9999-12-31T23:59:59.000Z';
  let db=new DatabaseSync(path);
  try{db.prepare("INSERT INTO metadata(key,value) VALUES('restore_epoch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(future);}
  finally{db.close();}
  const received=f.signed('GRANT_WRITE',{paths:['docs'],issuedAt:'2020-01-01T00:00:00.000Z',
    expiresAt:'2020-01-01T00:10:00.000Z'});
  await assert.rejects(applyOperatorAction(received,f.file));
  db=new DatabaseSync(path,{readOnly:true});
  try{
   const epoch=db.prepare("SELECT value FROM metadata WHERE key='restore_epoch'").get()?.value;
   assert.ok(epoch&&Number.isFinite(Date.parse(epoch)));
   assert.ok(Date.parse(epoch)<=Date.now(),'Epoch futuro quedó permanente');
   assert.notEqual(epoch,future);
  }finally{db.close();}
 }finally{await f.close();}
});
