import {validateRelativePath,inScope} from './paths.mjs';
import { randomUUID } from 'node:crypto';
import { createBudget, budgetOf, budgetExpired, budgetStatus, remainingStarts, requirePayloadBudget } from './budget.mjs';

export const HOST_REQUEST = Object.freeze({
  model: 'gpt-6-astra',
  reasoningEffort: 'max',
  rootServiceTier: 'standard',
  nativeWorkerServiceTierPreference: 'fast',
  requestedNativeWorkers: 'maximum-available',
  planningCeiling: 32,
  parallelBatchCeiling: 4,
  modelFallback: 'none',
  externalExecution: false,
  providerInference: false,
});

const assert = (ok, message) => { if (!ok) throw new Error(message); };
const unique = (values) => [...new Set(values)];
const stamp = () => new Date().toISOString();
const pathSafe=p=>{try{validateRelativePath(p);return true;}catch{return false;}};
const LEASE_SECONDS=300;
export function grantPermits(unit,grant,at=Date.now()){
  return unit.effect==='READ'||(grant?.valid===true&&
    Number.isFinite(Date.parse(grant.expiresAt))&&Date.parse(grant.expiresAt)>at&&
    unit.paths.every(path=>grant.paths?.some(root=>path===root||path.startsWith(root+'/'))));
}
function live(mission,unit,token,generation){
  assert((mission.status||'ACTIVE')==='ACTIVE','Mission not active');
  assert(unit?.status==='RUNNING'&&unit.run?.token===token,'Invalid or stale run token');
  assert(generation===undefined||generation===unit.run.leaseGeneration,'Invalid or stale lease generation');
  assert(unit.run.expiresAt&&Date.parse(unit.run.expiresAt)>Date.now(),
    'Lease expired; reconciliation required');
}
export function missionSummary(mission){
  return {id:mission.id,status:mission.status||'ACTIVE',revision:mission.revision,
    finished:mission.units.filter(u=>u.status==='DONE').length,
    uncertain:mission.units.filter(u=>u.status==='OUTCOME_UNKNOWN').length};
}


export function createMission(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'Mission input must be an object');
  assert(typeof input.objective === 'string' && input.objective.trim().length >= 3 && input.objective.length <= 4000,
    'Objective must contain 3–4000 characters');
  assert(Array.isArray(input.units) && input.units.length > 0 && input.units.length <= 100,
    'Provide between 1 and 100 work units');
  const authorization = input.authorization ?? { writesAllowed: false, allowedPaths: [] };
  assert(typeof authorization.writesAllowed === 'boolean' && Array.isArray(authorization.allowedPaths),
    'Authorization must declare writesAllowed and allowedPaths');
  assert(authorization.allowedPaths.every(pathSafe), 'Unsafe authorization path');
  const allowedPaths = unique(authorization.allowedPaths);
  const ids = new Set();
  const units = input.units.map((u, i) => {
    assert(u && typeof u === 'object' && !Array.isArray(u), `Invalid work unit ${i}`);
    assert(typeof u.id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(u.id), 'Invalid work unit id');
    assert(!ids.has(u.id), `Duplicate work unit: ${u.id}`);
    ids.add(u.id);
    assert(typeof u.instruction === 'string' && u.instruction.trim() && u.instruction.length <= 8000,
      `Missing instruction: ${u.id}`);
    assert(u.effect === 'READ' || u.effect === 'WRITE', `Invalid effect: ${u.id}`);
    const dependsOn = u.dependsOn ?? [];
    const paths = u.paths ?? [];
    assert(Array.isArray(dependsOn) && dependsOn.every(x => typeof x === 'string') &&
      new Set(dependsOn).size === dependsOn.length, `Invalid dependencies: ${u.id}`);
    assert(Array.isArray(paths) && paths.every(pathSafe), `Unsafe work paths: ${u.id}`);
    if (u.effect === 'WRITE') {
      assert(paths.length > 0, `Write unit needs scoped paths: ${u.id}`);
      assert(authorization.writesAllowed, `Writes not authorized: ${u.id}`);
      assert(paths.every(p => inScope(p,allowedPaths)),
        `Write path outside authorization: ${u.id}`);
    }
    return { id: u.id, instruction: u.instruction, effect: u.effect,
      dependsOn, paths: unique(paths), status: 'PENDING', attempts: 0, run: null, result: null };
  });
  const byId = new Map(units.map(u => [u.id, u]));
  const visited = new Set();
  const visiting = new Set();
  function walk(id) {
    assert(byId.has(id), `Unknown dependency: ${id}`);
    assert(!visiting.has(id), `Dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const d of byId.get(id).dependsOn) walk(d);
    visiting.delete(id); visited.add(id);
  }
  units.forEach(u => walk(u.id));
  const createdAt=stamp();
  const budget=createBudget(input.budget??{},Date.parse(createdAt),units.length);
  return { schema: 1, status:'ACTIVE', id: randomUUID(), objective: input.objective.trim(),
    revision: 0, createdAt, budget, authorization: { writesAllowed: authorization.writesAllowed,
      allowedPaths }, units };
}

export function evaluateHost(report = {}) {
  assert(report && typeof report === 'object' && !Array.isArray(report), 'Host report must be an object');
  const wrongModel = (report.model !== undefined && report.model !== HOST_REQUEST.model) ||
    (report.reasoningEffort !== undefined && report.reasoningEffort !== HOST_REQUEST.reasoningEffort);
  const n = report.nativeSubagents;
  const available = n?.available === true && Number.isInteger(n.maxConcurrent) && n.maxConcurrent >= 1;
  const max = available ? Math.min(n.maxConcurrent, HOST_REQUEST.parallelBatchCeiling,
    HOST_REQUEST.planningCeiling) : 1;
  return { requested: HOST_REQUEST, modelStatus: wrongModel ? 'MISMATCH_BLOCKED' :
    report.model === HOST_REQUEST.model && report.reasoningEffort === HOST_REQUEST.reasoningEffort
      ? 'HOST_REPORTED_UNVERIFIED' : 'REQUESTED_UNVERIFIED',
    allowed: !wrongModel, executionMode: available ? 'HOST_NATIVE' : 'INLINE',
    maxParallel: max, capabilityEvidence: available ? 'HOST_REPORTED_UNVERIFIED' : 'NOT_OBSERVED',
    note: 'This process plans work only. The host owns model selection and any actual native subagent creation.' };
}

// A PENDING unit that already used maxUnitAttempts is exhausted: restore,
// adoption fences or data repair can leave one behind, and it must never
// start again (retryRead enforces the same limit on the way back to PENDING).
function readyUnits(mission) {
  const done = new Set(mission.units.filter(u => u.status === 'DONE').map(u => u.id));
  const cap = budgetOf(mission).maxUnitAttempts;
  return mission.units.filter(u => u.status === 'PENDING' && (u.attempts||0) < cap &&
    u.dependsOn.every(x => done.has(x)));
}

export function nextBatch(mission, report = {}, grant = null) {
  const host=evaluateHost(report);
  const blocked=reason=>({host,mode:'BLOCKED',units:[],reason});
  if((mission.status||'ACTIVE')!=='ACTIVE')return blocked('Mission not active');
  if(!host.allowed)return blocked('The reported model/effort differs from the required host request.');
  if(budgetExpired(mission))return blocked('Mission deadline expired; cancel or reconcile before further work');
  if(mission.budget?.deadlineAt && Date.parse(mission.budget.deadlineAt)-Date.now()<5000)
    return blocked('Mission deadline too close to reserve a safe minimum lease');
  if(mission.units.some(u=>u.status==='OUTCOME_UNKNOWN'))
    return blocked('Uncertain write outcome requires signed operator reconciliation');

  const running=mission.units.filter(u=>u.status==='RUNNING');
  const writers=running.filter(u=>u.effect==='WRITE');
  const readers=running.filter(u=>u.effect==='READ');
  if(writers.length>1||(writers.length>0&&readers.length>0))
    return blocked('Concurrent writer or mixed read/write claims violate serial-write isolation');
  if(writers.length)return {host,mode:'WAITING',units:[],reason:'One writer already holds the exclusive slot'};
  const budget=budgetOf(mission);
  const available=Math.min(host.maxParallel,budget.maxActiveReads)-readers.length;
  if(available<=0)return {host,mode:'WAITING',units:[],
    reason:'No read-only capacity is free under current host and mission limits'};
  const remaining=remainingStarts(mission);
  if(remaining<=0)return blocked('Mission work-start budget exhausted');

  const ready=readyUnits(mission);
  const authorizedWrite=ready.find(u=>u.effect==='WRITE'&&grantPermits(u,grant));
  // Fairness: once a signed writer is ready, drain existing readers instead of
  // endlessly refilling with new readers. Every WRITE remains an exclusive run.
  if(authorizedWrite&&readers.length)return {host,mode:'WAITING',units:[],
    reason:'Drain in-flight READ units before an authorized exclusive WRITE'};
  const selected=authorizedWrite?[authorizedWrite]:
    ready.filter(u=>u.effect==='READ').slice(0,Math.min(available,remaining));
  if(!selected.length){
    if(readers.length)return {host,mode:'WAITING',units:[],
      reason:'In-flight reads remain; dependencies or permissions prevent safe refill'};
    return {host,mode:ready.length?'BLOCKED':'IDLE',units:[],
      reason:ready.length?'No safe or authorized batch.':'No runnable units.'};
  }
  if(selected.length>remaining)selected.length=remaining;
  const parallel=selected.length+readers.length>1;
  return {host,mode:parallel?'PARALLEL_PLAN':'SERIAL_PLAN',
    units:selected.map(x=>({id:x.id,instruction:x.instruction,effect:x.effect,paths:x.paths})),
    availableSlots:Math.max(0,available-selected.length),
    runningReads:readers.length,
    budgetRemaining:remaining-selected.length,
    reason:authorizedWrite?'Exclusive signed WRITE; no overlapping work permitted':
      parallel?'Fill free slots with independent READ units, only if host can actually execute them':
      'Execute the newly reserved READ in the active host context.'};
}

export function startBatch(mission, report = {}, grant = null, leaseSeconds = Math.min(LEASE_SECONDS,budgetOf(mission).maxLeaseSeconds)) {
  assert(Number.isInteger(leaseSeconds)&&leaseSeconds>=5&&leaseSeconds<=budgetOf(mission).maxLeaseSeconds,
    'Lease exceeds mission time budget');
  const plan = nextBatch(mission, report, grant);
  assert(plan.host.allowed, 'Requested model/effort mismatch');
  assert(plan.units.length, `No runnable batch: ${plan.reason}`);
  const packets = plan.units.map(u => {
    const unit = mission.units.find(x => x.id === u.id);
    const token = randomUUID();
    unit.attempts=(unit.attempts||0)+1;
    unit.status = 'RUNNING';
    const startedAt=stamp();
    unit.run = { token, leaseGeneration: (unit.run?.leaseGeneration ?? 0) + 1, startedAt,
      heartbeatAt:startedAt,expiresAt:new Date(Math.min(Date.now()+leaseSeconds*1000,
        budgetOf(mission).deadlineAt?Date.parse(budgetOf(mission).deadlineAt):Infinity)).toISOString(),
      mode: plan.host.executionMode, evidence: plan.host.capabilityEvidence };
    return { missionId: mission.id, unitId: unit.id, token,
      leaseGeneration:unit.run.leaseGeneration,expiresAt:unit.run.expiresAt,
      instruction: unit.instruction, effect: unit.effect, paths: unit.paths,
      hostRequest: HOST_REQUEST, hostEvidence: plan.host };
  });
  mission.revision++;
  return { mission, batch: { mode: plan.mode, packets,
    actualSubagentLaunches: 'NOT_OBSERVED', reason: plan.reason } };
}

export function completeUnit(mission, unitId, token, outcome, generation, grant = null) {
  const unit = mission.units.find(u => u.id === unitId);
  live(mission,unit,token,generation);
  assert(grantPermits(unit,grant),'Effective write permission missing or revoked');
  assert(outcome && typeof outcome === 'object' && typeof outcome.success === 'boolean', 'Invalid outcome');
  assert(typeof outcome.summary === 'string' && outcome.summary.trim().length >= 5 &&
    outcome.summary.length <= 10000, 'Outcome requires a factual summary');
  assert(Array.isArray(outcome.evidence) && outcome.evidence.length > 0 &&
    outcome.evidence.length <= 20 && outcome.evidence.every(x => typeof x === 'string' && x.trim() && x.length <= 2000),
    'Outcome requires bounded evidence items');
  requirePayloadBudget(mission,outcome,'work result');
  unit.status = outcome.success ? 'DONE' : unit.effect==='WRITE' ? 'OUTCOME_UNKNOWN':'FAILED';
  if(unit.status==='OUTCOME_UNKNOWN')unit.run.uncertainty={reason:'WRITE_REPORTED_FAILURE',since:stamp()};
  unit.result = { success: outcome.success, summary: outcome.summary,
    evidence: outcome.evidence, recordedAt: stamp(), assurance: 'HOST_REPORTED_UNVERIFIED' };
  mission.revision++;
  return mission;
}

export function publicStatus(mission) {
  return {id:mission.id,objective:mission.objective,revision:mission.revision,
    state:mission.status||'ACTIVE',budget:budgetStatus(mission),
    units:mission.units.map(u=>({id:u.id,effect:u.effect,status:u.status,
      attempts:u.attempts||0,leaseGeneration:u.run?.leaseGeneration||0,
      expiresAt:u.status==='RUNNING'?u.run?.expiresAt:null,
      dependsOn:u.dependsOn,result:u.result}))};
}
