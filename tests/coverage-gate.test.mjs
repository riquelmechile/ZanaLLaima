import test from 'node:test';
import assert from 'node:assert/strict';
import {assessCoverageTable} from '../scripts/check-source-coverage.mjs';

const row=(file,pct)=>'# '+file+' | 94.00 | '+pct+' | 96.00 |';
const report=([a,b])=>['# tests 2','# pass 2','# fail 0',
  '# start of coverage report',row('actions.mjs',a),row('core.mjs',b),
  '# all files | 96.00 | 86.50 | 95.00 |',
  '# end of coverage report'].join('\n');

test('el gate por archivo exige cobertura real de cada módulo de src',()=>{
  const good=assessCoverageTable(report([80,100]),['actions.mjs','core.mjs']);
  assert.equal(good.passed,true);
  assert.equal(good.branches['actions.mjs'],80);
  assert.equal(assessCoverageTable(report([79.99,100]),
    ['actions.mjs','core.mjs']).passed,false);
});

test('un archivo omitido, test fallido o resumen ausente bloquean cobertura',()=>{
  const missing=assessCoverageTable(report([90,95]),['actions.mjs','core.mjs','other.mjs']);
  assert.ok(missing.problems.some(x=>x.includes('Missing production source')));
  assert.equal(assessCoverageTable(report([90,95]).replace('# fail 0','# fail 1'),
    ['actions.mjs','core.mjs']).passed,false);
  assert.equal(assessCoverageTable(report([90,95]).replace('# all files','not a summary'),
    ['actions.mjs','core.mjs']).passed,false);
});
