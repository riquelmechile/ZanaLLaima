import { randomUUID } from 'node:crypto';
import { evaluateHost } from './core.mjs';

export const REVIEW_LENSES = Object.freeze([
  { id: 'risk', title: 'Risk and security',
    instruction: 'Inspect authorization, trust boundaries, credentials, dangerous actions and data exposure. Identify blocking vulnerabilities and risky assumptions.' },
  { id: 'reliability', title: 'Correctness and reliability',
    instruction: 'Inspect invariants, state transitions, inputs, error handling and test coverage. Reproduce plausible failures where tools allow.' },
  { id: 'resilience', title: 'Recovery and resilience',
    instruction: 'Inspect crashes, races, stale claims, restarts, retries, idempotency and rollback. Identify unsafe recovery paths.' },
  { id: 'readability', title: 'Maintainability and clarity',
    instruction: 'Inspect design simplicity, contracts, naming, documentation and operational clarity. Highlight future maintenance hazards.' },
]);

const insist = (test, message) => { if (!test) throw new Error(message); };
const SHA = /^[a-f0-9]{40}$/;
const now = () => new Date().toISOString();
const validText = (x, max) => typeof x === 'string' && x.trim().length > 0 && x.length <= max;
const allowedSeverities = new Set(['BLOCKER', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
const blocking = new Set(['BLOCKER', 'CRITICAL', 'HIGH']);

export function openReview(mission, { candidateSha, hostReport = {}, risk = 'MEDIUM' } = {}) {
  insist(mission?.schema === 1 && Array.isArray(mission.units), 'An existing mission is required');
  insist(mission.units.length > 0 && mission.units.every(x => x.status === 'DONE'),
    'All mission units must be completed successfully before review');
  insist(typeof candidateSha === 'string' && SHA.test(candidateSha), 'Candidate must be an exact lowercase 40-character Git SHA');
  insist(['LOW', 'MEDIUM', 'HIGH'].includes(risk), 'Invalid risk level');
  const host = evaluateHost(hostReport);
  insist(host.allowed, 'The requested model or reasoning effort does not match this host report');
  if (mission.review && mission.review.candidateSha === candidateSha) {
    throw Error('Review already exists for this candidate; resume instead of silently replacing its evidence');
  }
  if (mission.review) (mission.reviewHistory ??= []).push(mission.review);
  const mode = host.executionMode === 'HOST_NATIVE' ? 'NATIVE_PLANNED' : 'SOLO_SEQUENTIAL';
  mission.review = {
    id: randomUUID(), candidateSha, mode, risk, state: 'OPEN',
    createdAt: now(), capabilityEvidence: host.capabilityEvidence,
    lenses: REVIEW_LENSES.map(x => ({ id: x.id, title: x.title,
      state: 'PENDING', run: null, result: null })),
  };
  mission.revision += 1;
  return reviewStatus(mission);
}

export function reviewStatus(mission) {
  const review = mission?.review;
  if (!review) return { state: 'NOT_STARTED', approved: false };
  const statuses = review.lenses.map(x => ({
    id: x.id, state: x.state, result: x.result,
  }));
  const unfinished = review.lenses.some(x => x.state !== 'DONE');
  const objections = review.lenses.some(x => x.result &&
    (x.result.verdict === 'CHANGES' || x.result.findings.some(f => blocking.has(f.severity))));
  const gate = review.state === 'INVALIDATED' ? 'INVALIDATED_CANDIDATE' :
    unfinished ? 'REVIEW_IN_PROGRESS' :
    objections ? 'CHANGES_REQUIRED' :
    review.mode === 'SOLO_SEQUENTIAL' ? 'SELF_CHECK_COMPLETE_UNVERIFIED' :
      'NATIVE_4R_REPORTED_UNVERIFIED';
  return {
    reviewId: review.id,
    candidateSha: review.candidateSha,
    mode: review.mode, risk: review.risk, state: review.state,
    gate, approved: false, independentReviewVerified: false,
    candidateVerifiedByGit: false, hostModelVerified: false,
    lenses: statuses,
    instruction: gate === 'SELF_CHECK_COMPLETE_UNVERIFIED'
      ? 'Four self-check lenses completed, not an independent approval.'
      : gate === 'NATIVE_4R_REPORTED_UNVERIFIED'
        ? 'Native contexts are host-reported. Independently attested execution and Git evidence are still required.'
        : gate === 'CHANGES_REQUIRED'
          ? 'Resolve findings, create a new Git candidate and open a fresh review.'
          : gate === 'INVALIDATED_CANDIDATE'
            ? 'The frozen candidate changed; the review cannot be reused.'
            : 'Complete the outstanding review lenses with actual evidence.',
  };
}

export function nextReviewBatch(mission) {
  const review = mission?.review;
  insist(review && review.state === 'OPEN', 'No active review');
  const running = review.lenses.filter(x => x.state === 'RUNNING');
  if (running.length) return { mode: 'WAITING', lenses: [], reason: 'Finish outstanding review packets first' };
  const pending = review.lenses.filter(x => x.state === 'PENDING');
  const amount = review.mode === 'NATIVE_PLANNED' ? REVIEW_LENSES.length : 1;
  const selected = pending.slice(0, amount);
  return {
    mode: review.mode,
    candidateSha: review.candidateSha,
    lenses: selected.map(x => ({
      id: x.id, title: x.title,
      instruction: REVIEW_LENSES.find(y => y.id === x.id).instruction,
    })),
    hostLaunchObserved: false,
    independenceVerified: false,
  };
}

export function startReviewBatch(mission) {
  const plan = nextReviewBatch(mission);
  insist(plan.lenses.length > 0, 'No review lenses available');
  const packets = plan.lenses.map(lens => {
    const target = mission.review.lenses.find(x => x.id === lens.id);
    const token = randomUUID();
    target.state = 'RUNNING';
    target.run = { token, issuedAt: now() };
    return {
      reviewId: mission.review.id, lensId: lens.id, token,
      candidateSha: mission.review.candidateSha,
      mode: mission.review.mode, instruction: lens.instruction,
      isolation: 'Read the exact candidate and evidence independently; do not consume other lens outputs.',
    };
  });
  mission.revision += 1;
  return { packets, mode: plan.mode, actualNativeLaunches: 'NOT_OBSERVED',
    independentReviewVerified: false };
}

export function submitReview(mission, { lensId, token, candidateSha, verdict, summary, evidence,
  findings = [], execution = 'SELF_CONTEXT', contextId } = {}) {
  const review = mission?.review;
  insist(review?.state === 'OPEN', 'No active review');
  insist(candidateSha === review.candidateSha, 'Candidate SHA mismatch');
  const lens = review.lenses.find(x => x.id === lensId);
  insist(lens?.state === 'RUNNING' && lens.run?.token === token, 'Unknown or stale review packet');
  insist(verdict === 'PASS' || verdict === 'CHANGES', 'Invalid review verdict');
  insist(validText(summary, 10000), 'Provide a factual review summary');
  insist(Array.isArray(evidence) && evidence.length >= 1 && evidence.length <= 20 &&
    evidence.every(x => validText(x, 2000)), 'Provide actual bounded review evidence');
  insist(Array.isArray(findings) && findings.length <= 30 && findings.every(x =>
    x && allowedSeverities.has(x.severity) && validText(x.description, 2000) &&
    (x.path === undefined || validText(x.path, 240))), 'Invalid findings');
  insist(verdict !== 'PASS' || !findings.some(x => blocking.has(x.severity)),
    'A PASS cannot contain blocking findings');
  const expected = review.mode === 'SOLO_SEQUENTIAL' ? 'SELF_CONTEXT' : 'NATIVE_SUBAGENT';
  insist(execution === expected, 'Execution provenance contradicts the planned review mode');
  if (expected === 'NATIVE_SUBAGENT') {
    insist(validText(contextId, 200), 'Native review needs a host-reported context identifier');
    insist(!review.lenses.some(x => x.id !== lensId && x.result?.contextId === contextId),
      'Native review context must be distinct per lens');
  } else insist(contextId === undefined, 'A self-review may not claim a separate context');
  lens.state = 'DONE';
  lens.run = null;
  lens.result = {
    verdict, summary, evidence, findings, execution,
    ...(contextId === undefined ? {} : { contextId }),
    assurance: expected === 'SELF_CONTEXT' ? 'SELF_REPORTED_UNVERIFIED' :
      'HOST_REPORTED_UNVERIFIED',
    recordedAt: now(),
  };
  mission.revision += 1;
  return reviewStatus(mission);
}

export function checkCandidate(mission, observedSha) {
  const review = mission?.review;
  insist(review, 'No review exists');
  insist(typeof observedSha === 'string' && SHA.test(observedSha), 'Observed candidate SHA must be exact');
  if (review.state === 'OPEN' && observedSha !== review.candidateSha) {
    review.state = 'INVALIDATED';
    review.invalidatedAt = now();
    review.observedSha = observedSha;
    mission.revision += 1;
  }
  return { ...reviewStatus(mission), observedCandidate: observedSha,
    observationAssurance: 'HOST_REPORTED_UNVERIFIED' };
}
