import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {operations} from '../src/actions.mjs';
const evidence={success:true,summary:'Verified the exact local repository',
  evidence:['Confirmed the committed code and test fixture']};

async function setup(){
  const dir=await mkdtemp(join(tmpdir(),'zana-actions-'));
  const repo=join(dir,'repo'),file=join(dir,'state.json');
  await mkdir(repo);
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
  git('init','-q','-b','main');git('config','user.name','Integration Test');
  git('config','user.email','tests@example.invalid');
  await writeFile(join(repo,'README.md'),'base');
  git('add','README.md');git('commit','-qm','base');
  git('checkout','-qb','review/feature');
  await writeFile(join(repo,'README.md'),'candidate');
  git('add','README.md');git('commit','-qm','candidate');
  const previous={
    state:process.env.ZANA_STATE_FILE,repo:process.env.ZANA_REVIEW_REPO,
    target:process.env.ZANA_REVIEW_TARGET_REF,
  };
  Object.assign(process.env,{ZANA_STATE_FILE:file,ZANA_REVIEW_REPO:repo,
    ZANA_REVIEW_TARGET_REF:'refs/heads/main'});
  const spec={objective:'Exercise local action routing',
    authorization:{writesAllowed:false,allowedPaths:[]},
    units:[{id:'inspect',effect:'READ',instruction:'Inspect checked-out candidate'}]};
  return {dir,repo,file,spec,git,sha:()=>git('rev-parse','HEAD'),
    cleanup:async()=>{
      for(const [key,value] of Object.entries({
        ZANA_STATE_FILE:previous.state,ZANA_REVIEW_REPO:previous.repo,
        ZANA_REVIEW_TARGET_REF:previous.target})){
        if(value===undefined)delete process.env[key];else process.env[key]=value;
      }
      await rm(dir,{recursive:true,force:true});
    }};
}
test('action routing covers missing mission, initialization, read lease, retry and archive',async()=>{
  const f=await setup();
  try{
    await assert.rejects(operations.status(),/No mission/);
    await assert.rejects(operations.next(),/No mission/);
    await assert.rejects(operations.start(),/No mission/);
    await assert.rejects(operations.retry({unitId:'inspect'}),/No active mission/);
    await assert.rejects(operations.close(),/No active mission/);
    await assert.rejects(operations.cancel(),/No active mission/);
    await assert.rejects(operations.recoverExpired(),/No active mission/);
    assert.equal((await operations.profile()).assurance,'REQUESTED_ONLY');
    assert.equal((await operations.storageHistory()).items.length,0);
    assert.equal((await operations.storageReviews()).items.length,0);
    assert.equal((await operations.missionHistory()).items.length,0);
    assert.equal((await operations.authorizationStatus()).valid,false);
    await operations.init({spec:f.spec});
    await assert.rejects(operations.init({spec:f.spec}),/Mission exists/);
    assert.equal((await operations.status()).units.length,1);
    assert.equal((await operations.next()).units[0].id,'inspect');
    assert.equal((await operations.reviewStatus()).gate,'NOT_STARTED');
    await assert.rejects(operations.reviewNext(),/No active review/);
    await assert.rejects(operations.reviewStart(),/No active review/);
    await assert.rejects(operations.close(),/All units/);
    await assert.rejects(operations.archive(),/closed or cancelled/);
    const first=(await operations.start()).packets[0];
    assert.equal((await operations.storageStatus()).backend,'SQLITE_WAL');
    const heartbeat=await operations.heartbeat({unitId:'inspect',token:first.token,
      leaseGeneration:first.leaseGeneration,leaseSeconds:10});
    assert.ok(heartbeat.expiresAt);
    await assert.rejects(operations.complete({unitId:'inspect',token:'stale',
      leaseGeneration:first.leaseGeneration,outcome:evidence}),/stale/);
    await operations.complete({unitId:'inspect',token:first.token,
      leaseGeneration:first.leaseGeneration,outcome:{...evidence,success:false}});
    await operations.retry({unitId:'inspect'});
    const second=(await operations.start()).packets[0];
    await operations.complete({unitId:'inspect',token:second.token,
      leaseGeneration:second.leaseGeneration,outcome:evidence});
    assert.equal((await operations.status()).units[0].status,'DONE');
    assert.equal((await operations.storageHistory({limit:5})).items.length,5);
    await operations.close();
    await assert.rejects(operations.cancel(),/Mission not active/);
    const archived=await operations.archive();
    assert.equal(archived.archived,true);
    assert.equal((await operations.missionHistory()).items.length,1);
    await assert.rejects(operations.status(),/No mission/);
  }finally{await f.cleanup();}
});
test('full RDD action cycle uses actual Git checks and blocks unauthenticated delivery',async()=>{
  const f=await setup();
  try{
    await operations.init({spec:f.spec});
    const p=(await operations.start()).packets[0];
    await operations.complete({unitId:p.unitId,token:p.token,
      leaseGeneration:p.leaseGeneration,outcome:evidence});
    await assert.rejects(operations.reviewOpen({candidateSha:'a'.repeat(40)}),
      /differs from verified/);
    await writeFile(join(f.repo,'UNTRACKED.md'),'dirty');
    await assert.rejects(operations.reviewOpen(),/clean/);
    await unlink(join(f.repo,'UNTRACKED.md'));
    const opened=await operations.reviewOpen({candidateSha:f.sha()});
    assert.equal(opened.candidateVerifiedByGit,true);
    assert.equal((await operations.reviewNext()).lenses.length,1);
    for(const lens of ['risk','reliability','resilience','readability']){
      const reserved=(await operations.reviewStart()).packets[0];
      assert.equal(reserved.lensId,lens);
      const done=await operations.reviewSubmit({
        lensId:lens,token:reserved.token,candidateSha:f.sha(),
        verdict:'PASS',summary:'Inspected local candidate for '+lens,
        evidence:['Verified Git head and actual code content']});
      assert.equal(done.approved,false);
    }
    assert.equal((await operations.reviewStatus()).gate,'SELF_CHECK_COMPLETE_UNVERIFIED');
    assert.equal((await operations.reviewCheckCandidate()).gate,'SELF_CHECK_COMPLETE_UNVERIFIED');
    const delivery=await operations.deliveryCheck();
    assert.equal(delivery.readyForManualRelease,false);
    assert.ok(delivery.reasons.includes('SIGNED_CI_EVIDENCE_MISSING_OR_INVALID'));
  }finally{await f.cleanup();}
});
test('reviewStatus, reviewNext, reviewStart, reviewSubmit handle Git candidate drift',async()=>{
  for(const action of ['reviewStatus','reviewNext','reviewStart','reviewSubmit']){
    const f=await setup();
    try{
      await operations.init({spec:f.spec});
      const p=(await operations.start()).packets[0];
      await operations.complete({unitId:p.unitId,token:p.token,
        leaseGeneration:p.leaseGeneration,outcome:evidence});
      await operations.reviewOpen({candidateSha:f.sha()});
      const packet=(await operations.reviewStart()).packets[0];
      await writeFile(join(f.repo,'README.md'),'candidate changed');
      f.git('add','README.md');f.git('commit','-qm','new SHA');
      const args={lensId:packet.lensId,token:packet.token,candidateSha:packet.candidateSha,
        verdict:'PASS',summary:'This result must be invalidated',
        evidence:['Old candidate is no longer current']};
      const value=await operations[action](args);
      assert.equal(value.gate,'INVALIDATED_CANDIDATE',action);
    }finally{await f.cleanup();}
  }
});
