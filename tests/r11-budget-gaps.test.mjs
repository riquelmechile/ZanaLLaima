import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,copyFile,rename,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {createMission,startBatch} from '../src/core.mjs';
import {expireUnits} from '../src/lifecycle.mjs';
import {parseCliCommand} from '../src/cli.mjs';
import {transact,readState,backupState,restoreBackup,storageAdoptQuarantine,databasePath} from '../src/store.mjs';

const run=promisify(execFile);
const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));

async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'r11-gaps-'));
  const file=join(dir,'state.json'),backup=join(dir,'backup.sqlite');
  const saved={ZANA_STATE_FILE:process.env.ZANA_STATE_FILE,ZANA_RESTORE_OFFLINE:process.env.ZANA_RESTORE_OFFLINE};
  process.env.ZANA_STATE_FILE=file;process.env.ZANA_RESTORE_OFFLINE='1';
  const mission=objective=>createMission({objective,
    authorization:{writesAllowed:false,allowedPaths:[]},
    budget:{maxUnitAttempts:1,maxWorkStarts:1},
    units:[{id:'scan',effect:'READ',paths:['src'],instruction:'Leer el código fuente'}]});
  await transact(()=>mission('Brechas de cobertura del presupuesto R11'),file);
  return {dir,file,backup,mission,close:async()=>{
    for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
    await rm(dir,{recursive:true,force:true});
  }};
}
const start=file=>transact(m=>{startBatch(m);return m;},file);
const expire=file=>transact(m=>{expireUnits(m,Date.now()+3600_000);return m;},file);
const checkpoint=path=>{const db=new DatabaseSync(path);try{db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{db.close();}};

test('R11 N1: un restore ciego fusiona el consumo de una copia .aborted legible',async()=>{
  const f=await fixture();
  try{
    const base=databasePath(f.file);
    await backupState(f.backup,f.file);
    await start(f.file);
    await expire(f.file);
    checkpoint(base);
    await rename(base,base+'.aborted.'+randomUUID());
    for(const s of ['-wal','-shm'])await rm(base+s,{force:true});
    await assert.rejects(restoreBackup(f.backup,f.file,{offline:true}),err=>err.code==='BLIND_RESTORE');
    const result=await restoreBackup(f.backup,f.file,{offline:true,forceDataLoss:true});
    assert.equal(result.blind,true);
    assert.deepEqual(result.skippedSources,[]);
    assert.equal((await readState(f.file)).units[0].attempts,1,'el consumo de la copia .aborted no puede perderse');
    await assert.rejects(start(f.file),/work-start budget exhausted/);
  }finally{await f.close();}
});

test('R11 N2: una unidad RUNNING viva bloquea incluso restaurar un backup de otra misión',async()=>{
  const f=await fixture();
  try{
    const other=join(f.dir,'other.json'),otherBackup=join(f.dir,'other-backup.sqlite');
    await transact(()=>f.mission('Otra misión para el backup'),other);
    await backupState(otherBackup,other);
    process.env.ZANA_STATE_FILE=f.file;
    await start(f.file);
    await assert.rejects(restoreBackup(otherBackup,f.file,{offline:true}),
      err=>err.code==='CONSUMED_BUDGET'&&/RUNNING/.test(err.message));
  }finally{await f.close();}
});

test('R11 N5: adopt con una hermana que no es archivo regular la reporta como NOT_REGULAR',async()=>{
  const f=await fixture();
  try{
    const base=databasePath(f.file),id=randomUUID();
    await backupState(f.backup,f.file);
    checkpoint(base);
    await rename(base,base+'.quarantine.'+id);
    for(const s of ['-wal','-shm'])await rm(base+s,{force:true});
    await mkdir(base+'.aborted.'+randomUUID());
    await assert.rejects(storageAdoptQuarantine(id,f.file,{confirm:true}),err=>err.code==='UNREADABLE_SOURCE');
    const adopted=await storageAdoptQuarantine(id,f.file,{confirm:true,forceDataLoss:true});
    assert.deepEqual(adopted.skippedSources.map(x=>x.reason),['NOT_REGULAR']);
  }finally{await f.close();}
});

test('R11 N5: la CLI lee --force-data-loss del adopt y rechaza flags desconocidos',async()=>{
  const deps={json:async()=>({}),text:async()=>''};
  const id=randomUUID();
  assert.deepEqual((await parseCliCommand('storage-adopt-quarantine',[id,'--confirm'],deps)).input,
    {id,confirm:true,forceDataLoss:false});
  assert.deepEqual((await parseCliCommand('storage-adopt-quarantine',[id,'--confirm','--force-data-loss'],deps)).input,
    {id,confirm:true,forceDataLoss:true});
  await assert.rejects(parseCliCommand('storage-adopt-quarantine',[id,'--confirm','--yolo'],deps),/--force-data-loss/);
  await assert.rejects(parseCliCommand('storage-adopt-quarantine',[id,'--force-data-loss','--confirm'],deps),/--confirm/);
});

test('R11 N5: la CLI imprime el código del error antes del mensaje',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'r11-cli-'));
  try{
    await writeFile(join(dir,'.keep'),'');
    const env={...process.env,ZANA_STATE_FILE:join(dir,'state.json'),ZANA_RESTORE_OFFLINE:'1'};
    const out=await run(process.execPath,[cli,'storage-adopt-quarantine','no-es-uuid','--confirm'],{env})
      .then(()=>null,error=>error);
    assert.ok(out,'el comando debe fallar');
    assert.match(out.stderr,/^Error: \[INVALID_UUID\] /);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('R11: adopt con hermanas legibles no omite fuentes y conserva el máximo',async()=>{
  const f=await fixture();
  try{
    const base=databasePath(f.file),keep=randomUUID(),sibling=randomUUID();
    await backupState(f.backup,f.file);
    await start(f.file);
    await expire(f.file);
    checkpoint(base);
    await copyFile(f.backup,base+'.quarantine.'+keep);
    await rename(base,base+'.quarantine.'+sibling);
    for(const s of ['-wal','-shm'])await rm(base+s,{force:true});
    const adopted=await storageAdoptQuarantine(keep,f.file,{confirm:true});
    assert.deepEqual(adopted.skippedSources,[]);
    assert.equal((await readState(f.file)).units[0].attempts,1);
  }finally{await f.close();}
});

const corruptArchive=path=>{
  const db=new DatabaseSync(path);
  try{db.prepare("INSERT INTO mission_archive(mission_id,snapshot,archived_at) VALUES('roto','{no es json',?)").run(new Date().toISOString());}
  finally{db.close();}
};

test('R11 final: un backup con un snapshot archivado corrupto se rechaza en restore normal y ciego',async()=>{
  const f=await fixture();
  try{
    await backupState(f.backup,f.file);
    corruptArchive(f.backup);
    await assert.rejects(restoreBackup(f.backup,f.file,{offline:true}),err=>err.code==='INVALID_LEDGER');
    await assert.rejects(restoreBackup(f.backup,f.file,{offline:true,forceDataLoss:true}),err=>err.code==='INVALID_LEDGER');
    const base=databasePath(f.file);
    await rm(base,{force:true});for(const s of ['-wal','-shm'])await rm(base+s,{force:true});
    await assert.rejects(restoreBackup(f.backup,f.file,{offline:true,forceDataLoss:true}),
      err=>err.code==='INVALID_LEDGER','el restore ciego tampoco publica un backup corrupto');
  }finally{await f.close();}
});

test('R11 final: adopt con --force-data-loss repara un snapshot archivado corrupto y deja la base restaurable',async()=>{
  const f=await fixture();
  try{
    const base=databasePath(f.file),id=randomUUID();
    await backupState(f.backup,f.file);
    checkpoint(base);
    corruptArchive(base);
    await rename(base,base+'.quarantine.'+id);
    for(const s of ['-wal','-shm'])await rm(base+s,{force:true});
    await assert.rejects(storageAdoptQuarantine(id,f.file,{confirm:true}),err=>err.code==='INVALID_LEDGER');
    const adopted=await storageAdoptQuarantine(id,f.file,{confirm:true,forceDataLoss:true});
    assert.equal(adopted.ledgerRebuilt,true);
    const result=await restoreBackup(f.backup,f.file,{offline:true});
    assert.equal(result.restored,true,'tras reparar, un restore normal no debe exigir force');
  }finally{await f.close();}
});

test('R11 final: una misión legacy con id no UUID sigue siendo restaurable',async()=>{
  const f=await fixture();
  try{
    const base=databasePath(f.file);
    await backupState(f.backup,f.file);
    for(const path of [base,f.backup]){
      const db=new DatabaseSync(path);
      try{db.exec("UPDATE units SET mission_id='legacy-mission-1'");db.exec("UPDATE active_mission SET id='legacy-mission-1'");}
      finally{db.close();}
    }
    const result=await restoreBackup(f.backup,f.file,{offline:true});
    assert.equal(result.restored,true);
  }finally{await f.close();}
});

test('R11 final: adopt rechaza forceDataLoss no booleano y etiqueta una hermana con ledger inválido',async()=>{
  const f=await fixture();
  try{
    const base=databasePath(f.file),id=randomUUID(),sibling=base+'.aborted.'+randomUUID();
    await backupState(f.backup,f.file);
    checkpoint(base);
    await copyFile(f.backup,sibling);
    const db=new DatabaseSync(sibling);
    try{db.prepare("INSERT INTO metadata(key,value) VALUES('consumed_budget','[1]')").run();}finally{db.close();}
    await rename(base,base+'.quarantine.'+id);
    for(const s of ['-wal','-shm'])await rm(base+s,{force:true});
    await assert.rejects(storageAdoptQuarantine(id,f.file,{confirm:true,forceDataLoss:'yes'}),err=>err.code==='INVALID_FORCE');
    const adopted=await storageAdoptQuarantine(id,f.file,{confirm:true,forceDataLoss:true});
    assert.deepEqual(adopted.skippedSources.map(x=>x.reason),['INVALID_LEDGER']);
  }finally{await f.close();}
});

test('R11 final: contadores dañados en la misión activa viva no bloquean la recuperación con --force-data-loss',async()=>{
  const f=await fixture();
  try{
    await backupState(f.backup,f.file);
    const live=new DatabaseSync(databasePath(f.file));
    try{live.exec("UPDATE units SET attempts=-1");}finally{live.close();}
    await assert.rejects(restoreBackup(f.backup,f.file,{offline:true}),err=>err.code==='INVALID_LEDGER');
    const result=await restoreBackup(f.backup,f.file,{offline:true,forceDataLoss:true});
    assert.equal(result.restored,true);
    assert.equal(result.ledgerRebuilt,true);
  }finally{await f.close();}
});

test('R11 Codex P1: el restore ciego aplica el ledger propio del backup aunque registre más que sus unidades',async()=>{
  const f=await fixture();
  try{
    const missionId=(await readState(f.file)).id;
    await backupState(f.backup,f.file);
    const b=new DatabaseSync(f.backup);
    try{b.prepare("INSERT INTO metadata(key,value) VALUES('consumed_budget',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify({[missionId]:{scan:{attempts:1,leaseGeneration:1}}}));}finally{b.close();}
    const base=databasePath(f.file);
    await rm(base,{force:true});for(const s of ['-wal','-shm'])await rm(base+s,{force:true});
    const result=await restoreBackup(f.backup,f.file,{offline:true,forceDataLoss:true});
    assert.equal(result.blind,true);
    assert.equal((await readState(f.file)).units[0].attempts,1,'el consumo que el propio backup registra no puede perderse');
    await assert.rejects(start(f.file),/work-start budget exhausted/);
  }finally{await f.close();}
});
