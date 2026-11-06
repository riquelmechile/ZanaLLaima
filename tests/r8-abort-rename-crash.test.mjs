import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {restoreFixture} from './helpers/r8-restore.mjs';
import {storageRestoreAbort,authorizationStatus} from '../src/store.mjs';
const storeURL=new URL('../src/store.mjs',import.meta.url).href;
test('R8-C6 SIGKILL durante abort, rerun no pierde WAL ni revocación',async()=>{
 const f=await restoreFixture();try{
  const count=f.events();
  const start='import {restoreBackup} from '+JSON.stringify(storeURL)+
    ';await restoreBackup(process.argv[1],process.argv[2],{offline:true,'+
    'afterQuarantine:async()=>process.kill(process.pid,"SIGKILL")});';
  const first=spawnSync(process.execPath,['--input-type=module','-e',start,f.backup,f.file],
   {encoding:'utf8',env:{...process.env},timeout:15000});
  assert.equal(first.signal,'SIGKILL',first.stderr);
  const abort='import {storageRestoreAbort} from '+JSON.stringify(storeURL)+
    ';await storageRestoreAbort(process.argv[1],{afterRename:async ({ordinal})=>'+
    '{if(ordinal===1)process.kill(process.pid,"SIGKILL");}});';
  const second=spawnSync(process.execPath,['--input-type=module','-e',abort,f.file],
   {encoding:'utf8',env:{...process.env},timeout:15000});
  assert.equal(second.signal,'SIGKILL','Abort crash injection not reached: '+second.stderr);
  const resumed=await storageRestoreAbort(f.file);
  assert.equal(resumed.aborted,true);
  assert.equal((await authorizationStatus(f.file)).valid,false);
  assert.equal(f.events(),count);
 }finally{await f.close();}
});