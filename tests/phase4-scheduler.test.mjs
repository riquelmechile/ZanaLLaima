import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMission,nextBatch,startBatch,completeUnit,publicStatus} from '../src/core.mjs';
import {heartbeatUnit,retryRead,reconcileWrite} from '../src/lifecycle.mjs';
import {openReview,startReviewBatch,submitReview} from '../src/review.mjs';
import {readState,transact,storageStatus} from '../src/store.mjs';

const host={model:'gpt-6-astra',reasoningEffort:'max',
  nativeSubagents:{available:true,maxConcurrent:4}};
const evidence={success:true,summary:'Inspected real unit output in test fixture',
  evidence:['Checked state and expected token']};
const readMission=(count=6,budget={})=>createMission({
  objective:'Test an incremental and resource-bounded scheduler',
  authorization:{writesAllowed:false,allowedPaths:[]},budget,
  units:Array.from({length:count},(_,i)=>({
    id:'r'+i,effect:'READ',instruction:'Inspect independent source '+i,
  })),
});
const grant={valid:true,paths:['docs'],
  expiresAt:new Date(Date.now()+600000).toISOString()};

test('read-only slots refill incrementally while prior tokens remain active',()=>{
  const m=readMission(7);
  const first=startBatch(m,host).batch;
  assert.deepEqual(first.packets.map(x=>x.unitId),['r0','r1','r2','r3']);
  assert.equal(nextBatch(m,host).mode,'WAITING');
  completeUnit(m,'r0',first.packets[0].token,evidence,first.packets[0].leaseGeneration);
  const refill=nextBatch(m,host);
  assert.equal(refill.mode,'PARALLEL_PLAN');
  assert.equal(refill.runningReads,3);
  assert.deepEqual(refill.units.map(x=>x.id),['r4']);
  const second=startBatch(m,host).batch.packets[0];
  assert.equal(second.unitId,'r4');
  assert.equal(m.units.filter(x=>x.status==='RUNNING').length,4);
  assert.equal(m.units.filter(x=>x.status==='DONE').length,1);
  assert.equal(second.hostEvidence.capabilityEvidence,'HOST_REPORTED_UNVERIFIED');
  assert.throws(()=>completeUnit(m,'r0',first.packets[0].token,evidence),/stale/);
});

test('runtime capacity reduction and mission budget never overbook active readers',()=>{
  const m=readMission(6,{maxActiveReads:2});
  const a=startBatch(m,host).batch;
  assert.equal(a.packets.length,2);
  assert.equal(nextBatch(m,host).mode,'WAITING');
  completeUnit(m,a.packets[0].unitId,a.packets[0].token,evidence);
  assert.equal(nextBatch(m,{nativeSubagents:{available:false}}).mode,'WAITING');
  const refill=startBatch(m,host).batch.packets;
  assert.equal(refill.length,1);
  assert.equal(m.units.filter(x=>x.status==='RUNNING').length,2);
  assert.equal(publicStatus(m).budget.limits.maxActiveReads,2);
});

test('pending signed WRITE drains readers; no parallel writers even with disjoint paths',()=>{
  const m=createMission({objective:'Test isolation and writer fairness',
    authorization:{writesAllowed:true,allowedPaths:['docs']},
    units:[
      {id:'a',effect:'READ',instruction:'Inspect a'},
      {id:'b',effect:'READ',instruction:'Inspect b'},
      {id:'c',effect:'READ',instruction:'Inspect c'},
      {id:'write1',effect:'WRITE',instruction:'Write first',paths:['docs/first']},
      {id:'write2',effect:'WRITE',instruction:'Write second',paths:['docs/second']},
    ]});
  const reads=startBatch(m,host,null).batch.packets;
  assert.equal(reads.length,3);
  const wait=nextBatch(m,host,grant);
  assert.equal(wait.mode,'WAITING');
  assert.match(wait.reason,/Drain/);
  for(const p of reads)completeUnit(m,p.unitId,p.token,evidence,p.leaseGeneration);
  const write=startBatch(m,host,grant).batch.packets;
  assert.equal(write.length,1);
  assert.equal(write[0].unitId,'write1');
  assert.equal(nextBatch(m,host,grant).mode,'WAITING');
  const bad=structuredClone(m);
  bad.units.find(x=>x.id==='write2').status='RUNNING';
  assert.equal(nextBatch(bad,host,grant).mode,'BLOCKED');
  assert.match(nextBatch(bad,host,grant).reason,/Concurrent writer/);
  completeUnit(m,write[0].unitId,write[0].token,evidence,
    write[0].leaseGeneration,grant);
  assert.deepEqual(startBatch(m,host,grant).batch.packets.map(x=>x.unitId),['write2']);
});

test('mission attempts, runtime, lease and UTF-8 result budgets fail closed',()=>{
  assert.throws(()=>readMission(1,{maxActiveReads:5}),/budget/);
  assert.throws(()=>readMission(1,{maxResultBytes:128}),/budget/);
  assert.throws(()=>readMission(3,{maxWorkStarts:2}),/budget/);
  assert.throws(()=>readMission(1,{unexpectedOption:true}),/unknown limit/);

  const m=readMission(1,{maxUnitAttempts:1,maxWorkStarts:1,
    maxLeaseSeconds:10,maxResultBytes:1024});
  assert.throws(()=>startBatch(m,host,null,11),/Lease exceeds/);
  const p=startBatch(m,host).batch.packets[0];
  assert.throws(()=>heartbeatUnit(m,{unitId:'r0',token:p.token,
    leaseGeneration:p.leaseGeneration,leaseSeconds:15}),/lease budget/);
  assert.throws(()=>completeUnit(m,'r0',p.token,{
    success:true,summary:'x'.repeat(3000),evidence:['real test evidence'],
  }),/budget/);
  assert.throws(()=>completeUnit(m,'r0',p.token,{
    success:true,summary:'Verified result ✅'.repeat(100),
    evidence:['UTF-8 bytes matter'].concat(Array.from({length:10},()=>('漢'.repeat(150)))),
  }),/budget|bounded evidence/);
  completeUnit(m,'r0',p.token,{...evidence,success:false});
  assert.throws(()=>retryRead(m,'r0'),/Retry limit/);
  m.budget.deadlineAt=new Date(Date.now()-1000).toISOString();
  assert.equal(nextBatch(m,host).mode,'BLOCKED');
});

test('review budgets cap evidence bytes and correction rounds',()=>{
  const m=readMission(1,{maxReviewRounds:1,maxResultBytes:1024});
  const p=startBatch(m).batch.packets[0];
  completeUnit(m,p.unitId,p.token,evidence);
  const git=n=>({assurance:'LOCAL_GIT_OBSERVED',repoRoot:'/tmp/fake',
    candidateSha:n.toString(16).padStart(40,'0'),treeSha:(n+20).toString(16).padStart(40,'0'),
    baseSha:'a'.repeat(40),branchRef:'refs/heads/feature',
    targetRef:'refs/heads/main',clean:true,observedAt:new Date().toISOString()});
  const first=git(1);
  openReview(m,{candidateSha:first.candidateSha,gitEvidence:first});
  const packet=startReviewBatch(m).packets[0];
  assert.throws(()=>submitReview(m,{lensId:packet.lensId,token:packet.token,
    candidateSha:packet.candidateSha,verdict:'PASS',
    summary:'長'.repeat(1000),evidence:['inspected code'],
    execution:'SELF_CONTEXT'}),/budget/);
  m.review.state='INVALIDATED';
  assert.throws(()=>openReview(m,{candidateSha:git(2).candidateSha,gitEvidence:git(2)}),
    /correction limit/);
});

test('mission budgets and consumed slots persist exactly across a SQLite restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zana-phase4-budget-'));
  const file=join(dir,'state.json');
  try{
    await transact(()=>readMission(4,{maxActiveReads:2,maxWorkStarts:5,
      maxUnitAttempts:2,maxResultBytes:2048}),file);
    let first;
    await transact(m=>{first=startBatch(m,host).batch.packets;return m;},file);
    const reloaded=await readState(file);
    assert.equal(reloaded.budget.maxActiveReads,2);
    assert.equal(reloaded.budget.maxWorkStarts,5);
    assert.equal(reloaded.units.filter(x=>x.status==='RUNNING').length,2);
    assert.equal(reloaded.units.reduce((sum,x)=>sum+x.attempts,0),2);
    await transact(m=>{completeUnit(m,first[0].unitId,first[0].token,evidence);return m;},file);
    let second;
    await transact(m=>{second=startBatch(m,host).batch.packets;return m;},file);
    assert.equal(second.length,1);
    assert.equal((await storageStatus(file)).schemaVersion,4);
    assert.equal((await readState(file)).units.filter(x=>x.status==='RUNNING').length,2);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('terminal reconciliation records a failed uncertain WRITE after retry budget exhaustion',()=>{
  const m=createMission({objective:'Prove uncertain writer cannot reappear after budget exhaustion',
    authorization:{writesAllowed:true,allowedPaths:['docs']},
    budget:{maxUnitAttempts:1,maxWorkStarts:1},
    units:[{id:'write',effect:'WRITE',paths:['docs/a'],instruction:'Update a carefully scoped file'}]});
  const p=startBatch(m,host,grant).batch.packets[0];
  completeUnit(m,'write',p.token,{...evidence,success:false},p.leaseGeneration,grant);
  const status=reconcileWrite(m,{unitId:'write',token:p.token,
    leaseGeneration:p.leaseGeneration,decision:'CONFIRMED_NO_EFFECT',
    evidence:['Operator inspected the exact file state and confirmed no change']});
  assert.equal(m.units[0].status,'FAILED');
  assert.equal(m.units[0].result.assurance,'OPERATOR_ATTESTED');
  assert.equal(nextBatch(m,host,grant).mode,'BLOCKED');
  assert.equal(status.uncertain,0);
});
