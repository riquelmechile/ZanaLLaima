import test from 'node:test';
import assert from 'node:assert/strict';
import { createMission } from '../src/core.mjs';
import { openReview, reviewStatus, nextReviewBatch, startReviewBatch, submitReview, checkCandidate } from '../src/review.mjs';

const shaA = 'a'.repeat(40);
const shaB = 'b'.repeat(40);
function prepared() {
  const m = createMission({ objective: 'Review an isolated code change',
    authorization: { writesAllowed: false, allowedPaths: [] },
    units: [{ id: 'scan', effect: 'READ', instruction: 'Inspect code' }] });
  m.units[0].status = 'DONE';
  return m;
}
const outcome = (packet, execution = 'SELF_CONTEXT', contextId) => ({
  lensId: packet.lensId, token: packet.token, candidateSha: packet.candidateSha,
  verdict: 'PASS', summary: 'Reviewed the exact candidate and tests',
  evidence: ['Inspected source and related tests'], findings: [], execution,
  ...(contextId ? { contextId } : {}),
});

test('review definitions', () => { assert.equal(shaA.length, 40); });

test('sequential review requires four completions', () => {
  const m = prepared();
  openReview(m, { candidateSha: shaA });
  for (const id of ['risk', 'reliability', 'resilience', 'readability']) {
    const packet = startReviewBatch(m).packets[0];
    assert.equal(packet.lensId, id);
    submitReview(m, outcome(packet));
  }
  assert.equal(reviewStatus(m).gate, 'SELF_CHECK_COMPLETE_UNVERIFIED');
  assert.equal(reviewStatus(m).approved, false);
});

test('native packet planning does not grant verified approval', () => {
  const m = prepared();
  openReview(m, { candidateSha: shaA, hostReport: {
    model: 'gpt-6-astra', reasoningEffort: 'max',
    nativeSubagents: { available: true, maxConcurrent: 4 }
  } });
  const packets = startReviewBatch(m).packets;
  assert.equal(packets.length, 4);
  for (let i = 0; i < packets.length; i++)
    submitReview(m, outcome(packets[i], 'NATIVE_SUBAGENT', 'context-' + i));
  assert.equal(reviewStatus(m).gate, 'NATIVE_4R_REPORTED_UNVERIFIED');
  assert.equal(reviewStatus(m).independentReviewVerified, false);
});
