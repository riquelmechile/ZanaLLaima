import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('CLI persists review progress and invalidates changed candidate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zana-review-'));
  const state = join(dir, 'state.json');
  const repo = join(dir, 'code');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
  git('init','-q','-b','main');
  git('config','user.name','Local Verification');
  git('config','user.email','local@example.invalid');
  writeFileSync(join(repo,'README.md'),'original project');
  git('add','README.md');
  git('commit','-qm','bootstrap');
  git('checkout','-qb','feature/review');
  writeFileSync(join(repo,'README.md'),'first candidate');
  git('add','README.md');
  git('commit','-qm','candidate A');
  const shaA=git('rev-parse','HEAD');

  const json = (name, value) => {
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify(value));
    return file;
  };
  const run = (...args) => {
    const proc = spawnSync(process.execPath, ['src/cli.mjs', ...args], {
      cwd: process.cwd(), encoding: 'utf8',
      env: { ...process.env, ZANA_STATE_FILE: state, ZANA_REVIEW_REPO: repo },
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

    run('review-open', shaA);
    const reviewPacket = run('review-start').packets[0];
    const review = json('review.json', { verdict: 'PASS',
      summary: 'Confirmed the candidate review requirements',
      evidence: ['Reviewed the current source and relevant tests'], findings: [],
      execution: 'SELF_CONTEXT' });
    run('review-submit', reviewPacket.lensId, reviewPacket.token, shaA, review);
    assert.equal(run('review-status').lenses[0].state, 'DONE');
    writeFileSync(join(repo,'README.md'),'second candidate');
    git('add','README.md');
    git('commit','-qm','candidate B');
    const shaB=git('rev-parse','HEAD');
    assert.notEqual(shaA,shaB);
    assert.equal(run('review-check').gate, 'INVALIDATED_CANDIDATE');
    assert.equal(run('review-status').approved, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
