import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createPublicKey} from 'node:crypto';
import {assessBuildPolicy} from '../scripts/release-preflight.mjs';
const pkg=JSON.parse(readFileSync('package.json','utf8'));
const lock=JSON.parse(readFileSync('package-lock.json','utf8'));
const workflow=readFileSync('.github/workflows/ci.yml','utf8');
const coverage=readFileSync('scripts/check-source-coverage.mjs','utf8');
const assess=(extras={})=>assessBuildPolicy({
  pkg,lock,workflow,trackedFiles:[],
  sourceFiles:{coverage},
  ...extras
});

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

test('MCP enforcement gate only claims a local effect boundary when wiring and negative crash evidence exist',()=>{
  const sources={coverage,mcp:'zana_apply_write',actions:'applyWriteEffect',
    writer:'INTENT_DURABLE OUTCOME_UNKNOWN',tests:'crash between atomic effect'};
  assert.equal(assess({sourceFiles:sources}).externalGates.hostExecutorEnforcement,
    'MCP_EFFECT_BOUNDARY_ENFORCED');
  assert.equal(assess({sourceFiles:{...sources,mcp:''}}).externalGates.hostExecutorEnforcement,
    'NOT_CONNECTED');
  assert.equal(assess({sourceFiles:sources}).releaseAuthorized,false);
});

test('attestation job must depend on successful matrix with scoped secret and pinned upload',()=>{
  const modified=workflow.replace('environment: ci-attestation','environment: untrusted');
  assert.ok(assess({workflow:modified}).errors.includes('CI_ATTESTATION_JOB_UNSAFE'));
  const exposed=workflow.replace('github.event.pull_request.head.repo.full_name == github.repository','true');
  assert.ok(assess({workflow:exposed}).errors.includes('CI_ATTESTATION_JOB_UNSAFE'));
  const unsigned=workflow.replace('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02','actions/upload-artifact@v4');
  assert.ok(assess({workflow:unsigned}).errors.includes('UNPINNED_CI_ACTION'));
  assert.equal(assess().releaseAuthorized,false);
});


test('placeholder CI public key cannot masquerade as configured attestation',()=>{
  const placeholder=readFileSync('keys/ci-verifier.pub','utf8');
  assert.match(placeholder,/PENDIENTE DE ZANA/);
  const result=assess({sourceFiles:{coverage,ciPublicKey:placeholder}});
  assert.equal(result.externalGates.ciVerifierPublicKey,'MISSING_OR_INVALID');
  assert.equal(result.externalGates.trustedCIAttribution,'NOT_CONNECTED');
  assert.equal(result.releaseAuthorized,false);
  // Known RFC 8032 test-vector PUBLIC key only: no private material is loaded.
  const spkiHex='302a300506032b6570032100'+
    'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
  const validPublic=createPublicKey({
    key:Buffer.from(spkiHex,'hex'),format:'der',type:'spki',
  }).export({type:'spki',format:'pem'});
  const publicOnly=assess({sourceFiles:{coverage,ciPublicKey:validPublic}});
  assert.equal(publicOnly.externalGates.ciVerifierPublicKey,'FORMAT_VALID_NOT_ATTESTED');
  assert.equal(publicOnly.externalGates.trustedCIAttribution,'NOT_CONNECTED');
  assert.equal(publicOnly.releaseAuthorized,false);
});
