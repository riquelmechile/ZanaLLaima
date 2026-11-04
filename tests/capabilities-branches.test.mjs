import test from 'node:test';
import assert from 'node:assert/strict';
import {capabilityContract} from '../src/capabilities.mjs';
const requested={model:'gpt-6-astra',reasoningEffort:'max'};

test('capability contract distinguishes absent, partial and genuine host declarations',()=>{
  const missing=capabilityContract();
  assert.equal(missing.hostReported.assurance,'NOT_REPORTED');
  assert.equal(missing.hostReported.model,null);
  assert.equal(missing.hostReported.reasoningEffort,null);
  assert.equal(missing.hostReported.nativeSubagents.available,false);
  assert.equal(missing.verified.nativeLaunches,null);
  assert.equal(missing.decision.maxParallel,1);
  const partial=capabilityContract({model:requested.model});
  assert.equal(partial.hostReported.model,requested.model);
  assert.equal(partial.hostReported.reasoningEffort,null);
  assert.equal(partial.hostReported.assurance,'HOST_REPORTED_UNVERIFIED');
  const effort=capabilityContract({reasoningEffort:requested.reasoningEffort});
  assert.equal(effort.hostReported.model,null);
  assert.equal(effort.hostReported.reasoningEffort,'max');
});

test('native capacity reports are bounded, invalid reports never gain verification',()=>{
  for(const report of [
    {nativeSubagents:{available:true,maxConcurrent:0}},
    {nativeSubagents:{available:false,maxConcurrent:4}},
    {nativeSubagents:{available:true}},
    {nativeSubagents:{available:true,maxConcurrent:-1}},
    {nativeSubagents:{available:true,maxConcurrent:'4'}},
  ]){
    const out=capabilityContract(report);
    assert.equal(out.hostReported.nativeSubagents.available,false);
    assert.equal(out.verified.assurance,'NOT_OBSERVED');
  }
  const full=capabilityContract({...requested,nativeSubagents:{available:true,maxConcurrent:32},
    verified:true});
  assert.equal(full.decision.maxParallel,4);
  assert.equal(full.hostReported.nativeSubagents.maxConcurrent,32);
  assert.equal(full.verified.model,null);
  assert.equal(full.verified.nativeLaunches,null);
  const bad=capabilityContract({model:'not-requested'});
  assert.equal(bad.decision.allowed,false);
  assert.equal(bad.verified.model,null);
  assert.throws(()=>capabilityContract(null),/Host report must be an object/);
  assert.throws(()=>capabilityContract([]),/Host report must be an object/);
});
