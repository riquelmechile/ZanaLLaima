import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const statePath = () => resolve(process.env.ZANA_STATE_FILE || '.zana/state.json');

export async function readState(file = statePath()) {
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    if (state?.schema !== 1 || !Array.isArray(state.units)) throw Error('Unsupported state format');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// One writer at a time. The lock is intentionally not auto-reclaimed: an
// uncertain process failure requires operator reconciliation, not blind replay.
export async function transact(change, file = statePath()) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const lockFile = `${file}.lock`;
  let lock;
  try { lock = await open(lockFile, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw Error('State is locked; reconcile the existing writer first');
    throw error;
  }
  try {
    const previous = await readState(file);
    const updated = await change(previous);
    if (!updated || updated.schema !== 1) throw Error('Invalid next state');
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temp, file);
    } finally { await rm(temp, { force: true }); }
    return updated;
  } finally { await lock.close(); await rm(lockFile, { force: true }); }
}
