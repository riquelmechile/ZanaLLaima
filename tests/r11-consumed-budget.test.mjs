import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,copyFile,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createMission,startBatch} from '../src/core.mjs';
import {expireUnits,retryRead,cancelMission} from '../src/lifecycle.mjs';
import {transact,readState,backupState,restoreBackup,storageAdoptQuarantine,databasePath,archiveMission} from '../src/store.mjs';

async function budgetFixture(){
  const dir=await mkdtemp(join(tmpdir(),'r11-budget-'));
  const file=join(dir,'state.json'),backup=join(dir,'backup.sqlite');
  const saved={ZANA_STATE_FILE:process.env.ZANA_STATE_FILE,ZANA_RESTORE_OFFLINE:process.env.ZANA_RESTORE_OFFLINE};
  process.env.ZANA_STATE_FILE=file;process.env.ZANA_RESTORE_OFFLINE='1';
  await transact(()=>createMission({
    objective:'Presupuesto monótono a través de restore',
    authorization:{writesAllowed:false,allowedPaths:[]},
    budget:{maxUnitAttempts:1,maxWorkStarts:1},
    units:[{id:'scan',effect:'READ',paths:['src'],instruction:'Leer el código fuente'}],
  }),file);
  return {dir,file,backup,close:async()=>{
    for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
    await rm(dir,{recursive:true,force:true});
  }};
}
const start=file=>transact(m=>{startBatch(m);return m;},file);
const expire=file=>transact(m=>{expireUnits(m,Date.now()+3600_000);return m;},file);
const retry=file=>transact(m=>{retryRead(m,'scan');return m;},file);
const unit=async file=>(await readState(file)).units.find(u=>u.id==='scan');

test('R11-C1: restore sin forceDataLoss rechaza con CONSUMED_BUDGET el reinicio de intentos',async()=>{
  const f=await budgetFixture();
  try{
    await backupState(f.backup,f.file);
    await start(f.file);
    await expire(f.file);
    await assert.rejects(start(f.file),/work-start budget exhausted/);
    await assert.rejects(retry(f.file),/Retry limit reached/);
    await assert.rejects(restoreBackup(f.backup,f.file,{offline:true}),
      err=>err.code==='CONSUMED_BUDGET','El restore no debe reiniciar intentos consumidos');
    assert.equal((await unit(f.file)).attempts,1,'La DB viva debe quedar intacta tras el rechazo');
    await assert.rejects(start(f.file),/work-start budget exhausted/);
  }finally{await f.close();}
});

test('R11-C1: una unidad RUNNING viva bloquea el restore sin forceDataLoss',async()=>{
  const f=await budgetFixture();
  try{
    await backupState(f.backup,f.file);
    await start(f.file);
    await assert.rejects(restoreBackup(f.backup,f.file,{offline:true}),err=>err.code==='CONSUMED_BUDGET');
  }finally{await f.close();}
});

test('R11-C1: con forceDataLoss se fusiona max(live,backup) y el start posterior sigue rechazado',async()=>{
  const f=await budgetFixture();
  try{
    await backupState(f.backup,f.file);
    await start(f.file);
    await expire(f.file);
    const liveGeneration=(await unit(f.file)).run.leaseGeneration;
    const liveRevision=(await readState(f.file)).revision;
    await restoreBackup(f.backup,f.file,{offline:true,forceDataLoss:true});
    const after=await unit(f.file);
    assert.equal(after.attempts,1,'attempts debe ser max(live,backup)');
    assert.ok((after.run?.leaseGeneration??0)>=liveGeneration,'leaseGeneration no puede retroceder');
    assert.ok((await readState(f.file)).revision>liveRevision,'revision no puede retroceder');
    await assert.rejects(start(f.file),/work-start budget exhausted/,'Presupuesto agotado debe seguir agotado');
    assert.equal(after.status,'PENDING','tras force la unidad queda PENDING, sin start nuevo posible');
  }finally{await f.close();}
});

test('R11-C1: un restore legítimo sin consumo posterior al backup sigue funcionando',async()=>{
  const f=await budgetFixture();
  try{
    await backupState(f.backup,f.file);
    const result=await restoreBackup(f.backup,f.file,{offline:true});
    assert.equal(result.restored,true);
    assert.equal((await unit(f.file)).attempts,0);
    await start(f.file);
    assert.equal((await unit(f.file)).attempts,1);
  }finally{await f.close();}
});

test('R11-C1: adoptar una cuarentena con menos intentos conserva el máximo de todas',async()=>{
  const f=await budgetFixture();
  try{
    const base=databasePath(f.file),oldId=randomUUID(),newId=randomUUID();
    await backupState(f.backup,f.file);
    await start(f.file);
    await expire(f.file);
    const live=new DatabaseSync(base);
    try{live.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{live.close();}
    await copyFile(f.backup,base+'.quarantine.'+oldId);
    await rename(base,base+'.quarantine.'+newId);
    for(const s of ['-wal','-shm'])await rm(base+s,{force:true});
    await storageAdoptQuarantine(oldId,f.file,{confirm:true});
    assert.equal((await unit(f.file)).attempts,1,'El adopt no puede revivir intentos consumidos');
    await assert.rejects(start(f.file),/work-start budget exhausted/);
  }finally{await f.close();}
});

test('R11-C1b: pasar por una misión intermedia (A→B→A) no reinicia el presupuesto de A',async()=>{
  const f=await budgetFixture();
  try{
    const backupB=join(f.dir,'backup-b.sqlite');
    await backupState(f.backup,f.file);
    await start(f.file);
    await expire(f.file);
    // Otra misión B en un estado separado, respaldada para el restore intermedio.
    const otherFile=join(f.dir,'other.json');
    await transact(()=>createMission({
      objective:'Misión intermedia sin relación',
      authorization:{writesAllowed:false,allowedPaths:[]},
      units:[{id:'other',effect:'READ',paths:['docs'],instruction:'Leer la documentación'}],
    }),otherFile);
    await backupState(backupB,otherFile);
    process.env.ZANA_STATE_FILE=f.file;
    await restoreBackup(backupB,f.file,{offline:true});
    await assert.rejects(restoreBackup(f.backup,f.file,{offline:true}),
      err=>err.code==='CONSUMED_BUDGET','Volver al backup viejo de A no puede devolver intentos consumidos');
    await restoreBackup(f.backup,f.file,{offline:true,forceDataLoss:true});
    assert.equal((await unit(f.file)).attempts,1,'Con force se conserva el consumo de A registrado en el ledger');
    await assert.rejects(start(f.file),/work-start budget exhausted/);
  }finally{await f.close();}
});

test('R11-C1b: archivar la misión y crear otra no borra el consumo que el restore debe respetar',async()=>{
  const f=await budgetFixture();
  try{
    await backupState(f.backup,f.file);
    await start(f.file);
    await expire(f.file);
    await transact(m=>{cancelMission(m);return m;},f.file);
    await archiveMission(f.file);
    await transact(()=>createMission({
      objective:'Misión siguiente tras archivar',
      authorization:{writesAllowed:false,allowedPaths:[]},
      units:[{id:'next',effect:'READ',paths:['docs'],instruction:'Leer la documentación'}],
    }),f.file);
    await assert.rejects(restoreBackup(f.backup,f.file,{offline:true}),err=>err.code==='CONSUMED_BUDGET');
  }finally{await f.close();}
});

test('R11-C1: una leaseGeneration viva mayor con los mismos attempts también bloquea el restore',async()=>{
  const f=await budgetFixture();
  try{
    await start(f.file);
    await expire(f.file);
    await backupState(f.backup,f.file);
    const live=new DatabaseSync(databasePath(f.file));
    try{
      const row=live.prepare("SELECT run FROM units WHERE id='scan'").get();
      const run=JSON.parse(row.run);run.leaseGeneration+=1;
      live.prepare("UPDATE units SET run=? WHERE id='scan'").run(JSON.stringify(run));
    }finally{live.close();}
    await assert.rejects(restoreBackup(f.backup,f.file,{offline:true}),err=>err.code==='CONSUMED_BUDGET');
  }finally{await f.close();}
});

test('R11-C1c: adoptar con una cuarentena hermana ilegible exige --force-data-loss y la reporta',async()=>{
  const f=await budgetFixture();
  try{
    const base=databasePath(f.file),oldId=randomUUID(),newId=randomUUID();
    await backupState(f.backup,f.file);
    await start(f.file);
    await expire(f.file);
    const live=new DatabaseSync(base);
    try{live.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{live.close();}
    await copyFile(f.backup,base+'.quarantine.'+oldId);
    await rename(base,base+'.quarantine.'+newId);
    for(const s of ['-wal','-shm'])await rm(base+s,{force:true});
    await writeFile(base+'.quarantine.'+newId,'esto ya no es una base SQLite');
    await assert.rejects(storageAdoptQuarantine(oldId,f.file,{confirm:true}),
      err=>err.code==='UNREADABLE_SOURCE','Una fuente ilegible puede esconder presupuesto consumido');
    const adopted=await storageAdoptQuarantine(oldId,f.file,{confirm:true,forceDataLoss:true});
    assert.equal(adopted.adopted,true);
    assert.deepEqual(adopted.skippedSources.map(x=>x.reason),['UNREADABLE']);
    const db=new DatabaseSync(base,{readOnly:true});
    try{
      const detail=JSON.parse(db.prepare("SELECT detail FROM state_events WHERE category='QUARANTINE_ADOPTED'").get().detail);
      assert.equal(detail.skippedSources.length,1,'el evento debe registrar la fuente omitida');
    }finally{db.close();}
  }finally{await f.close();}
});

test('R11-C1d: un ledger manipulado con __proto__ no contamina Object.prototype y se rechaza',async()=>{
  const f=await budgetFixture();
  try{
    await backupState(f.backup,f.file);
    const crafted=new DatabaseSync(f.backup);
    try{
      crafted.prepare("INSERT INTO metadata(key,value) VALUES('consumed_budget',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run('{"__proto__":{"polluted":{"attempts":9,"leaseGeneration":0}}}');
    }finally{crafted.close();}
    await assert.rejects(restoreBackup(f.backup,f.file,{offline:true}),err=>err.code==='INVALID_LEDGER');
    assert.equal(({}).polluted,undefined,'Object.prototype contaminado por el ledger');
  }finally{delete Object.prototype.polluted;await f.close();}
});
