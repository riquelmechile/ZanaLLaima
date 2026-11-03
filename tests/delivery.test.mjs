import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createMission } from '../src/core.mjs';
import { openReview,startReviewBatch,submitReview } from '../src/review.mjs';
import { deliveryGate } from '../src/delivery.mjs';

const sha=n=>n.toString(16).padStart(40,'0');
const git={
  assurance:'LOCAL_GIT_OBSERVED',repoRoot:'/tmp/local-repo',clean:true,
  candidateSha:sha(10),treeSha:sha(11),baseSha:sha(12),
  branchRef:'refs/heads/feature',targetRef:'refs/heads/main',
  observedAt:new Date().toISOString()
};
function mission(){
  const m=createMission({objective:'Produce an exact reviewed release candidate',
    authorization:{writesAllowed:false,allowedPaths:[]},
    units:[{id:'verify',effect:'READ',instruction:'Verify exact Git candidate'}]});
  m.units[0].status='DONE';
  openReview(m,{candidateSha:git.candidateSha,gitEvidence:git});
  for(let i=0;i<4;i++){
    const p=startReviewBatch(m).packets[0];
    submitReview(m,{lensId:p.lensId,token:p.token,candidateSha:p.candidateSha,
      verdict:'PASS',summary:'Checked code for the frozen candidate',
      evidence:['Inspected exact committed source and checks'],execution:'SELF_CONTEXT'});
  }
  return m;
}
function setup(m){
  const ci=generateKeyPairSync('ed25519');
  const operator=generateKeyPairSync('ed25519');
  const now=Date.now();
  const dates={issuedAt:new Date(now).toISOString(),
    expiresAt:new Date(now+600000).toISOString()};
  const ciPayload={kind:'CI_RESULT',candidateSha:git.candidateSha,
    treeSha:git.treeSha,baseSha:git.baseSha,branchRef:git.branchRef,
    targetRef:git.targetRef,conclusion:'success',runId:40001,...dates};
  const opPayload={kind:'APPROVE_REVIEW',candidateSha:git.candidateSha,
    treeSha:git.treeSha,baseSha:git.baseSha,missionId:m.id,
    reviewId:m.review.id,ciRunId:40001,decision:'ALLOW_MANUAL_RELEASE',
    ...dates};
  const envelope=(payload,key)=>({
    payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),key).toString('base64')
  });
  const ciEnvelope=envelope(ciPayload,ci.privateKey);
  const operatorEnvelope=envelope(opPayload,operator.privateKey);
  return {ci,operator,ciPayload,opPayload,envelope,ciEnvelope,operatorEnvelope,
    good:{ciKey:ci.publicKey,operatorKey:operator.publicKey,ciEnvelope,operatorEnvelope}};
}

test('without independently signed CI and operator attestations delivery stays blocked',()=>{
  const m=mission();
  const result=deliveryGate(m,git);
  assert.equal(result.readyForManualRelease,false);
  assert.equal(result.mergeAuthorized,false);
  assert.ok(result.reasons.includes('SIGNED_CI_EVIDENCE_MISSING_OR_INVALID'));
  assert.ok(result.reasons.includes('SIGNED_OPERATOR_APPROVAL_MISSING_OR_INVALID'));
});

test('valid separate signatures permit manual consideration but never automatic merge',()=>{
  const m=mission();
  const v=setup(m);
  const result=deliveryGate(m,git,v.good);
  assert.equal(result.state,'READY_FOR_MANUAL_RELEASE');
  assert.equal(result.readyForManualRelease,true);
  assert.equal(result.mergeAuthorized,false);
  assert.equal(result.deploymentAuthorized,false);
  assert.equal(result.independentReviewVerified,false);
});

test('forged CI evidence, wrong run, wrong candidate and reused signer fail closed',()=>{
  const m=mission();
  const v=setup(m);
  const forged={...v.ciEnvelope,payload:{...v.ciPayload,conclusion:'success',runId:999}};
  let gate=deliveryGate(m,git,{...v.good,ciEnvelope:forged});
  assert.equal(gate.readyForManualRelease,false);
  assert.ok(gate.reasons.includes('SIGNED_CI_EVIDENCE_MISSING_OR_INVALID'));
  const wrongOp=v.envelope({...v.opPayload,ciRunId:5},v.operator.privateKey);
  gate=deliveryGate(m,git,{...v.good,operatorEnvelope:wrongOp});
  assert.equal(gate.readyForManualRelease,false);
  assert.ok(gate.reasons.includes('SIGNED_OPERATOR_APPROVAL_MISSING_OR_INVALID'));
  gate=deliveryGate(m,{...git,candidateSha:sha(88) },v.good);
  assert.equal(gate.readyForManualRelease,false);
  assert.ok(gate.reasons.includes('GIT_SNAPSHOT_CHANGED_OR_UNVERIFIED'));
  gate=deliveryGate(m,git,{...v.good,operatorKey:v.ci.publicKey});
  assert.equal(gate.readyForManualRelease,false);
  assert.ok(gate.reasons.includes('INDEPENDENT_SIGNER_KEYS_REQUIRED'));
});

test('expired approvals and CI evidence do not permit release',()=>{
  const m=mission();
  const v=setup(m);
  const expired={...v.opPayload,issuedAt:new Date(Date.now()-200000).toISOString(),
    expiresAt:new Date(Date.now()-100000).toISOString()};
  const sig=v.envelope(expired,v.operator.privateKey);
  const result=deliveryGate(m,git,{...v.good,operatorEnvelope:sig});
  assert.equal(result.readyForManualRelease,false);
  assert.ok(result.reasons.includes('SIGNED_OPERATOR_APPROVAL_MISSING_OR_INVALID'));
});

test('review findings and incomplete contexts block even with both signatures',()=>{
  const m=mission();
  const v=setup(m);
  m.review.lenses[0].result.findings=[{severity:'HIGH',description:'Missing authorization gate'}];
  let result=deliveryGate(m,git,v.good);
  assert.equal(result.readyForManualRelease,false);
  assert.ok(result.reasons.includes('BLOCKING_FINDINGS'));
  m.review.lenses[0].state='PENDING';
  result=deliveryGate(m,git,v.good);
  assert.equal(result.readyForManualRelease,false);
  assert.ok(result.reasons.includes('REVIEW_INCOMPLETE_OR_FAILED'));
});
