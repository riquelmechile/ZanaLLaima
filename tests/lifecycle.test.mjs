import test from 'node:test';
import assert from 'node:assert/strict';
import { createMission,startBatch,completeUnit,nextBatch } from '../src/core.mjs';
import { heartbeatUnit,expireUnits,retryRead,reconcileWrite,cancelMission,closeMission } from '../src/lifecycle.mjs';

const spec=effect=>({objective:'Test lifecycle with durable fencing',
  authorization:{writesAllowed:effect==='WRITE',allowedPaths:effect==='WRITE'?['docs']:[]},
  units:[{id:'first',effect,instruction:'Inspect work or update a safe document',paths:effect==='WRITE'?['docs']:[]}]});
const evidence={success:true,summary:'Tested the expected result safely',
  evidence:['Verified the exact task requirements']};
const grant=()=>({valid:true,expiresAt:new Date(Date.now()+600000).toISOString(),paths:['docs']});

test('read lease expires and can be retried with a new token and generation',()=>{
  const m=createMission(spec('READ'));
  const first=startBatch(m).batch.packets[0];
  m.units[0].run.expiresAt=new Date(Date.now()-1000).toISOString();
  assert.throws(()=>completeUnit(m,'first',first.token,evidence),/expired/);
  assert.deepEqual(expireUnits(m).map(x=>x.status),['EXPIRED']);
  assert.equal(nextBatch(m).mode,'IDLE');
  retryRead(m,'first');
  const second=startBatch(m).batch.packets[0];
  assert.equal(second.leaseGeneration,first.leaseGeneration+1);
  assert.notEqual(second.token,first.token);
  assert.throws(()=>completeUnit(m,'first',first.token,evidence),/stale/);
  completeUnit(m,'first',second.token,evidence,second.leaseGeneration);
  assert.equal(m.units[0].status,'DONE');
  closeMission(m);
  assert.equal(m.status,'CLOSED');
  assert.throws(()=>startBatch(m),/No runnable batch/);
});

test('heartbeat requires an unexpired token and correct generation',()=>{
  const m=createMission(spec('READ'));
  const p=startBatch(m).batch.packets[0];
  assert.throws(()=>heartbeatUnit(m,{unitId:'first',token:p.token,leaseGeneration:3}),/stale/);
  const ack=heartbeatUnit(m,{unitId:'first',token:p.token,
    leaseGeneration:p.leaseGeneration,leaseSeconds:120});
  assert.equal(ack.leaseGeneration,p.leaseGeneration);
  m.units[0].run.expiresAt=new Date(Date.now()-1).toISOString();
  assert.throws(()=>heartbeatUnit(m,{unitId:'first',token:p.token,
    leaseGeneration:p.leaseGeneration}),/expired/);
});

test('unsigned write intent is not an effective permission',()=>{
  const m=createMission(spec('WRITE'));
  assert.equal(nextBatch(m).mode,'BLOCKED');
  assert.throws(()=>startBatch(m),/No runnable batch/);
  const p=startBatch(m,{},grant()).batch.packets[0];
  assert.throws(()=>completeUnit(m,'first',p.token,evidence,p.leaseGeneration),/permission/);
  const failure={...evidence,success:false};
  completeUnit(m,'first',p.token,failure,p.leaseGeneration,grant());
  assert.equal(m.units[0].status,'OUTCOME_UNKNOWN');
  assert.throws(()=>retryRead(m,'first'),/READ/);
  assert.throws(()=>closeMission(m),/complete successfully/);
  reconcileWrite(m,{unitId:'first',token:p.token,leaseGeneration:p.leaseGeneration,
    decision:'CONFIRMED_NO_EFFECT',evidence:['No write appeared after checking the actual workspace']});
  const next=startBatch(m,{},grant()).batch.packets[0];
  assert.equal(next.leaseGeneration,p.leaseGeneration+1);
  assert.throws(()=>completeUnit(m,'first',p.token,evidence,p.leaseGeneration,grant()),/stale/);
});

test('expired and cancelled writes remain uncertain until operator reconciliation',()=>{
  const m=createMission(spec('WRITE'));
  const p=startBatch(m,{},grant()).batch.packets[0];
  m.units[0].run.expiresAt=new Date(Date.now()-1).toISOString();
  expireUnits(m);
  assert.equal(m.units[0].status,'OUTCOME_UNKNOWN');
  cancelMission(m);
  assert.equal(m.status,'CANCELLING');
  reconcileWrite(m,{unitId:'first',token:p.token,leaseGeneration:p.leaseGeneration,
    decision:'CONFIRMED_NO_EFFECT',evidence:['Signed operator validated there were no changes']});
  assert.equal(m.status,'CANCELLED');
  assert.equal(m.units[0].status,'CANCELLED');
});
