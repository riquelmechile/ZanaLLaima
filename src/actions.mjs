import { createMission, nextBatch, startBatch, completeUnit, publicStatus, HOST_REQUEST } from './core.mjs';
import { readState, transact } from './store.mjs';

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
  complete: async ({ unitId, token, outcome }) => {
    const state = await transact(existing => {
      if (!existing) throw Error('No mission initialized');
      return completeUnit(existing, unitId, token, outcome);
    });
    return publicStatus(state);
  },
};
