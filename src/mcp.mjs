#!/usr/bin/env node
// Local MCP stdio adapter: no network listener, remote jobs or provider API.
import { createInterface } from 'node:readline';
import { operations } from './actions.mjs';

const obj = { type: 'object', additionalProperties: false };
const schemas = {
  zana_profile: { ...obj, properties: {} },
  zana_storage_status: { ...obj, properties: {} },
  zana_storage_history: { ...obj, properties: { limit: { type: 'integer', minimum: 1, maximum: 100 },
    before: { type: 'integer', minimum: 1 }, category: { type: 'string' } } },
  zana_storage_reviews: { ...obj, properties: { limit: { type: 'integer', minimum: 1, maximum: 100 },
    before: { type: 'integer', minimum: 1 } } },
  zana_mission_init: { ...obj, properties: { spec: { type: 'object' } }, required: ['spec'] },
  zana_mission_status: { ...obj, properties: {} },
  zana_next_batch: { ...obj, properties: { hostReport: { type: 'object' } } },
  zana_start_batch: { ...obj, properties: { hostReport: { type: 'object' } } },
  zana_complete_unit: { ...obj, properties: { unitId: { type: 'string' },
    token: { type: 'string' }, outcome: { type: 'object' } },
    required: ['unitId', 'token', 'outcome'] },
  zana_review_open: { ...obj, properties: { candidateSha: { type: 'string' },
    hostReport: { type: 'object' }, risk: { type: 'string' } }, required: ['candidateSha'] },
  zana_review_status: { ...obj, properties: {} },
  zana_review_next: { ...obj, properties: {} },
  zana_review_start: { ...obj, properties: {} },
  zana_review_submit: { ...obj, properties: { lensId: { type: 'string' },
    token: { type: 'string' }, candidateSha: { type: 'string' },
    verdict: { type: 'string' }, summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    findings: { type: 'array' }, execution: { type: 'string' },
    contextId: { type: 'string' } },
    required: ['lensId', 'token', 'candidateSha', 'verdict', 'summary', 'evidence'] },
  zana_review_check: { ...obj, properties: { observedSha: { type: 'string' } },
    required: ['observedSha'] },
};
const actions = {
  zana_profile: 'profile', zana_mission_init: 'init',
  zana_storage_status: 'storageStatus', zana_storage_history: 'storageHistory',
  zana_storage_reviews: 'storageReviews',
  zana_mission_status: 'status', zana_next_batch: 'next',
  zana_start_batch: 'start', zana_complete_unit: 'complete',
  zana_review_open: 'reviewOpen', zana_review_status: 'reviewStatus',
  zana_review_next: 'reviewNext', zana_review_start: 'reviewStart',
  zana_review_submit: 'reviewSubmit', zana_review_check: 'reviewCheckCandidate',
};
function send(id, result, error) {
  const msg = { jsonrpc: '2.0', id };
  if (error) msg.error = { code: -32603, message: error.message };
  else msg.result = result;
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
async function handle(message) {
  const { id, method, params = {} } = message;
  if (id === undefined || id === null) return; // Notifications have no response.
  try {
    if (method === 'initialize') return send(id, {
      protocolVersion: ['2025-11-25', '2024-11-05'].includes(params.protocolVersion)
        ? params.protocolVersion : '2025-11-25',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'zana-llaima', version: '0.1.0' },
    });
    if (method === 'ping') return send(id, {});
    if (method === 'tools/list') return send(id, { tools: Object.entries(schemas).map(([name, inputSchema]) =>
      ({ name, description: `Local autonomous execution: ${name}`, inputSchema })) });
    if (method === 'tools/call') {
      if (!Object.hasOwn(actions, params.name)) throw Error('Unknown tool');
      const result = await operations[actions[params.name]](params.arguments ?? {});
      return send(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
    }
    return send(id, null, { message: `Method not found: ${method}` });
  } catch (error) { return send(id, null, error); }
}
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (line.length > 1_048_576) continue;
  try {
    const message = JSON.parse(line);
    if (message && typeof message === 'object' && !Array.isArray(message)) await handle(message);
  } catch { /* Malformed input must not crash the local server. */ }
}
