import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,copyFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createMission,startBatch} from '../src/core.mjs';
import {expireUnits,retryRead} from '../src/lifecycle.mjs';
import {transact,readState,backupState,restoreBackup,storageAdoptQuarantine,databasePath} from '../src/store.mjs';

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
    await assert.rejects(start(f.file),/No runnable batch|budget/i);
    await assert.rejects(retry(f.file),/Retry limit|budget/i);
    await assert.rejects(restoreBackup(f.backup,f.file,{offline:true}),
      err=>err.code==='CONSUMED_BUDGET','El restore no debe reiniciar intentos consumidos');
    assert.equal((await unit(f.file)).attempts,1,'La DB viva debe quedar intacta tras el rechazo');
    await assert.rejects(start(f.file),/No runnable batch|budget/i);
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
    await assert.rejects(start(f.file),/No runnable batch|budget/i,'Presupuesto agotado debe seguir agotado');
    await assert.rejects(retry(f.file),/Retry limit|budget|Only expired/i);
  }finally{await f.close();}
});

test('R11-C1: un restore legítimo sin consumo posterior al backup sigue funcionando',async()=>{
  const f=await budgetFixture();
  try{
    await backupState(f.backup,f.file);
    const result=await restoreBackup(f.backup,f.file,{offline:true});
    assert.ok(result);
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
    await assert.rejects(start(f.file),/No runnable batch|budget/i);
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
    await assert.rejects(start(f.file),/No runnable batch|budget/i);
  }finally{await f.close();}
});
