import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { matchesReviewCandidate } from './git-evidence.mjs';
import { reviewStatus } from './review.mjs';

const SHA=/^[a-f0-9]{40}$/;
const fail=message=>{throw new Error(message);};
const fingerprint=key=>createHash('sha256').update(
  key.export({type:'spki',format:'der'})).digest('hex');
export function readVerifierKey(path){
  if(typeof path!=='string'||!path.trim())return null;
  const key=createPublicKey(readFileSync(resolve(path),'utf8'));
  if(key.asymmetricKeyType!=='ed25519')fail('Attestation key must be Ed25519');
  return key;
}

function verifyEnvelope(envelope,key,kind,now=Date.now()){
  if(!key||!envelope||typeof envelope!=='object')return null;
  const p=envelope.payload;
  if(!p||typeof p!=='object'||Array.isArray(p)||p.kind!==kind)return null;
  if(typeof envelope.signature!=='string'||!(/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)))
    return null;
  const signature=Buffer.from(envelope.signature,'base64');
  if(signature.length!==64||signature.toString('base64')!==envelope.signature)return null;
  if(!verify(null,Buffer.from(JSON.stringify(p),'utf8'),key,signature))return null;
  if(!SHA.test(p.candidateSha)||!SHA.test(p.treeSha)||!SHA.test(p.baseSha))return null;
  const issued=Date.parse(p.issuedAt),expires=Date.parse(p.expiresAt);
  if(!Number.isFinite(issued)||!Number.isFinite(expires)||
     issued>now+60000||issued<now-86400000||expires<=now||expires<=issued||
     expires-issued>86400000)return null;
  return p;
}

export function deliveryGate(mission,observed,{ciEnvelope=null,operatorEnvelope=null,
  ciKey=null,operatorKey=null}={}){
  const review=mission?.review;
  const reasons=[];
  if(!review||review.state!=='OPEN')reasons.push('REVIEW_MISSING_OR_INVALIDATED');
  const reviewResult=reviewStatus(mission);
  if(reviewResult.gate==='CHANGES_REQUIRED')reasons.push('BLOCKING_FINDINGS');
  if(!review||review.lenses.some(x=>x.state!=='DONE'||x.result?.verdict!=='PASS'))
    reasons.push('REVIEW_INCOMPLETE_OR_FAILED');
  if(!review||!matchesReviewCandidate(review,observed))
    reasons.push('GIT_SNAPSHOT_CHANGED_OR_UNVERIFIED');
  if((mission?.status||'ACTIVE')!=='ACTIVE')reasons.push('MISSION_NOT_ACTIVE');
  const ci=verifyEnvelope(ciEnvelope,ciKey,'CI_RESULT');
  if(!ci||ci.conclusion!=='success'||!Number.isSafeInteger(ci.runId)||ci.runId<=0||
    !review||ci.candidateSha!==review.candidateSha||
    ci.treeSha!==review.gitEvidence?.treeSha||
    ci.baseSha!==review.gitEvidence?.baseSha||
    ci.branchRef!==review.gitEvidence?.branchRef||
    ci.targetRef!==review.gitEvidence?.targetRef)
    reasons.push('SIGNED_CI_EVIDENCE_MISSING_OR_INVALID');
  const approval=verifyEnvelope(operatorEnvelope,operatorKey,'APPROVE_REVIEW');
  if(!operatorKey||!ciKey||fingerprint(operatorKey)===fingerprint(ciKey))
    reasons.push('INDEPENDENT_SIGNER_KEYS_REQUIRED');
  if(!approval||!review||approval.missionId!==mission.id||
    approval.reviewId!==review.id||approval.candidateSha!==review.candidateSha||
    approval.treeSha!==review.gitEvidence?.treeSha||
    approval.baseSha!==review.gitEvidence?.baseSha||
    approval.ciRunId!==ci?.runId||approval.decision!=='ALLOW_MANUAL_RELEASE')
    reasons.push('SIGNED_OPERATOR_APPROVAL_MISSING_OR_INVALID');
  return {
    state:reasons.length?'BLOCKED':'READY_FOR_MANUAL_RELEASE',
    reasons,readyForManualRelease:reasons.length===0,
    mergeAuthorized:false,deploymentAuthorized:false,
    independentReviewVerified:false,hostModelVerified:false,
    ciAssurance:ci?'SIGNED_VERIFIER_ATTESTATION':'NONE',
    operatorAssurance:approval?'SIGNED_OPERATOR_ATTESTATION':'NONE',
    candidateSha:review?.candidateSha??null,
    reviewGate:reviewResult.gate,
    note:'A signed local attestation is not live GitHub CI verification. There is no automatic release action.',
  };
}
