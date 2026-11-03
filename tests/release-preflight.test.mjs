import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assessBuildPolicy} from '../scripts/release-preflight.mjs';
const pkg=JSON.parse(readFileSync('package.json','utf8'));
const lock=JSON.parse(readFileSync('package-lock.json','utf8'));
const workflow=readFileSync('.github/workflows/ci.yml','utf8');
const assess=(extras={})=>assessBuildPolicy({pkg,lock,workflow,trackedFiles:[],...extras});

test('reproducible CI passes static checks without granting release',()=>{
  const result=assess();
  assert.deepEqual(result.errors,[]);
  assert.equal(result.passed,true);
  assert.equal(result.releaseAuthorized,false);
  assert.equal(result.externalGates.branchProtection,'NOT_VERIFIED');
  assert.equal(result.externalGates.hostExecutorEnforcement,'NOT_CONNECTED');
});
test('dependency drift invalidates build policy',()=>{
  const result=assess({pkg:{...pkg,dependencies:{...pkg.dependencies,zod:'9.9.9'}}});
  assert.equal(result.passed,false);
  assert.ok(result.errors.includes('LOCKFILE_DEPENDENCIES_MISMATCH'));
});
test('untrusted dependency tarball or integrity failure blocks static policy',()=>{
  const other=structuredClone(lock);
  const key=Object.keys(other.packages).find(x=>x.startsWith('node_modules/'));
  other.packages[key].integrity='sha1-placeholder';
  assert.ok(assess({lock:other}).errors.includes('UNVERIFIED_DEPENDENCY_IN_LOCKFILE'));
});
test('missing exact SHA, unpinned actions and unsafe event cannot pass',()=>{
  const altered=workflow.replace(/actions\/checkout@[a-f0-9]{40}/,'actions/checkout@v4')
    .replace('Verify exact commit','Trust PR checkout')
    .replace('  pull_request:','  pull_request_target:');
  const result=assess({workflow:altered});
  assert.equal(result.passed,false);
  assert.ok(result.errors.includes('UNSAFE_CI_EVENTS'));
  assert.ok(result.errors.includes('UNPINNED_CI_ACTION'));
  assert.ok(result.errors.includes('EXACT_SHA_GATE_MISSING'));
});
test('tracking a private key or .env is a hard failure',()=>{
  const result=assess({trackedFiles:['README.md','src/main.mjs','secrets/operator.key','.env.production']});
  assert.equal(result.passed,false);
  assert.ok(result.errors.includes('SENSITIVE_FILE_TRACKED'));
});

test('coverage thresholds and production audit cannot be silently removed',()=>{
  const weak={...pkg,scripts:{...pkg.scripts,'test:coverage':'node --test tests/*.test.mjs'}};
  assert.ok(assess({pkg:weak}).errors.includes('SOURCE_COVERAGE_THRESHOLD_MISSING'));
  const modified=workflow.replace('npm audit --omit=dev --audit-level=high','echo skipped audit');
  assert.ok(assess({workflow:modified}).errors.includes('STRESS_COVERAGE_OR_AUDIT_STEP_MISSING'));
});
