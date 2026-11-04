#!/usr/bin/env node
// Fail closed if a production source file falls below 80% branch coverage.
// Node's own test runner still enforces 92/85/90 global coverage thresholds.
import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {resolve} from 'node:path';
const args=[
  '--experimental-test-coverage',
  '--test-coverage-include=src/*.mjs',
  '--test-coverage-lines=92',
  '--test-coverage-branches=85',
  '--test-coverage-functions=90',
  '--test',
  ...readdirSync('tests').filter(x=>x.endsWith('.test.mjs')).sort().map(x=>'tests/'+x),
];
export function assessCoverageTable(report, files){
  const matches=[...report.matchAll(/^#\s+([a-z0-9][\w.-]*\.mjs)\s*\|\s*[\d.]+\s*\|\s*([\d.]+)\s*\|/gmi)];
  const observed=new Map(matches.map(x=>[x[1],Number(x[2])]));
  const problems=[];
  if(!/^# fail 0\s*$/m.test(report))problems.push('Test report has failed or missing test summary');
  for(const file of files){
    const pct=observed.get(file);
    if(pct===undefined)problems.push('Missing production source in coverage report: '+file);
    else if(!Number.isFinite(pct)||pct<80)
      problems.push(file+' has '+pct+'% branch coverage (minimum 80%)');
  }
  if(!/^# all files\s*\|/m.test(report))
    problems.push('Global coverage summary missing');
  return {passed:problems.length===0,problems,branches:Object.fromEntries(observed)};
}
export function runCoverage(){
  const result=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:24*1024*1024});
  if(result.stdout)process.stdout.write(result.stdout);
  if(result.stderr)process.stderr.write(result.stderr);
  if(result.error)throw result.error;
  const files=readdirSync('src').filter(x=>x.endsWith('.mjs'));
  const gate=assessCoverageTable(result.stdout||'',files);
  if(result.status!==0)gate.problems.push('Node coverage runner exited '+result.status);
  if(gate.problems.length)process.stderr.write(
    'PER_FILE_SOURCE_COVERAGE_FAILED\n'+gate.problems.join('\n')+'\n');
  else process.stdout.write(
    'PER_FILE_SOURCE_COVERAGE_PASSED: '+files.length+' source modules at or above 80% branch coverage\n');
  if(gate.problems.length)process.exitCode=1;
}
if(process.argv[1] && import.meta.url===new URL('file://'+resolve(process.argv[1])).href)
  runCoverage();
