#!/usr/bin/env node
import {performance} from 'node:perf_hooks';
import {stat,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createMission,nextBatch,startBatch,completeUnit} from '../src/core.mjs';
import {expireUnits} from '../src/lifecycle.mjs';
import {databasePath,readState,readHistory,storageStatus,transact} from '../src/store.mjs';

const durations=[150,4,4,4,150,4,4,4,150,4,4,4];
export function logicalMakespan(times=durations,parallel=4,incremental=false){
  if(!Array.isArray(times)||!times.length||times.some(x=>!Number.isFinite(x)||x<=0)||
     !Number.isInteger(parallel)||parallel<1)throw Error('Invalid benchmark inputs');
  let time=0,queue=0,running=[];
  const refill=()=>{
    while(queue<times.length&&running.length<parallel){
      running.push(time+times[queue++]);
    }
  };
  refill();
  while(running.length){
    running.sort((a,b)=>a-b);
    const next=running[0];
    time=next;
    running=running.filter(finish=>finish>next);
    if(incremental||running.length===0)refill();
  }
  return time;
}
const percent=(values,p)=>{
  if(!values.length)return 0;
  const sorted=[...values].sort((a,b)=>a-b);
  return Number(sorted[Math.min(sorted.length-1,Math.ceil(values.length*p)-1)].toFixed(3));
};
const timed=async(fn,store)=>{
  const t=performance.now();
  const result=await fn();
  store.push(performance.now()-t);
  return result;
};
const safeStat=async(path)=>{try{return (await stat(path)).size;}catch(error){
  if(error.code==='ENOENT')return 0;throw error;
}};
export async function runBenchmark({units=32,reads=20}={}){
  if(!Number.isInteger(units)||units<8||units>100||
     !Number.isInteger(reads)||reads<1||reads>500)throw Error('Invalid benchmark workload');
  const dir=await mkdtemp(join(tmpdir(),'zana-phase4-bench-'));
  const file=join(dir,'state.json');
  const host={model:'gpt-6-astra',reasoningEffort:'max',
    nativeSubagents:{available:true,maxConcurrent:4}};
  const samples={write:[],read:[],history:[],recovery:[]};
  const start=performance.now();
  try{
    await timed(()=>transact(()=>createMission({
      objective:'Measure isolated incremental READ throughput, not model execution',
      authorization:{writesAllowed:false,allowedPaths:[]},
      units:Array.from({length:units},(_,i)=>({
        id:'task-'+i,effect:'READ',instruction:'Inspect independent fixture '+i,
      })),
    }),file),samples.write);
    let active=[],started=0,completed=0,extraStarts=0;
    const claim=async()=>{
      let batch;
      await timed(()=>transact(m=>{
        batch=startBatch(m,host).batch;
        return m;
      },file),samples.write);
      active.push(...batch.packets);
      started+=batch.packets.length;
      if(completed>0)extraStarts+=batch.packets.length;
    };
    await claim();
    while(active.length){
      const p=active.shift();
      await timed(()=>transact(m=>completeUnit(m,p.unitId,p.token,{
        success:true,
        summary:'Measured a real SQLite transaction and token check',
        evidence:['Local benchmark fixture only, not a model worker'],
      },p.leaseGeneration),file),samples.write);
      completed++;
      if(started<units){
        const state=await timed(()=>readState(file),samples.read);
        if(nextBatch(state,host).units.length)await claim();
      }
    }
    for(let i=0;i<reads;i++){
      await timed(()=>readState(file),samples.read);
      await timed(()=>readHistory({limit:25},file),samples.history);
    }
    // Recovery measurement is performed in a distinct database and never
    // retries a synthetic WRITE. No file effects are performed by this test.
    const recoverFile=join(dir,'recovery.json');
    await transact(()=>createMission({
      objective:'Measure expired READ reconciliation',
      authorization:{writesAllowed:false,allowedPaths:[]},
      units:[{id:'expired',effect:'READ',instruction:'Inspect an expiring unit'}],
    }),recoverFile);
    await transact(m=>{
      startBatch(m,host);
      m.units[0].run.expiresAt=new Date(Date.now()-1000).toISOString();
      m.revision++;
      return m;
    },recoverFile);
    await timed(()=>transact(m=>{expireUnits(m);return m;},recoverFile),samples.recovery);
    const status=await storageStatus(file);
    const final=await readState(file);
    if(completed!==units||final.units.some(x=>x.status!=='DONE')||
      status.workReceipts!==units||status.integrity!=='ok'||
      extraStarts===0)throw Error('Benchmark lifecycle invariants failed');
    const baseline=logicalMakespan(durations,4,false);
    const incremental=logicalMakespan(durations,4,true);
    if(incremental>=baseline)throw Error('Incremental scheduler provides no logical improvement');
    const db=databasePath(file);
    const dbBytes=await safeStat(db)+await safeStat(db+'-wal');
    const elapsed=performance.now()-start;
    const report={
      assurance:'LOCAL_SYNTHETIC_NOT_HOST_LATENCY',
      workload:{units,reads,actualNativeWorkers:0,parallelPlanLimit:4},
      result:{completed,receiptCount:status.workReceipts,historyEvents:status.events,
        databaseBytes:dbBytes,elapsedMs:Number(elapsed.toFixed(3)),
        operationsPerSecond:Number(((samples.write.length/elapsed)*1000).toFixed(2)),
        incrementalRefills:extraStarts},
      latencyMs:Object.fromEntries(Object.entries(samples).map(([k,v])=>
        [k,{count:v.length,p50:percent(v,0.5),p95:percent(v,0.95)}])),
      deterministicSchedule:{
        durationTicks:durations,
        barrierMakespanTicks:baseline,
        incrementalMakespanTicks:incremental,
        logicalSpeedup:Number((baseline/incremental).toFixed(3)),
      },
      note:'Logical makespan uses deterministic durations, not a measured host speedup; wall-clock SQLite latencies are environment-specific.',
    };
    return report;
  }finally{await rm(dir,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  runBenchmark().then(result=>process.stdout.write(JSON.stringify(result,null,2)+'\n'))
    .catch(error=>{console.error(error);process.exitCode=1;});
}
