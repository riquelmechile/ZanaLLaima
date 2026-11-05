import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMission} from '../src/core.mjs';
import {transact,storageRestoreAbort,restoreBackup,backupState,
  databasePath,storageStatus} from '../src/store.mjs';
const setup=async()=>{
 const dir=await mkdtemp(join(tmpdir(),'zana-r9-journal-'));
 const file=join(dir,'state.json'),backup=join(dir,'backup.sqlite');
 await transact(()=>createMission({objective:'Recuperar diario vacío tras SIGKILL o ENOSPC',
  authorization:{writesAllowed:false,allowedPaths:[]},
  units:[{id:'read',effect:'READ',instruction:'Examinar estado'}]}),file);
 await backupState(backup,file);
 const db=databasePath(file),marker=db+'.restore-pending';
 return {dir,file,db,backup,marker,close:()=>rm(dir,{force:true,recursive:true})};
};
test('R9-C5: marcador vacío por SIGKILL tras open se puede abortar sin intervención manual',async()=>{
 const f=await setup(),old=process.env.ZANA_RESTORE_OFFLINE;
 try{
  process.env.ZANA_RESTORE_OFFLINE='1';
  const before=await readFile(f.db);
  await writeFile(f.marker,''); // estado reproducible de kill después de open(...,wx)
  const result=await storageRestoreAbort(f.file);
  assert.equal(result.aborted,true);
  assert.deepEqual(await readFile(f.db),before);
  assert.equal((await storageStatus(f.file)).integrity,'ok');
 }finally{if(old===undefined)delete process.env.ZANA_RESTORE_OFFLINE;
  else process.env.ZANA_RESTORE_OFFLINE=old;await f.close();}
});
test('R9-C5: marcador JSON truncado con DB intacta permite reintentar restore',async()=>{
 const f=await setup(),old=process.env.ZANA_RESTORE_OFFLINE;
 try{
  process.env.ZANA_RESTORE_OFFLINE='1';
  await writeFile(f.marker,'{"version":1'); // interrupción/ENOSPC durante primera escritura
  const result=await restoreBackup(f.backup,f.file,{offline:true});
  assert.equal(result.restored,true);
  assert.equal((await storageStatus(f.file)).integrity,'ok');
 }finally{if(old===undefined)delete process.env.ZANA_RESTORE_OFFLINE;
  else process.env.ZANA_RESTORE_OFFLINE=old;await f.close();}
});
test('R9-C5: create del diario publica por link exclusivo tras fsync del temporal',()=>{
 const src=readFileSync(new URL('../src/restore-journal.mjs',import.meta.url),'utf8');
 assert.match(src,/link\(tmp,\s*marker\)/,'Publicación exclusiva faltante');
 assert.doesNotMatch(src,/open\(marker,\s*'wx'/,'Marcador nunca se crea vacío');
});
