import test from 'node:test';
import assert from 'node:assert/strict';
import {createMission,startBatch} from '../src/core.mjs';
import {heartbeatUnit,expireUnits,retryRead,reconcileWrite,revokeRunningWrites,
  cancelMission,closeMission} from '../src/lifecycle.mjs';

const read=()=>createMission({objective:'Exercise lifecycle boundary branches',
  authorization:{writesAllowed:false,allowedPaths:[]},
  units:[{id:'r',effect:'READ',instruction:'Inspect a read-only module'}]});
const write=()=>createMission({objective:'Exercise write uncertainty handling',
  authorization:{writesAllowed:true,allowedPaths:['docs']},
  units:[{id:'w',effect:'WRITE',instruction:'Update a scoped document',paths:['docs']}]});
const grant={valid:true,expiresAt:new Date(Date.now()+600000).toISOString(),paths:['docs']};
const claimed=(m,permission)=>startBatch(m,{},permission).batch.packets[0];

test('heartbeat rejects closed/expired/stale/missing grants and respects duration budget',()=>{
  const m=read();
  const p=claimed(m);
  assert.throws(()=>heartbeatUnit(m,{unitId:'r',token:'bad',
    leaseGeneration:p.leaseGeneration}),/stale/);
  assert.throws(()=>heartbeatUnit(m,{unitId:'r',token:p.token,
    leaseGeneration:p.leaseGeneration,leaseSeconds:1}),/lease budget/);
  const h=heartbeatUnit(m,{unitId:'r',token:p.token,leaseGeneration:p.leaseGeneration});
  assert.equal(h.unitId,'r');
  m.units[0].run.expiresAt=new Date(Date.now()-10).toISOString();
  assert.throws(()=>heartbeatUnit(m,{unitId:'r',token:p.token,
    leaseGeneration:p.leaseGeneration}),/Lease expired/);
  m.status='CLOSED';
  assert.throws(()=>heartbeatUnit(m,{unitId:'r',token:p.token,
    leaseGeneration:p.leaseGeneration}),/Mission not active/);
  const w=write(),pw=claimed(w,grant);
  assert.throws(()=>heartbeatUnit(w,{unitId:'w',token:pw.token,
    leaseGeneration:pw.leaseGeneration},null),/permission/);
  w.budget.deadlineAt=new Date(Date.now()-1000).toISOString();
  assert.throws(()=>heartbeatUnit(w,{unitId:'w',token:pw.token,
    leaseGeneration:pw.leaseGeneration},grant),/time budget/);
});

test('expiry handles READ vs WRITE and leaves active work in CANCELLING state for reconciliation',()=>{
  const r=read();
  const p=claimed(r);
  assert.deepEqual(expireUnits(r),[]);
  r.units[0].run.expiresAt=new Date(Date.now()-10).toISOString();
  assert.equal(expireUnits(r)[0].status,'EXPIRED');
  assert.deepEqual(expireUnits(r),[]);
  assert.equal(retryRead(r,'r').finished,0);
  assert.equal(r.units[0].status,'PENDING');
  assert.throws(()=>retryRead(r,'r'),/Only expired or failed READ/);
  const w=write(),wp=claimed(w,grant);
  w.units[0].run.expiresAt=new Date(Date.now()-1).toISOString();
  w.status='CANCELLING';
  assert.equal(expireUnits(w)[0].status,'OUTCOME_UNKNOWN');
  assert.equal(w.units[0].run.uncertainty.reason,'LEASE_EXPIRED_WRITE');
  assert.throws(()=>retryRead(w,'w'),/Mission not active/);
  assert.throws(()=>expireUnits({...w,status:'CLOSED'}),/Mission not active/);
});

test('reconciliation validates evidence, token, decision and terminating cancel state',()=>{
  const m=write(),p=claimed(m,grant);
  m.units[0].status='OUTCOME_UNKNOWN';
  const args={unitId:'w',token:p.token,leaseGeneration:p.leaseGeneration,
    decision:'CONFIRMED_NO_EFFECT',
    evidence:['Operator inspected disk and confirmed no modification']};
  assert.throws(()=>reconcileWrite(m,{...args,token:'bad'}),/Stale/);
  assert.throws(()=>reconcileWrite(m,{...args,evidence:[]}),/evidence/);
  assert.throws(()=>reconcileWrite(m,{...args,decision:'UNKNOWN'}),/Invalid decision/);
  assert.equal(reconcileWrite(m,args).uncertain,0);
  assert.equal(m.units[0].status,'PENDING');
  assert.throws(()=>reconcileWrite(m,args),/Only an uncertain WRITE/);
  const cancel=write(),cp=claimed(cancel,grant);
  cancelMission(cancel);
  assert.equal(cancel.status,'CANCELLING');
  assert.equal(reconcileWrite(cancel,{...args,token:cp.token,
    leaseGeneration:cp.leaseGeneration}).uncertain,0);
  assert.equal(cancel.status,'CANCELLED');
  assert.equal(cancel.units[0].status,'CANCELLED');
  assert.throws(()=>cancelMission(cancel),/Mission not active/);
});

test('revoking active WRITE differs from READ and closing only succeeds when fully done',()=>{
  const m=write();
  assert.deepEqual(revokeRunningWrites(m),[]);
  const p=claimed(m,grant);
  assert.deepEqual(revokeRunningWrites(m),['w']);
  assert.deepEqual(revokeRunningWrites(m),[]);
  assert.equal(m.units[0].status,'OUTCOME_UNKNOWN');
  assert.throws(()=>closeMission(m),/All units/);
  const r=read(),packet=claimed(r);
  assert.deepEqual(revokeRunningWrites(r),[]);
  assert.throws(()=>closeMission(r),/All units/);
  r.units[0].status='DONE';
  r.review={lenses:[{state:'RUNNING'}]};
  assert.throws(()=>closeMission(r),/review/);
  r.review.lenses[0].state='DONE';
  assert.equal(closeMission(r).status,'CLOSED');
  assert.throws(()=>closeMission(r),/Mission not active/);
});
