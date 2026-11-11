import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRepoChecks,checksForRepo} from '../src/checks-policy.mjs';

const allow=['Owner/Node','owner/python'];
const policy={workflow:'node-ci.yml',requiredChecks:['test','lint']};
const input=JSON.stringify({'Owner/Node':policy,'owner/python':{workflow:'python-ci.yaml',requiredChecks:['pytest']}});
const fallback={checksWorkflow:'zana-checks.yml',requiredChecks:['test']};

test('admite dos repositorios con workflows y jobs distintos',()=>{
  const config={...fallback,repoChecks:parseRepoChecks(input,allow)};
  assert.deepEqual(checksForRepo(config,'OWNER/NODE'),policy);
  assert.deepEqual(checksForRepo(config,'owner/PYTHON'),{workflow:'python-ci.yaml',requiredChecks:['pytest']});
  assert.deepEqual(checksForRepo(config,'otro/repo'),{workflow:'zana-checks.yml',requiredChecks:['test']});
  assert.ok(Object.isFrozen(config.repoChecks['owner/node']));
  assert.ok(Object.isFrozen(config.repoChecks['owner/node'].requiredChecks));
});
test('sin overrides conserva CI global',()=>{
  assert.deepEqual(Object.keys(parseRepoChecks('',allow)),[]);
  assert.deepEqual(checksForRepo(fallback,'Owner/Node'),{workflow:'zana-checks.yml',requiredChecks:['test']});
});
test('rechaza JSON inválido y top-level distinto de objeto',()=>{
  for(const raw of ['{','[]','null','"hello"',42,' '.repeat(16001)])
    assert.throws(()=>parseRepoChecks(raw,allow),/INVALID_REPO_CHECKS/);
});
test('no permite configurar repos fuera de la allowlist ni repetirlos con distinta capitalización',()=>{
  assert.throws(()=>parseRepoChecks(JSON.stringify({'other/repo':policy}),allow),/INVALID_REPO_CHECKS/);
  assert.throws(()=>parseRepoChecks(JSON.stringify({'OWNER/NODE':policy,'owner/node':policy}),allow),/INVALID_REPO_CHECKS/);
  assert.throws(()=>parseRepoChecks(JSON.stringify({'../bad':policy}),allow),/INVALID_REPO_CHECKS/);
});
test('workflow y requiredChecks están estrictamente limitados',()=>{
  for(const invalid of [
    {...policy,workflow:'../foo.yml'}, {...policy,workflow:'ci.sh'},
    {...policy,requiredChecks:[]}, {...policy,requiredChecks:['ok','ok']},
    {...policy,requiredChecks:[' ok']}, {...policy,requiredChecks:['a\n']},
    {...policy,unknown:'x'}, {...policy,requiredChecks:['x'.repeat(121)]}])
    assert.throws(()=>parseRepoChecks(JSON.stringify({'Owner/Node':invalid}),allow),/INVALID_REPO_CHECKS/);
});
