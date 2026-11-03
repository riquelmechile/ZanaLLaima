import { HOST_REQUEST, evaluateHost } from './core.mjs';

const READONLY = Object.freeze({
  assurance: 'NOT_OBSERVED', model: null, reasoningEffort: null,
  nativeSubagents: null, nativeLaunches: null,
  evidence: [],
});

export function capabilityContract(hostReport = {}) {
  const evaluated = evaluateHost(hostReport);
  // A client-supplied report is never a trusted proof, even when it calls itself verified.
  const reported = {
    assurance: Object.keys(hostReport).length ? 'HOST_REPORTED_UNVERIFIED' : 'NOT_REPORTED',
    model: typeof hostReport.model === 'string' ? hostReport.model : null,
    reasoningEffort: typeof hostReport.reasoningEffort === 'string'
      ? hostReport.reasoningEffort : null,
    nativeSubagents: hostReport.nativeSubagents?.available === true &&
      Number.isInteger(hostReport.nativeSubagents?.maxConcurrent) &&
      hostReport.nativeSubagents.maxConcurrent > 0
        ? {available:true,maxConcurrent:hostReport.nativeSubagents.maxConcurrent}
        : {available:false,maxConcurrent:0},
  };
  return {
    requested: HOST_REQUEST,
    hostReported: reported,
    verified: { ...READONLY, evidence: [] },
    decision: {
      allowed: evaluated.allowed,
      executionMode: evaluated.executionMode,
      maxParallel: evaluated.maxParallel,
      capabilityEvidence: evaluated.capabilityEvidence,
      verifiedNativeLaunches: 0,
    },
    note: 'Requested configuration and host reports do not prove the model or any subagent launch. This local MCP server cannot verify ChatGPT capabilities.',
  };
}
