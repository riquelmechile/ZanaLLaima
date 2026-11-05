import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify,sign} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildCiPayload,signCiPayload,githubRunContext} from '../scripts/ci-attest.mjs';
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

test('workflow_run trusted signer independently validates green CI evidence and exact PR SHA',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'zana-attest-'));
  const ci=readFileSync('.github/workflows/ci.yml');
  const runId=12345;
  const candidate='a'.repeat(40),base='b'.repeat(40),tree='c'.repeat(40);
  const eventPath=join(dir,'event.json');
  writeFileSync(eventPath,JSON.stringify({workflow_run:{id:runId,head_sha:candidate}}));
  const env={GITHUB_REPOSITORY:'riquelmechile/ZanaLLaima',
    GITHUB_EVENT_NAME:'workflow_run',GITHUB_REF:'refs/heads/main',
    GITHUB_EVENT_PATH:eventPath};
  const required=['Verify exact commit','Deterministic install','Syntax validation',
    'Static security preflight','Unit, integration, and crash tests',
    'Multi-process contention stress','Coverage gate',
    'Phase 4 measured SQLite and scheduler benchmark',
    'Production dependency vulnerability audit'];
  const run={id:runId,head_sha:candidate,status:'completed',conclusion:'success',
    event:'pull_request',path:'.github/workflows/ci.yml',
    repository:{full_name:'riquelmechile/ZanaLLaima'},
    head_repository:{full_name:'riquelmechile/ZanaLLaima'},
    pull_requests:[{number:1}]};
  const jobs={total_count:3,jobs:['22.16.0','22.23.4','24'].map(node=>({
    name:'test (Node '+node+')',status:'completed',conclusion:'success',
    steps:required.map(name=>({name,conclusion:'success'}))
  }))};
  const pr={state:'open',base:{ref:'main',sha:base},
    head:{sha:candidate,ref:'feature/review',
      repo:{full_name:'riquelmechile/ZanaLLaima'}}};
  const ciObject={encoding:'base64',content:ci.toString('base64')};
  const responses=[
    ['/actions/runs/',run],
    ['/jobs?per_page=100',jobs],
    ['/contents/.github/workflows/ci.yml',ciObject],
    ['/git/commits/',{tree:{sha:tree}}],
    ['/pulls/1',pr]
  ];
  const api=async path=>{
    const match=responses.find(([name])=>path.includes(name));
    assert.ok(match,'Unexpected API path: '+path);
    return match[1];
  };
  try{
    const payload=await githubRunContext(env,api);
    assert.equal(payload.candidateSha,candidate);
    assert.equal(payload.treeSha,tree);
    assert.equal(payload.baseSha,base);
    assert.equal(payload.runId,runId);
    await assert.rejects(githubRunContext(env,async path=>
      path.includes('/contents/.github/workflows/ci.yml')
        ? {...ciObject,content:Buffer.from('malicious CI').toString('base64')}
        : api(path)),/PR modified trusted CI workflow/);
    await assert.rejects(githubRunContext(env,async path=>
      path.includes('/jobs?per_page=100')
        ? {...jobs,total_count:2,jobs:jobs.jobs.slice(1)}:api(path)),
      /Required CI matrix/);
    await assert.rejects(githubRunContext(env,async path=>
      path.includes('/pulls/1')
        ? {...pr,head:{...pr.head,sha:'d'.repeat(40)}}:api(path)),
      /PR moved/);
    await assert.rejects(githubRunContext({...env,GITHUB_REF:'refs/heads/feature/review'},api),
      /restricted to trusted main/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
