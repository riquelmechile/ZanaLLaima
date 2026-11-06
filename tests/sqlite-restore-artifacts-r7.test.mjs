import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMission} from '../src/core.mjs';
import {transact,storageStatus,databasePath,backupState} from '../src/store.mjs';
test('R7 W7: storage-status muestra restauraciones y cuarentenas huérfanas',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'zana-r7-orphans-')),file=join(dir,'state.json');
 try{
   await transact(()=>createMission({objective:'Inventariar artefactos de restore',
     authorization:{writesAllowed:false,allowedPaths:[]},
     units:[{id:'read',effect:'READ',instruction:'Consultar artefactos'}]}),file);
   const db=databasePath(file),id=randomUUID();
   const restoring=db+'.restoring.'+id,quarantine=db+'.quarantine.'+randomUUID();
   await writeFile(restoring,'huérfano');
   await writeFile(quarantine,'respaldo');
   const status=await storageStatus(file);
   assert.ok(status.restoreArtifacts.restoring.includes(restoring));
   assert.ok(status.restoreArtifacts.quarantines.includes(quarantine));
   const backup=join(dir,'backup.sqlite');await backupState(backup,file);
   const names=await readdir(dir);
   assert.equal(names.some(x=>x.startsWith('backup.sqlite.')&&
     (x.endsWith('.tmp')||x.endsWith('.tmp-wal')||x.endsWith('.tmp-shm'))),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
