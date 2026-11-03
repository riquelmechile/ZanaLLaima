import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transact, readState } from '../src/store.mjs';
import { createMission } from '../src/core.mjs';

const input = { objective: 'Inspect this project without modifying it',
  authorization: { writesAllowed: false, allowedPaths: [] },
  units: [{ id: 'scan', effect: 'READ', instruction: 'Inspect project files' }] };

test('persists a JSON mission and refuses existing lock or silent replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zana-'));
  const file = join(dir, 'data', 'state.json');
  try {
    assert.equal(await readState(file), null);
    const state = await transact(() => createMission(input), file);
    assert.equal((await readState(file)).id, state.id);
    await writeFile(`${file}.lock`, 'uncertain writer');
    await assert.rejects(transact(() => createMission(input), file), /locked/);
    assert.equal((await readFile(`${file}.lock`, 'utf8')), 'uncertain writer');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
