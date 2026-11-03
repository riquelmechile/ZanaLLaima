#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { operations } from './actions.mjs';

const [command, ...args] = process.argv.slice(2);
const usage = 'Commands: storage-status, storage-history, storage-reviews, storage-migrate, storage-backup, storage-restore, profile, init, status, next, start, complete, review-open, review-next, review-start, review-submit, review-check, review-status';
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
try {
  let input = {};
  if (command === 'init') input = { spec: await readJson(args[0]) };
  else if (command === 'next' || command === 'start') input = { hostReport: args[0] ? await readJson(args[0]) : {} };
  else if (command === 'complete') input = { unitId: args[0], token: args[1], outcome: await readJson(args[2]) };
  else if (command === 'review-open') input = { candidateSha: args[0],
    hostReport: args[1] ? await readJson(args[1]) : {}, risk: args[2] || 'MEDIUM' };
  else if (command === 'review-submit') input = { ...(await readJson(args[3])),
    lensId: args[0], token: args[1], candidateSha: args[2] };
  else if (command === 'review-check') input = { observedSha: args[0] };
  else if (command === 'storage-history' || command === 'storage-reviews') input = {
    limit: args[0] ? Number(args[0]) : 25, before: args[1] ? Number(args[1]) : null,
    ...(command === 'storage-history' && args[2] ? { category: args[2] } : {})
  };
  else if (command === 'storage-backup') input = { destination: args[0] };
  else if (command === 'storage-restore') input = { source: args[0], offline: true };
  else if (!['status', 'profile', 'review-status', 'review-next', 'review-start', 'storage-status', 'storage-migrate'].includes(command)) throw Error(usage);
  const aliases = { 'review-open': 'reviewOpen', 'review-submit': 'reviewSubmit',
    'review-check': 'reviewCheckCandidate', 'review-status': 'reviewStatus',
    'review-next': 'reviewNext', 'review-start': 'reviewStart',
    'storage-status': 'storageStatus', 'storage-history': 'storageHistory',
    'storage-reviews': 'storageReviews', 'storage-migrate': 'storageMigrate',
    'storage-backup': 'storageBackup', 'storage-restore': 'storageRestore' };
  process.stdout.write(`${JSON.stringify(await operations[aliases[command] ?? command](input), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 1;
}
