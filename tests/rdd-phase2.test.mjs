import test from 'node:test';
import assert from 'node:assert/strict';
import { createMission } from '../src/core.mjs';
import { openReview,reviewStatus,nextReviewBatch,startReviewBatch,
  submitReview,checkCandidate } from '../src/review.mjs';

const sha=n=>n.toString(16).padStart(40,'0');
const fakeGit=n=>({assurance:'LOCAL_GIT_OBSERVED',repoRoot:'/tmp/verified-repo',
  clean:true,candidateSha:sha(n),treeSha:sha(100+n),branchRef:'refs/heads/review',
  targetRef:'refs/heads/main',baseSha:sha(200),observedAt:new Date().toISOString()});
function prepared(){
  const m=createMission({objective:'Review candidate safely',
    authorization:{writesAllowed:false,allowedPaths:[]},
    units:[{id:'scan',effect:'READ',instruction:'Inspect a source candidate'}]});
  m.units[0].status='DONE';return m;
}
const result=(p,execution=p.execution,contextId)=>({
  lensId:p.lensId,token:p.token,candidateSha:p.candidateSha,execution,
  verdict:'PASS',summary:'Checked candidate code and invariants',
  evidence:['Verified code paths and test results'],
  findings:[],...(contextId?{contextId}:{})
});

test('native batch size respects 1, 2 and 4 reported capacity',()=>{
  for(const width of [1,2,4]){
    const m=prepared();
    const host={model:'gpt-6-astra',reasoningEffort:'max',
      nativeSubagents:{available:true,maxConcurrent:width}};
    openReview(m,{candidateSha:sha(3),hostReport:host});
    assert.equal(nextReviewBatch(m).lenses.length,width);
    const batch=startReviewBatch(m);
    assert.equal(batch.packets.length,width);
    assert.equal(batch.actualNativeLaunches,'NOT_OBSERVED');
    batch.packets.forEach((p,i)=>submitReview(m,result(p,'NATIVE_SUBAGENT','ctx-'+i)));
    assert.equal(reviewStatus(m).approved,false);
  }
});

test('loss of native contexts falls back to solo with honest mixed provenance',()=>{
  const m=prepared();
  openReview(m,{candidateSha:sha(4),hostReport:{
    nativeSubagents:{available:true,maxConcurrent:2}
  }});
  const first=startReviewBatch(m).packets;
  first.forEach((p,i)=>submitReview(m,result(p,'NATIVE_SUBAGENT','native-'+i)));
  const absent={nativeSubagents:{available:false,maxConcurrent:0}};
  assert.equal(nextReviewBatch(m,absent).lenses.length,1);
  const solo=startReviewBatch(m,absent);
  assert.equal(solo.mode,'SOLO_SEQUENTIAL');
  assert.equal(solo.packets[0].execution,'SELF_CONTEXT');
  assert.throws(()=>submitReview(m,result(solo.packets[0],'NATIVE_SUBAGENT','pretend')),/provenance/);
  submitReview(m,result(solo.packets[0]));
  submitReview(m,result(startReviewBatch(m).packets[0]));
  const status=reviewStatus(m);
  assert.equal(status.gate,'MIXED_CONTEXTS_SELF_CHECK_UNVERIFIED');
  assert.equal(status.independentReviewVerified,false);
  assert.equal(status.maxParallel,1);
});

test('capacity reduction never overbooks and model mismatch blocks review launch',()=>{
  const m=prepared();
  openReview(m,{candidateSha:sha(5),hostReport:{
    nativeSubagents:{available:true,maxConcurrent:4}
  }});
  const report={nativeSubagents:{available:true,maxConcurrent:1}};
  assert.equal(nextReviewBatch(m,report).lenses.length,1);
  assert.equal(startReviewBatch(m,report).packets.length,1);
  assert.equal(nextReviewBatch(m,{model:'other'}).mode,'WAITING');
  const p=m.review.lenses.find(x=>x.state==='RUNNING');
  submitReview(m,{lensId:p.id,token:p.run.token,candidateSha:sha(5),
    verdict:'PASS',summary:'Checked verified candidate',evidence:['Reviewed tests'],
    execution:'NATIVE_SUBAGENT',contextId:'one'});
  assert.equal(nextReviewBatch(m,{model:'other'}).mode,'BLOCKED');
});

test('candidate drift invalidates all pending packets and dirty tree counts as drift',()=>{
  const m=prepared();const git=fakeGit(8);
  openReview(m,{candidateSha:git.candidateSha,gitEvidence:git});
  const packet=startReviewBatch(m).packets[0];
  const dirty={...git,clean:false};
  assert.equal(checkCandidate(m,git.candidateSha,dirty).gate,'INVALIDATED_CANDIDATE');
  assert.equal(m.review.lenses[0].state,'INVALIDATED');
  assert.throws(()=>submitReview(m,result(packet)),/No active review/);
  assert.equal(reviewStatus(m).approved,false);
});

test('correction cycles are bounded and reject changes with running reviewers',()=>{
  const m=prepared();
  for(let i=1;i<=5;i++){
    const git=fakeGit(i);
    openReview(m,{candidateSha:git.candidateSha,gitEvidence:git});
    const p=startReviewBatch(m).packets[0];
    if(i<5)assert.throws(()=>openReview(m,{candidateSha:sha(i+1),gitEvidence:fakeGit(i+1)}),
      /active packets/);
    checkCandidate(m,sha(i+20),{...git,candidateSha:sha(i+20)});
    assert.throws(()=>submitReview(m,result(p)),/No active review/);
  }
  assert.equal(m.reviewCount,5);
  assert.throws(()=>openReview(m,{candidateSha:sha(9),gitEvidence:fakeGit(9)}),
    /correction limit/);
});

test('blocking finding cannot yield PASS and review does not approve any release',()=>{
  const m=prepared();
  openReview(m,{candidateSha:sha(50)});
  const packet=startReviewBatch(m).packets[0];
  const finding={severity:'BLOCKER',description:'Trusted execution boundary missing'};
  assert.throws(()=>submitReview(m,{...result(packet),findings:[finding]}),/PASS/);
  submitReview(m,{...result(packet),verdict:'CHANGES',findings:[finding]});
  for(let i=0;i<3;i++)submitReview(m,result(startReviewBatch(m).packets[0]));
  assert.equal(reviewStatus(m).gate,'CHANGES_REQUIRED');
  assert.equal(reviewStatus(m).approved,false);
});
