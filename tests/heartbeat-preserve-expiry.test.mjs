import test from 'node:test';
import assert from 'node:assert/strict';
import {createMission,startBatch} from '../src/core.mjs';
import {heartbeatUnit} from '../src/lifecycle.mjs';

const make=({maxLeaseSeconds=600}={})=>createMission({
  objective:'Verify a heartbeat does not shorten an active lease',
  authorization:{writesAllowed:false,allowedPaths:[]},
  budget:{maxLeaseSeconds},
  units:[{id:'long-read',effect:'READ',instruction:'Inspect a lengthy fixture'}]
});

test('default heartbeat cannot shorten a live 600-second lease to 300 seconds',()=>{
  const m=make();
  const p=startBatch(m,{},null,600).batch.packets[0];
  const existing=Date.parse(m.units[0].run.expiresAt);
  const ack=heartbeatUnit(m,{unitId:p.unitId,token:p.token,
    leaseGeneration:p.leaseGeneration});
  assert.ok(Date.parse(ack.expiresAt)>=existing,
    'A default heartbeat must not reduce an existing valid lease');
  assert.ok(Date.parse(ack.expiresAt)-Date.now()>550000);
});

test('shorter explicit heartbeat preserves original expiry; longer extension increases it',()=>{
  const m=make(),p=startBatch(m,{},null,300).batch.packets[0];
  const initial=Date.parse(m.units[0].run.expiresAt);
  const short=heartbeatUnit(m,{unitId:p.unitId,token:p.token,
    leaseGeneration:p.leaseGeneration,leaseSeconds:30});
  assert.ok(Date.parse(short.expiresAt)>=initial);
  const longer=heartbeatUnit(m,{unitId:p.unitId,token:p.token,
    leaseGeneration:p.leaseGeneration,leaseSeconds:600});
  assert.ok(Date.parse(longer.expiresAt)>=Date.parse(short.expiresAt));
  assert.ok(Date.parse(longer.expiresAt)-Date.now()>550000);
});

test('deadline remains a hard cap and cannot be extended by an existing longer lease',()=>{
  const m=make(),p=startBatch(m,{},null,600).batch.packets[0];
  const deadline=Date.now()+450000;
  m.budget.deadlineAt=new Date(deadline).toISOString();
  const ack=heartbeatUnit(m,{unitId:p.unitId,token:p.token,
    leaseGeneration:p.leaseGeneration,leaseSeconds:600});
  assert.ok(Date.parse(ack.expiresAt)<=deadline);
  assert.ok(Date.parse(ack.expiresAt)>Date.now());
});

test('short lease defaults remain bounded by the smaller mission budget',()=>{
  const m=make({maxLeaseSeconds:60});
  const p=startBatch(m).batch.packets[0];
  const ack=heartbeatUnit(m,{unitId:p.unitId,token:p.token,
    leaseGeneration:p.leaseGeneration});
  assert.ok(Date.parse(ack.expiresAt)-Date.now()<=60000);
  assert.throws(()=>heartbeatUnit(m,{unitId:p.unitId,token:p.token,
    leaseGeneration:p.leaseGeneration,leaseSeconds:61}),/lease budget/);
});
