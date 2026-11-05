import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {restoreFixture} from './helpers/r8-restore.mjs';
import {storageRestoreAbort,authorizationStatus,storageStatus} from '../src/store.mjs';
const moduleURL=new URL('../src/store.mjs',import.meta.url).href;

function kill(f,point){
 const js='import {restoreBackup} from '+JSON.stringify(moduleURL)+';'+
  'await restoreBackup(process.argv[1],process.argv[2],{offline:true,'+
  'afterJournalReady:async()=>{if(process.argv[3]==="ready")process.kill(process.pid,"SIGKILL");},'+
  'afterQuarantine:async()=>{if(process.argv[3]==="quarantine")process.kill(process.pid,"SIGKILL");},'+
  'afterRename:async ({ordinal})=>{if(process.argv[3]===String(ordinal))process.kill(process.pid,"SIGKILL");}'+
  '});';
 return spawnSync(process.execPath,['--input-type=module','-e',js,f.backup,f.file,String(point)],
  {env:{...process.env},encoding:'utf8',timeout:15000});
}

test('R9 recovery: SIGKILL en journal ready, cuarentena y cada ordinal de rename recuperable',async()=>{
 let checked=0,finished=false;
 for(const point of ['ready',1,2,3,4,5,'quarantine']){
  const f=await restoreFixture();
  try{
   const events=f.events();
   const outcome=kill(f,point);
   if(typeof point==='number'&&outcome.status===0){
     finished=true;
     // The final step was already committed without a crash.
     assert.equal((await authorizationStatus(f.file)).valid,false);
     break;
   }
   assert.equal(outcome.signal,'SIGKILL','No se activó SIGKILL en '+point+': '+outcome.stderr);
   const recovered=await storageRestoreAbort(f.file);
   assert.equal(recovered.aborted,true,'Abort falló en '+point);
   assert.equal((await authorizationStatus(f.file)).valid,false,
     'Revivió un grant revocado al abortar '+point);
   assert.equal(f.events(),events,'Se perdió historia al abortar '+point);
   assert.equal((await storageStatus(f.file)).integrity,'ok');
   checked++;
  }finally{await f.close();}
 }
 assert.ok(checked>=3,'No se comprobaron suficientes etapas de recuperación');
 assert.equal(finished,true,'No se alcanzó el final de la secuencia de renames');
 console.log('R9_KILL_RESTORE_CHECKPOINTS='+checked+' CHECKPOINT_SCOPE=journal-ready,rename,quarantine');
});
