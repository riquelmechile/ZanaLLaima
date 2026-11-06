import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';

const ci=readFileSync('.github/workflows/ci.yml','utf8');
const attestation=existsSync('.github/workflows/ci-attestation.yml')
  ?readFileSync('.github/workflows/ci-attestation.yml','utf8'):'';
const setup=readFileSync('scripts/setup-ci-signing.sh','utf8');

test('CRITICAL C1: no PR-controlled CI job can access signing secret',()=>{
  assert.doesNotMatch(ci,/ZANA_CI_SIGNING_KEY/,
    'The PR workflow cannot host the signing secret');
  assert.match(attestation,/workflow_run:\s*\n\s*workflows:\s*\['CI'\]/,
    'The signer must use a trusted workflow_run on the protected default branch');
  assert.match(attestation,/environment:\s*ci-attestation/,
    'A protected environment is mandatory for signing');
  assert.match(attestation,/github\.ref == 'refs\/heads\/main'/,
    'The trusted signer is deployed only from main');
  assert.match(attestation,/github\.event\.workflow_run\.conclusion\s*==\s*'success'/);
  assert.doesNotMatch(attestation,/npm ci|pull_request\.head\.sha/,
    'Signer must never install or execute PR-controlled code');
});
test('CRITICAL C1: signing setup requires an independent reviewer and main-only deploy policy',()=>{
  assert.match(setup,/required.reviewer|reviewers\[[0-9]+\]\[id\]/i);
  assert.doesNotMatch(setup,/for branch in main "\$PR_BRANCH"|refs\/pull\/1\/merge/,
    'Environment must not permit PR branches or synthetic PR merge refs');
  assert.match(setup,/\[\[ "\$verified" == main \]\]/,
    'Only main can run the trusted signing workflow');
});
