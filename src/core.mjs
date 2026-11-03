import { randomUUID } from 'node:crypto';

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
const pathSafe = (p) => typeof p === 'string' && p.length > 0 && p.length <= 240 &&
  !p.startsWith('/') && !p.includes('\\') && p.split('/').every(x => x && x !== '.' && x !== '..');
const intersects = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const overlaps = (a, b) => a.some(x => b.some(y => intersects(x, y)));

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
      assert(paths.every(p => allowedPaths.some(x => p === x || p.startsWith(`${x}/`))),
        `Write path outside authorization: ${u.id}`);
    }
    return { id: u.id, instruction: u.instruction, effect: u.effect,
      dependsOn, paths: unique(paths), status: 'PENDING', run: null, result: null };
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
  return { schema: 1, id: randomUUID(), objective: input.objective.trim(),
    revision: 0, createdAt: stamp(), authorization: { writesAllowed: authorization.writesAllowed,
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

function readyUnits(mission) {
  const done = new Set(mission.units.filter(u => u.status === 'DONE').map(u => u.id));
  return mission.units.filter(u => u.status === 'PENDING' && u.dependsOn.every(x => done.has(x)));
}

export function nextBatch(mission, report = {}) {
  const host = evaluateHost(report);
  const running = mission.units.filter(u => u.status === 'RUNNING');
  const ready = readyUnits(mission);
  if (!host.allowed) return { host, mode: 'BLOCKED', units: [], reason: 'The reported model/effort differs from the required host request.' };
  if (running.length) return { host, mode: 'WAITING', units: [], reason: 'Finish or reconcile active work before planning another batch.' };
  const selected = [];
  for (const unit of ready) {
    if (selected.length >= host.maxParallel) break;
    // Writes require independently observed isolated workspaces. This MVP does
    // not admit concurrent writers, even when their declared paths differ.
    if (unit.effect === 'WRITE' && selected.length > 0) continue;
    if (selected.some(x => x.effect === 'WRITE')) continue;
    selected.push(unit);
  }
  if (!selected.length) return { host, mode: ready.length ? 'BLOCKED' : 'IDLE',
    units: [], reason: ready.length ? 'No safe batch.' : 'No runnable units.' };
  return { host, mode: selected.length > 1 ? 'PARALLEL_PLAN' : 'SERIAL_PLAN',
    units: selected.map(x => ({ id: x.id, instruction: x.instruction, effect: x.effect, paths: x.paths })),
    reason: selected.length > 1 ? 'Independent read-only native work, if host supports actual fanout.' :
      'Execute in the currently connected GPT host.' };
}

export function startBatch(mission, report = {}) {
  const plan = nextBatch(mission, report);
  assert(plan.host.allowed, 'Requested model/effort mismatch');
  assert(plan.units.length, `No runnable batch: ${plan.reason}`);
  const packets = plan.units.map(u => {
    const unit = mission.units.find(x => x.id === u.id);
    const token = randomUUID();
    unit.status = 'RUNNING';
    unit.run = { token, leaseGeneration: (unit.run?.leaseGeneration ?? 0) + 1, startedAt: stamp(),
      mode: plan.host.executionMode, evidence: plan.host.capabilityEvidence };
    return { missionId: mission.id, unitId: unit.id, token,
      instruction: unit.instruction, effect: unit.effect, paths: unit.paths,
      hostRequest: HOST_REQUEST, hostEvidence: plan.host };
  });
  mission.revision++;
  return { mission, batch: { mode: plan.mode, packets,
    actualSubagentLaunches: 'NOT_OBSERVED', reason: plan.reason } };
}

export function completeUnit(mission, unitId, token, outcome) {
  const unit = mission.units.find(u => u.id === unitId);
  assert(unit?.status === 'RUNNING' && unit.run?.token === token, 'Invalid or stale run token');
  assert(outcome && typeof outcome === 'object' && typeof outcome.success === 'boolean', 'Invalid outcome');
  assert(typeof outcome.summary === 'string' && outcome.summary.trim().length >= 5 &&
    outcome.summary.length <= 10000, 'Outcome requires a factual summary');
  assert(Array.isArray(outcome.evidence) && outcome.evidence.length > 0 &&
    outcome.evidence.length <= 20 && outcome.evidence.every(x => typeof x === 'string' && x.trim() && x.length <= 2000),
    'Outcome requires bounded evidence items');
  unit.status = outcome.success ? 'DONE' : 'FAILED';
  unit.result = { success: outcome.success, summary: outcome.summary,
    evidence: outcome.evidence, recordedAt: stamp(), assurance: 'HOST_REPORTED_UNVERIFIED' };
  mission.revision++;
  return mission;
}

export function publicStatus(mission) {
  return { id: mission.id, objective: mission.objective, revision: mission.revision,
    units: mission.units.map(u => ({ id: u.id, effect: u.effect, status: u.status,
      dependsOn: u.dependsOn, result: u.result })) };
}
