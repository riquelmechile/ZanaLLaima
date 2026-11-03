import { createMission, nextBatch, startBatch, completeUnit, publicStatus, HOST_REQUEST } from './core.mjs';
import { readState, transact, readHistory, readReviewArchive, storageStatus, migrateLegacy, backupState, restoreBackup,
  authorizationStatus, archiveMission, readMissionArchive } from './store.mjs';
import { openReview, reviewStatus, nextReviewBatch, startReviewBatch, submitReview, checkCandidate } from './review.mjs';
import { heartbeatUnit, expireUnits, retryRead, cancelMission, closeMission } from './lifecycle.mjs';
import { verifyWorkspacePaths } from './paths.mjs';

export const operations = {
  profile: async () => ({ requested: HOST_REQUEST, assurance: 'REQUESTED_ONLY' }),
  storageStatus: async () => storageStatus(),
  authorizationStatus: async () => authorizationStatus(),
  missionHistory: async (args={}) => readMissionArchive(args),
  archive: async () => archiveMission(),
  storageHistory: async (args = {}) => readHistory(args),
  storageReviews: async (args = {}) => readReviewArchive(args),
  storageMigrate: async () => ({ mission: publicStatus(await migrateLegacy()), backend: await storageStatus() }),
  storageBackup: async ({ destination }) => backupState(destination),
  storageRestore: async ({ source, offline = false }) => restoreBackup(source, undefined, { offline }),
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
    const status=await authorizationStatus();
    const grant=status.valid?{...status,valid:true}:null;
    return nextBatch(state, hostReport,grant);
  },
  start: async ({ hostReport = {} } = {}) => {
    let batch;
    await transact(async (existing,context) => {
      if (!existing) throw Error('No mission initialized');
      const preview=nextBatch(existing,hostReport,context.writeGrant);
      for(const unit of preview.units.filter(x=>x.effect==='WRITE'))
        await verifyWorkspacePaths(unit.paths);
      const changed = startBatch(existing, hostReport,context.writeGrant);
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

  heartbeat: async args => {
    let packet;
    await transact((existing,context)=>{
      if(!existing)throw Error('No active mission');
      packet=heartbeatUnit(existing,args,context.writeGrant);
      return existing;
    });
    return packet;
  },
  recoverExpired: async () => {
    let changed;
    await transact(existing=>{
      if(!existing)throw Error('No active mission');
      changed=expireUnits(existing);
      return existing;
    });
    return {changed};
  },
  retry: async ({unitId}) => {
    let status;
    await transact(existing=>{
      if(!existing)throw Error('No active mission');
      status=retryRead(existing,unitId);
      return existing;
    });
    return status;
  },
  cancel: async () => {
    let status;
    await transact(existing=>{
      if(!existing)throw Error('No active mission');
      status=cancelMission(existing);
      return existing;
    });
    return status;
  },
  close: async () => {
    let status;
    await transact(existing=>{
      if(!existing)throw Error('No active mission');
      status=closeMission(existing);
      return existing;
    });
    return status;
  },
  complete: async ({ unitId, token, leaseGeneration, outcome }) => {
    const state = await transact((existing,context) => {
      if (!existing) throw Error('No mission initialized');
      return completeUnit(existing, unitId, token, outcome, leaseGeneration, context.writeGrant);
    });
    return publicStatus(state);
  },
};
