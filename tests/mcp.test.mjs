import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

test('MCP stdio handshake and native workflow tools are available', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zana-mcp-'));
  const child = spawn(process.execPath, ['src/mcp.mjs'], { cwd: process.cwd(),
    env: { ...process.env, ZANA_STATE_FILE: join(dir, 'state.json') }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const messages = [];
  lines.on('line', line => messages.push(JSON.parse(line)));
  const send = x => child.stdin.write(`${JSON.stringify(x)}\n`);
  const response = id => new Promise((resolve, reject) => {
    let tries = 0;
    const interval = setInterval(() => {
      const msg = messages.find(x => x.id === id);
      if (msg) { clearInterval(interval); resolve(msg); }
      else if (++tries > 100) { clearInterval(interval); reject(Error('MCP response timed out')); }
    }, 10);
  });
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
    assert.equal((await response(1)).result.serverInfo.name, 'zana-llaima');
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal((await response(2)).result.tools.length, 22);
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'zana_profile', arguments: {} } });
    assert.equal((await response(3)).result.structuredContent.requested.reasoningEffort, 'max');
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'zana_storage_status', arguments: {} } });
    assert.equal((await response(4)).result.structuredContent.backend, 'LEGACY_OR_EMPTY');
  } finally {
    child.stdin.end();
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
