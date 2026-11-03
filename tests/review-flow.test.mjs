import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('CLI persists review progress and invalidates changed candidate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zana-review-'));
  const state = join(dir, 'state.json');
  const json = (name, value) => {
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify(value));
    return file;
  };
  const run = (...args) => {
    const proc = spawnSync(process.execPath, ['src/cli.mjs', ...args], {
      cwd: process.cwd(), encoding: 'utf8',
      env: { ...process.env, ZANA_STATE_FILE: state },
    });
    assert.equal(proc.status, 0, proc.stderr);
    return JSON.parse(proc.stdout);
  };
  try {
    const mission = json('mission.json', { objective: 'Verify persistence and review',
      authorization: { writesAllowed: false, allowedPaths: [] },
      units: [{ id: 'scan', effect: 'READ', instruction: 'Inspect the codebase' }] });
    run('init', mission);
    const packet = run('start').packets[0];
    const outcome = json('outcome.json', { success: true, summary: 'Verified inspected files',
      evidence: ['Inspected the source and confirmed the requirement'] });
    run('complete', packet.unitId, packet.token, outcome);
