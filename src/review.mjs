import { randomUUID } from 'node:crypto';
import { evaluateHost } from './core.mjs';
import { matchesReviewCandidate } from './git-evidence.mjs';

export const REVIEW_LENSES=Object.freeze([
  {id:'risk',title:'Risk and security',
    instruction:'Inspect authorization, trust boundaries, credentials, dangerous actions and data exposure. Identify blocking vulnerabilities and risky assumptions.'},
  {id:'reliability',title:'Correctness and reliability',
    instruction:'Inspect invariants, state transitions, inputs, error handling and test coverage. Reproduce plausible failures where tools allow.'},
  {id:'resilience',title:'Recovery and resilience',
    instruction:'Inspect crashes, races, stale claims, restarts, retries, idempotency and rollback. Identify unsafe recovery paths.'},
  {id:'readability',title:'Maintainability and clarity',
    instruction:'Inspect design simplicity, contracts, naming, documentation and operational clarity. Highlight maintenance hazards.'},
]);
const insist=(ok,message)=>{if(!ok)throw Error(message);};
const SHA=/^[a-f0-9]{40}$/;
const MAX_VERIFIED_ROUNDS=5;
const stamp=()=>new Date().toISOString();
const validText=(x,max)=>typeof x==='string'&&x.trim().length>0&&x.length<=max;
const severities=new Set(['BLOCKER','CRITICAL','HIGH','MEDIUM','LOW']);
const blocking=new Set(['BLOCKER','CRITICAL','HIGH']);

export function openReview(mission,{candidateSha,hostReport={},risk='MEDIUM',gitEvidence=null}={}){
  insist(mission?.schema===1&&Array.isArray(mission.units),'An existing mission is required');
  insist((mission.status||'ACTIVE')==='ACTIVE','Mission must be active for review');
  insist(mission.units.length>0&&mission.units.every(x=>x.status==='DONE'),
    'All mission units must be completed successfully before review');
  insist(typeof candidateSha==='string'&&SHA.test(candidateSha),
    'Candidate must be an exact lowercase 40-character Git SHA');
  insist(['LOW','MEDIUM','HIGH'].includes(risk),'Invalid risk level');
  const host=evaluateHost(hostReport);
  insist(host.allowed,'The requested model or reasoning effort does not match this host report');
  if(gitEvidence){
    insist(gitEvidence.assurance==='LOCAL_GIT_OBSERVED'&&gitEvidence.clean===true&&
      gitEvidence.candidateSha===candidateSha&&SHA.test(gitEvidence.treeSha)&&
      SHA.test(gitEvidence.baseSha),'Candidate must have verified, clean local Git evidence');
    insist((mission.reviewCount||0)<MAX_VERIFIED_ROUNDS,
      'Verified review correction limit reached; operator intervention required');
  }
  const old=mission.review;
  if(old){
    insist(old.candidateSha!==candidateSha,
      'Review already exists for this candidate; resume instead of silently replacing its evidence');
    insist(!old.lenses.some(x=>x.state==='RUNNING'),'Resolve active packets before a new candidate');
    if(gitEvidence)insist(old.state==='INVALIDATED'||
      ['CHANGES_REQUIRED','SELF_CHECK_COMPLETE_UNVERIFIED','NATIVE_4R_REPORTED_UNVERIFIED',
       'MIXED_CONTEXTS_SELF_CHECK_UNVERIFIED'].includes(reviewStatus(mission).gate),
      'Finish or invalidate the previous review before opening a new candidate');
    (mission.reviewHistory??=[]).push(old);
  }
  const mode=host.executionMode==='HOST_NATIVE'?'NATIVE_PLANNED':'SOLO_SEQUENTIAL';
  mission.reviewCount=(mission.reviewCount||0)+1;
  mission.review={
    id:randomUUID(),candidateSha,mode,risk,state:'OPEN',round:mission.reviewCount,
    createdAt:stamp(),capabilityEvidence:host.capabilityEvidence,
    maxParallel:mode==='NATIVE_PLANNED'?host.maxParallel:1,
    gitEvidence,hostLaunchObserved:false,fallbackReason:null,
    lenses:REVIEW_LENSES.map(x=>({id:x.id,title:x.title,state:'PENDING',run:null,result:null})),
  };
  mission.revision+=1;
  return reviewStatus(mission);
}

export function reviewStatus(mission){
  const review=mission?.review;
  if(!review)return {state:'NOT_STARTED',gate:'NOT_STARTED',approved:false};
  const lenses=review.lenses.map(x=>{
    if(!x.result)return {id:x.id,state:x.state,result:null};
    const {packetToken,...safe}=x.result;
    return {id:x.id,state:x.state,result:safe};
  });
  const unfinished=review.lenses.some(x=>x.state!=='DONE');
  const objections=review.lenses.some(x=>x.result&&
    (x.result.verdict==='CHANGES'||x.result.findings.some(f=>blocking.has(f.severity))));
  const allNative=review.lenses.every(x=>x.result?.execution==='NATIVE_SUBAGENT');
  const gate=review.state==='INVALIDATED'?'INVALIDATED_CANDIDATE':
    unfinished?'REVIEW_IN_PROGRESS':objections?'CHANGES_REQUIRED':
    allNative?'NATIVE_4R_REPORTED_UNVERIFIED':
    review.lenses.some(x=>x.result?.execution==='NATIVE_SUBAGENT')?
      'MIXED_CONTEXTS_SELF_CHECK_UNVERIFIED':'SELF_CHECK_COMPLETE_UNVERIFIED';
  return {
    reviewId:review.id,candidateSha:review.candidateSha,mode:review.mode,
    round:review.round??1,maxParallel:review.maxParallel??1,
    risk:review.risk,state:review.state,gate,
    approved:false,independentReviewVerified:false,
    candidateVerifiedByGit:review.state==='OPEN'&&review.gitEvidence?.assurance==='LOCAL_GIT_OBSERVED',
    candidateGitCheckedAt:review.gitEvidence?.observedAt??null,
    hostModelVerified:false,capabilityEvidence:review.capabilityEvidence,
    fallbackReason:review.fallbackReason??null,lenses,
    instruction:gate==='CHANGES_REQUIRED'?
      'Fix findings, create a new Git commit, and open a fresh review. Never reuse old receipts.':
      gate==='INVALIDATED_CANDIDATE'?
        'Candidate changed or became dirty; all old packets are invalid.':
        gate==='REVIEW_IN_PROGRESS'?
          'Complete outstanding perspectives with actual evidence.':
          'Review evidence is not independent approval and does not authorize merge or deploy.',
  };
}

function choosePlan(review,hostReport){
  if(hostReport===undefined)return {
    mode:review.mode,max:review.mode==='NATIVE_PLANNED'?Math.min(4,review.maxParallel||1):1};
  const host=evaluateHost(hostReport);
  if(!host.allowed)return {mode:'BLOCKED',max:0,reason:'Required model or reasoning effort mismatch'};
  if(review.mode==='NATIVE_PLANNED'&&host.executionMode==='HOST_NATIVE')
    return {mode:'NATIVE_PLANNED',max:Math.max(1,Math.min(review.maxParallel||1,host.maxParallel,4))};
  return {mode:'SOLO_SEQUENTIAL',max:1,reason:'Native capability is unavailable or review is already solo'};
}

export function nextReviewBatch(mission,hostReport){
  const review=mission?.review;
  insist(review&&review.state==='OPEN','No active review');
  insist((mission.status||'ACTIVE')==='ACTIVE','Mission not active');
  const running=review.lenses.filter(x=>x.state==='RUNNING');
  if(running.length)return {mode:'WAITING',lenses:[],reason:'Finish outstanding review packets first'};
  const option=choosePlan(review,hostReport);
  if(option.mode==='BLOCKED')return {mode:'BLOCKED',lenses:[],reason:option.reason};
  const pending=review.lenses.filter(x=>x.state==='PENDING');
  return {
    mode:option.mode,candidateSha:review.candidateSha,
    maxParallel:option.max,lenses:pending.slice(0,option.max).map(x=>({
      id:x.id,title:x.title,
      instruction:REVIEW_LENSES.find(y=>y.id===x.id).instruction,
    })),hostLaunchObserved:false,independenceVerified:false,
    ...(option.reason?{reason:option.reason}:{}),
  };
}

export function startReviewBatch(mission,hostReport){
  const plan=nextReviewBatch(mission,hostReport);
  insist(plan.lenses.length>0,'No review lenses available');
  const review=mission.review;
  if(review.mode==='NATIVE_PLANNED'&&plan.mode==='SOLO_SEQUENTIAL'){
    review.mode='SOLO_SEQUENTIAL';
    review.maxParallel=1;
    review.fallbackReason='Native context capacity disappeared; remaining lenses are self-checks';
  }else review.maxParallel=plan.maxParallel;
  const packets=plan.lenses.map(x=>{
    const lens=review.lenses.find(l=>l.id===x.id);
    const token=randomUUID();
    lens.state='RUNNING';
    lens.run={token,issuedAt:stamp(),execution:plan.mode==='NATIVE_PLANNED'?
      'NATIVE_SUBAGENT':'SELF_CONTEXT'};
    return {reviewId:review.id,lensId:x.id,token,candidateSha:review.candidateSha,
      treeSha:review.gitEvidence?.treeSha??null,round:review.round??1,
      mode:plan.mode,execution:lens.run.execution,instruction:x.instruction,
      isolation:'Inspect frozen candidate in a separate context when truly available; do not share sibling review results.',
      expectedAssurance:'HOST_REPORTED_UNVERIFIED'};
  });
  mission.revision++;
  return {packets,mode:plan.mode,actualNativeLaunches:'NOT_OBSERVED',
    independentReviewVerified:false};
}

export function submitReview(mission,{lensId,token,candidateSha,verdict,summary,evidence,
  findings=[],execution='SELF_CONTEXT',contextId}={}){
  const review=mission?.review;
  insist(review?.state==='OPEN','No active review');
  insist(candidateSha===review.candidateSha,'Candidate SHA mismatch');
  const lens=review.lenses.find(x=>x.id===lensId);
  insist(lens?.state==='RUNNING'&&lens.run?.token===token,'Unknown or stale review packet');
  insist(verdict==='PASS'||verdict==='CHANGES','Invalid review verdict');
  insist(validText(summary,10000),'Provide a factual review summary');
  insist(Array.isArray(evidence)&&evidence.length>=1&&evidence.length<=20&&
    evidence.every(x=>validText(x,2000)),'Provide actual bounded review evidence');
  insist(Array.isArray(findings)&&findings.length<=30&&findings.every(x=>
    x&&severities.has(x.severity)&&validText(x.description,2000)&&
    (x.path===undefined||validText(x.path,240))),'Invalid findings');
  insist(verdict!=='PASS'||!findings.some(x=>blocking.has(x.severity)),
    'A PASS cannot contain blocking findings');
  const expected=lens.run.execution;
  insist(execution===expected,'Execution provenance contradicts the reserved review packet');
  if(expected==='NATIVE_SUBAGENT'){
    insist(validText(contextId,200),'Native review needs a host-reported context identifier');
    insist(!review.lenses.some(x=>x.id!==lensId&&x.result?.contextId===contextId),
      'Native review context must be distinct per lens');
  }else insist(contextId===undefined,'A self-review may not claim a separate context');
  lens.state='DONE';lens.run=null;
  lens.result={verdict,summary,evidence,findings,execution,packetToken:token,
    ...(contextId===undefined?{}:{contextId}),
    assurance:expected==='SELF_CONTEXT'?'SELF_REPORTED_UNVERIFIED':'HOST_REPORTED_UNVERIFIED',
    recordedAt:stamp()};
  mission.revision++;
  return reviewStatus(mission);
}

export function checkCandidate(mission,observedSha,observation=null){
  const review=mission?.review;
  insist(review,'No review exists');
  insist(typeof observedSha==='string'&&SHA.test(observedSha),
    'Observed candidate SHA must be exact');
  const matches=observedSha===review.candidateSha&&
    (!review.gitEvidence||matchesReviewCandidate(review,observation));
  if(review.state==='OPEN'&&!matches){
    review.state='INVALIDATED';
    review.invalidatedAt=stamp();
    review.observedSha=observedSha;
    review.invalidatedReason=observation?.clean===false?'DIRTY_WORKTREE':
      observedSha!==review.candidateSha?'SHA_CHANGED':'GIT_BOUNDARY_CHANGED';
    for(const lens of review.lenses){
      if(lens.state==='RUNNING'){lens.state='INVALIDATED';lens.run=null;}
    }
    mission.revision++;
  }
  return {...reviewStatus(mission),observedCandidate:observedSha,
    observationAssurance:observation?.assurance??'HOST_REPORTED_UNVERIFIED'};
}
