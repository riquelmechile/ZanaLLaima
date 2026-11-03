import { createMission, nextBatch, startBatch, completeUnit, publicStatus, HOST_REQUEST } from './core.mjs';
import { readState, transact } from './store.mjs';
import { openReview, reviewStatus, nextReviewBatch, startReviewBatch, submitReview, checkCandidate } from './review.mjs';

export const operations = {
  profile: async () => ({ requested: HOST_REQUEST, assurance: 'REQUESTED_ONLY' }),
  init: async ({ spec }) => {
    const result = await transact(existing => {
      if (existing) throw Error('Mission exists; finish or archive it before starting another');
      return createMission(spec);
    });
    return publicStatus(result);
  },
  status: async () => {
    const state = await readState();
    if (!state) throw Error('No mission initialized');
    return publicStatus(state);
  },
  next: async ({ hostReport = {} } = {}) => {
    const state = await readState();
    if (!state) throw Error('No mission initialized');
    return nextBatch(state, hostReport);
  },
  start: async ({ hostReport = {} } = {}) => {
    let batch;
    await transact(existing => {
      if (!existing) throw Error('No mission initialized');
      const changed = startBatch(existing, hostReport);
      batch = changed.batch;
      return changed.mission;
    });
    return batch;
  },
  reviewOpen: async (args) => {
    let status;
    await transact(existing => {
      if (!existing) throw Error('No mission initialized');
      status = openReview(existing, args);
      return existing;
    });
    return status;
  },
  reviewStatus: async () => {
    const state = await readState();
    if (!state) throw Error('No mission initialized');
    return reviewStatus(state);
  },
  reviewNext: async () => {
    const state = await readState();
    if (!state) throw Error('No mission initialized');
    return nextReviewBatch(state);
  },
  reviewStart: async () => {
    let result;
    await transact(existing => {
      if (!existing) throw Error('No mission initialized');
      result = startReviewBatch(existing);
      return existing;
    });
    return result;
  },
  reviewSubmit: async (args) => {
    let status;
    await transact(existing => {
      if (!existing) throw Error('No mission initialized');
      status = submitReview(existing, args);
      return existing;
    });
    return status;
  },
  reviewCheckCandidate: async ({ observedSha }) => {
    let status;
    await transact(existing => {
      if (!existing) throw Error('No mission initialized');
      status = checkCandidate(existing, observedSha);
      return existing;
    });
    return status;
  },
  complete: async ({ unitId, token, outcome }) => {
    const state = await transact(existing => {
      if (!existing) throw Error('No mission initialized');
      return completeUnit(existing, unitId, token, outcome);
    });
    return publicStatus(state);
  },
};
