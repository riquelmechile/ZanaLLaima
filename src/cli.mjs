#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { operations } from './actions.mjs';

const [command, ...args] = process.argv.slice(2);
const usage = 'Usage: node src/cli.mjs profile | init <spec.json> | status | next [host.json] | start [host.json] | complete <unit-id> <run-token> <outcome.json>';
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
try {
  let input = {};
  if (command === 'init') input = { spec: await readJson(args[0]) };
  else if (command === 'next' || command === 'start') input = { hostReport: args[0] ? await readJson(args[0]) : {} };
  else if (command === 'complete') input = { unitId: args[0], token: args[1], outcome: await readJson(args[2]) };
  else if (command !== 'status' && command !== 'profile') throw Error(usage);
  process.stdout.write(`${JSON.stringify(await operations[command](input), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 1;
}
