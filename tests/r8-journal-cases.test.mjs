import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {restoreFixture} from './helpers/r8-restore.mjs';
import {DatabaseSync} from 'node:sqlite';
import {restoreBackup,storageRestoreAbort,storageCleanupArtifacts,storageStatus,
  authorizationStatus,databasePath} from '../src/store.mjs';
import {classifyRestoreArtifacts,cleanupRestoreArtifacts,RestoreJournalError} from '../src/restore-journal.mjs';
const storeURL=new URL('../src/store.mjs',import.meta.url).href;
async function killRestore(f,option){
 const expr=option==='before'
  ?'afterJournalReady:async()=>process.kill(process.pid,"SIGKILL")'
  :'afterRename:async ({ordinal})=>{if(ordinal==='+option+')process.kill(process.pid,"SIGKILL");}';
 const js='import {restoreBackup} from '+JSON.stringify(storeURL)+
  ';await restoreBackup(process.argv[1],process.argv[2],{offline:true,'+expr+'});';
 return spawnSync(process.execPath,['--input-type=module','-e',js,f.backup,f.file],
  {encoding:'utf8',env:{...process.env},timeout:15000});
}
test('R8 durable journal: marker previo al primer rename solo se elimina, no toca la DB',async()=>{
 const f=await restoreFixture();try{
  const n=f.events();
  const killed=await killRestore(f,'before');
  assert.equal(killed.signal,'SIGKILL',killed.stderr);
  const status=await storageStatus(f.file);
  assert.equal(status.backend,'RESTORE_PENDING');
  assert.ok(status.restoreArtifacts.journal.length);
  const aborted=await storageRestoreAbort(f.file);
  assert.equal(aborted.noMoves,true);
  assert.equal(f.events(),n);
  assert.equal((await authorizationStatus(f.file)).valid,false);
 }finally{await f.close();}
});
test('R8 durable journal: crash tras instalación de candidato se revierte sin grants nuevos',async()=>{
 const f=await restoreFixture();try{
  const n=f.events(),killed=await killRestore(f,2);
  assert.equal(killed.signal,'SIGKILL',killed.stderr);
  const outcome=await storageRestoreAbort(f.file);
  assert.equal(outcome.aborted,true);
  assert.equal((await authorizationStatus(f.file)).valid,false);
  assert.equal(f.events(),n);
 }finally{await f.close();}
});
test('R8 journal: JSON inválido y movimiento ajeno no son autoridad de rename',async()=>{
 const f=await restoreFixture();try{
  const marker=databasePath(f.file)+'.restore-pending';
  await writeFile(marker,'not JSON');
  await assert.rejects(storageRestoreAbort(f.file),{code:'INVALID_JOURNAL'});
  await writeFile(marker,JSON.stringify({version:1,id:'00000000-0000-4000-8000-000000000001',
    path:databasePath(f.file),temp:databasePath(f.file)+'.restoring.tmp',
    quarantine:databasePath(f.file)+'.quarantine.00000000-0000-4000-8000-000000000001',
    phase:'restoring',restoreOps:[{from:'/etc/passwd',to:'/tmp/x',state:'intent'}]}));
  await assert.rejects(storageRestoreAbort(f.file),{code:'INVALID_JOURNAL'});
  await rm(marker);
  assert.equal((await authorizationStatus(f.file)).valid,false);
 }finally{await f.close();}
});
test('R8 journal: artefactos huérfanos solo se limpian mediante CLI confirmada',async()=>{
 const f=await restoreFixture();try{
  const base=databasePath(f.file),id='22222222-2222-4222-8222-222222222222';
  const temp=base+'.restoring.'+id,aborted=base+'.aborted.'+id,q=base+'.quarantine.'+id;
  await writeFile(temp,'temporary');await writeFile(aborted,'aborted');await writeFile(q,'quarantine');
  const artifacts=await classifyRestoreArtifacts(base);
  assert.ok(artifacts.restoring.includes(temp));assert.ok(artifacts.aborted.includes(aborted));
  assert.ok(artifacts.quarantines.includes(q));
  await assert.rejects(storageCleanupArtifacts(f.file),{code:'CONFIRM_REQUIRED'});
  const done=await storageCleanupArtifacts(f.file,{confirm:true});
  assert.equal(done.cleaned.length,2);
  await assert.rejects(stat(temp),{code:'ENOENT'});
  await assert.rejects(stat(aborted),{code:'ENOENT'});
  assert.equal((await readFile(q,'utf8')),'quarantine');
  assert.equal((await authorizationStatus(f.file)).valid,false);
 }finally{await f.close();}
});
test('R8 journal: no abrir un restore con artefactos sin diario y DB ausente',async()=>{
 const f=await restoreFixture();try{
  const base=databasePath(f.file);
  await rm(base,{force:true});
  await writeFile(base+'.quarantine.33333333-3333-4333-8333-333333333333','unowned');
  await assert.rejects(restoreBackup(f.backup,f.file,{offline:true,forceDataLoss:true}),
    {code:'UNOWNED_ARTIFACTS'});
 }finally{await f.close();}
});
