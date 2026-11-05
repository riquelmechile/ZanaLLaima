import test from 'node:test';import assert from 'node:assert/strict';
import {writeFile,rm} from 'node:fs/promises';
import {restoreFixture} from './helpers/r8-restore.mjs';
import {restoreBackup,storageRestoreAbort,databasePath,authorizationStatus} from '../src/store.mjs';
test('R8-C4 abort jamás elige cuarentena Q1 antigua por mtime',async()=>{
 const f=await restoreFixture();try{
   // Restore exitoso deja Q1. El revoke actual debe prevalecer.
   await restoreBackup(f.backup,f.file,{offline:true});
   const revocation=f.signed('REVOKE_WRITE',{grantId:f.grant.payload.nonce});
   // Tras el restore el grant recuperado está revocado por merge, por eso
   // construimos Q1 desde un backup anterior con grant vigente.
   const q1=databasePath(f.file)+'.quarantine.11111111-1111-4111-8111-111111111111';
   const {copyFile}=await import('node:fs/promises');
   await copyFile(f.backup,q1);
   const oldEvents=f.events();
   // Simula marcador legado creado antes del primer rename de una nueva operación.
   await writeFile(databasePath(f.file)+'.restore-pending','');
   await assert.rejects(storageRestoreAbort(f.file),/journal|diario|invalido|inválido|formato|JSON/i,
     'El abort no puede escoger una cuarentena vieja sin diario');
   assert.equal(f.events(),oldEvents,'La DB viva no debe ser sustituida por Q1');
   await rm(databasePath(f.file)+'.restore-pending',{force:true});
   assert.equal((await authorizationStatus(f.file)).valid,false);
 }finally{await f.close();}
});