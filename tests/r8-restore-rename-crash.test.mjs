import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {restoreFixture} from './helpers/r8-restore.mjs';
import {storageRestoreAbort,authorizationStatus} from '../src/store.mjs';
const storeURL=new URL('../src/store.mjs',import.meta.url).href;
test('R8-C5 SIGKILL tras primer rename de DB exige diario y conserva WAL, grants, eventos',async()=>{
 const f=await restoreFixture();try{
  const count=f.events();
  const program='import {restoreBackup} from '+JSON.stringify(storeURL)+
    '; await restoreBackup(process.argv[1],process.argv[2],{offline:true,'+
    'afterRename:async ({ordinal})=>{if(ordinal===1)process.kill(process.pid,"SIGKILL");}});';
  const killed=spawnSync(process.execPath,['--input-type=module','-e',program,f.backup,f.file],
    {encoding:'utf8',env:{...process.env},timeout:15000});
  assert.equal(killed.signal,'SIGKILL','Crash injection after rename 1 did not fire: '+killed.stderr);
  const result=await storageRestoreAbort(f.file);
  assert.equal(result.aborted,true);
  assert.equal((await authorizationStatus(f.file)).valid,false);
  assert.equal(f.events(),count,'No perder evento REVOKE confirmado en WAL');
 }finally{await f.close();}
});