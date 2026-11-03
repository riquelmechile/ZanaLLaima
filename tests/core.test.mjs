import test from 'node:test';
import assert from 'node:assert/strict';
import { createMission, evaluateHost, nextBatch, startBatch, completeUnit, HOST_REQUEST } from '../src/core.mjs';

const spec = () => ({ objective: 'Implement and verify an isolated task runner',
  authorization: { writesAllowed: true, allowedPaths: ['docs'] },
  units: [
    { id: 'read-a', effect: 'READ', instruction: 'Inspect the current docs', paths: ['docs'] },
    { id: 'read-b', effect: 'READ', instruction: 'Inspect current tests', paths: ['tests'] },
    { id: 'write', effect: 'WRITE', instruction: 'Update the scoped docs', paths: ['docs'], dependsOn: ['read-a', 'read-b'] },
    { id: 'verify', effect: 'READ', instruction: 'Check the new docs', dependsOn: ['write'] },
  ] });
const host = { model: 'gpt-6-astra', reasoningEffort: 'max', nativeSubagents: { available: true, maxConcurrent: 20 } };
const grant={valid:true,paths:['docs'],expiresAt:new Date(Date.now()+3600000).toISOString()};
const evidence = { success: true, summary: 'Verified the required task with actual checks', evidence: ['Read files and checked the expected behavior'] };

test('maximum policy requests, never claims actual model or fanout', () => {
  assert.equal(HOST_REQUEST.reasoningEffort, 'max');
  assert.equal(HOST_REQUEST.externalExecution, false);
  assert.equal(HOST_REQUEST.modelFallback, 'none');
  assert.equal(evaluateHost(host).maxParallel, 4);
  assert.equal(evaluateHost(host).modelStatus, 'HOST_REPORTED_UNVERIFIED');
  assert.equal(evaluateHost({}).executionMode, 'INLINE');
  assert.equal(evaluateHost({}).modelStatus, 'REQUESTED_UNVERIFIED');
  assert.equal(evaluateHost({ model: 'other' }).allowed, false);
});

test('local native batch plans two independent read units and no fake launches', () => {
  const m = createMission(spec());
  const plan = nextBatch(m, host);
  assert.equal(plan.mode, 'PARALLEL_PLAN');
  assert.deepEqual(plan.units.map(u => u.id), ['read-a', 'read-b']);
  const { batch } = startBatch(m, host);
  assert.equal(batch.packets.length, 2);
  assert.equal(batch.actualSubagentLaunches, 'NOT_OBSERVED');
  assert.equal(nextBatch(m, host).mode, 'WAITING');
  completeUnit(m, batch.packets[0].unitId, batch.packets[0].token, evidence);
  assert.equal(nextBatch(m, host).mode, 'WAITING');
  completeUnit(m, batch.packets[1].unitId, batch.packets[1].token, evidence);
  const next = startBatch(m, host,grant).batch;
  assert.deepEqual(next.packets.map(x => x.unitId), ['write']);
  completeUnit(m, 'write', next.packets[0].token, evidence, next.packets[0].leaseGeneration,grant);
  assert.deepEqual(startBatch(m, host).batch.packets.map(x => x.unitId), ['verify']);
});

test('never run concurrent writers or exceed inline capability', () => {
  const m = createMission({ objective: 'Safely update two files',
    authorization: { writesAllowed: true, allowedPaths: ['docs'] },
    units: [ { id: 'a', effect: 'WRITE', instruction: 'Write document A', paths: ['docs/a'] },
      { id: 'b', effect: 'WRITE', instruction: 'Write document B', paths: ['docs/b'] } ] });
  assert.equal(nextBatch(m, host).units.length, 0);
  assert.equal(nextBatch(m, host,grant).units.length, 1);
  assert.equal(nextBatch(m, {},grant).units.length, 1);
});

test('reject dependency cycles, escaping paths, unauthorized writes and stale completion', () => {
  const base = spec();
  base.units[0].dependsOn = ['verify'];
  assert.throws(() => createMission(base), /cycle/i);
  const unsafe = spec(); unsafe.units[2].paths = ['../etc'];
  assert.throws(() => createMission(unsafe), /Unsafe/);
  const unauth = spec(); unauth.authorization.writesAllowed = false;
  assert.throws(() => createMission(unauth), /not authorized/);
  const m = createMission(spec());
  const batch = startBatch(m, host).batch;
  assert.throws(() => completeUnit(m, 'read-a', 'wrong', evidence), /stale/);
  assert.throws(() => completeUnit(m, 'read-a', batch.packets[0].token,
    { success: true, summary: 'Looks good', evidence: [] }), /evidence/);
  completeUnit(m, 'read-a', batch.packets[0].token, evidence);
  assert.throws(() => completeUnit(m, 'read-a', batch.packets[0].token, evidence), /stale/);
});

test('explicit model mismatch blocks planning and unverified results stay labeled', () => {
  const m = createMission(spec());
  assert.equal(nextBatch(m, { model: 'different-model' }).mode, 'BLOCKED');
  const b = startBatch(m, host).batch;
  completeUnit(m, b.packets[0].unitId, b.packets[0].token, { ...evidence, success: false });
  completeUnit(m, b.packets[1].unitId, b.packets[1].token, evidence);
  assert.equal(m.units[0].result.assurance, 'HOST_REPORTED_UNVERIFIED');
  assert.equal(nextBatch(m, host).mode, 'IDLE');
});
