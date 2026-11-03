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
