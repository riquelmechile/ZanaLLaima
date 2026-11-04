import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify,sign} from 'node:crypto';
import {buildCiPayload,signCiPayload} from '../scripts/ci-attest.mjs';
import {deliveryGate} from '../src/delivery.mjs';
import {createMission} from '../src/core.mjs';
import {openReview,startReviewBatch,submitReview} from '../src/review.mjs';

const sha=c=>c.repeat(40);
const base={candidateSha:sha('a'),treeSha:sha('b'),baseSha:sha('c'),
  branchRef:'refs/heads/feature',targetRef:'refs/heads/main',runId:4321};
const keypair=()=>generateKeyPairSync('ed25519');
test('CI signing requires explicit private Ed25519 key and yields verifiable signature',()=>{
  const payload=buildCiPayload(base);
  assert.equal(payload.kind,'CI_RESULT');
  assert.equal(payload.conclusion,'success');
  assert.throws(()=>signCiPayload(payload,''),/ZANA_CI_SIGNING_KEY is missing/);
  const pair=keypair();
  const envelope=signCiPayload(payload,pair.privateKey.export({type:'pkcs8',format:'pem'}));
  assert.equal(verify(null,Buffer.from(JSON.stringify(payload)),pair.publicKey,
    Buffer.from(envelope.signature,'base64')),true);
  assert.equal(JSON.stringify(envelope).includes('BEGIN PRIVATE KEY'),false);
});
test('SHA, run zero, expiration >24 hours and incorrect refs fail closed',()=>{
  assert.throws(()=>buildCiPayload({...base,candidateSha:'bad'}),/SHAs/);
  assert.throws(()=>buildCiPayload({...base,runId:0}),/runId/);
  assert.throws(()=>buildCiPayload({...base,branchRef:'refs/tags/unsafe'}),/branch refs/);
  const now=Date.now();
  assert.throws(()=>buildCiPayload({...base,issuedAt:new Date(now).toISOString(),
    expiresAt:new Date(now+86400001).toISOString()}),/over-24h/);
});
test('actual CI envelope is accepted only for the exact reviewed candidate',()=>{
  const ci=keypair(),operator=keypair();
  const git={assurance:'LOCAL_GIT_OBSERVED',repoRoot:'/tmp/frozen-candidate',
    clean:true,candidateSha:base.candidateSha,treeSha:base.treeSha,baseSha:base.baseSha,
    branchRef:base.branchRef,targetRef:base.targetRef,observedAt:new Date().toISOString()};
  const mission=createMission({objective:'Review exact CI candidate',
    authorization:{writesAllowed:false,allowedPaths:[]},
    units:[{id:'inspect',effect:'READ',instruction:'Inspect committed sources'}]});
  mission.units[0].status='DONE';
  openReview(mission,{candidateSha:base.candidateSha,gitEvidence:git});
  for(let i=0;i<4;i++){
    const packet=startReviewBatch(mission).packets[0];
    submitReview(mission,{lensId:packet.lensId,token:packet.token,
      candidateSha:packet.candidateSha,verdict:'PASS',
      summary:'Inspected source and validated invariants',
      evidence:['Checked tests and source against exact commit']});
  }
  const payload=buildCiPayload(base);
  const ciEnvelope=signCiPayload(payload,ci.privateKey.export({type:'pkcs8',format:'pem'}));
  const opPayload={kind:'APPROVE_REVIEW',candidateSha:base.candidateSha,
    treeSha:base.treeSha,baseSha:base.baseSha,missionId:mission.id,
    reviewId:mission.review.id,ciRunId:base.runId,decision:'ALLOW_MANUAL_RELEASE',
    issuedAt:payload.issuedAt,expiresAt:payload.expiresAt};
  const opEnv={payload:opPayload,signature:sign(null,
    Buffer.from(JSON.stringify(opPayload)),operator.privateKey).toString('base64')};
  const good=deliveryGate(mission,git,{ciEnvelope,operatorEnvelope:opEnv,
    ciKey:ci.publicKey,operatorKey:operator.publicKey});
  assert.equal(good.readyForManualRelease,true);
  assert.equal(good.mergeAuthorized,false);
  const bad=deliveryGate(mission,git,{ciEnvelope:{
    ...ciEnvelope,payload:{...payload,candidateSha:sha('d')}},operatorEnvelope:opEnv,
    ciKey:ci.publicKey,operatorKey:operator.publicKey});
  assert.equal(bad.readyForManualRelease,false);
});
