import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {operations} from '../src/actions.mjs';
import {readState,readReviewArchive,transact} from '../src/store.mjs';
import {createMission} from '../src/core.mjs';
import {openReview} from '../src/review.mjs';

async function fixture(budget={}){
  const dir=await mkdtemp(join(tmpdir(),'zana-review-base-reopen-'));
  const repo=join(dir,'repo');await mkdir(repo);
  const file=join(dir,'state.json');
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
  git('init','-q','-b','main');git('config','user.name','Review Test');
  git('config','user.email','review@example.invalid');
  await writeFile(join(repo,'README.md'),'base');
  git('add','README.md');git('commit','-qm','base');
  const originalBase=git('rev-parse','HEAD');
  git('checkout','-qb','feature/test');
  await writeFile(join(repo,'FEATURE.md'),'feature');
  git('add','FEATURE.md');git('commit','-qm','feature');
  const featureSha=git('rev-parse','HEAD');
  const old={state:process.env.ZANA_STATE_FILE,repo:process.env.ZANA_REVIEW_REPO,
    target:process.env.ZANA_REVIEW_TARGET_REF};
  Object.assign(process.env,{ZANA_STATE_FILE:file,ZANA_REVIEW_REPO:repo,
    ZANA_REVIEW_TARGET_REF:'refs/heads/main'});
  await operations.init({spec:{
    objective:'Review base-ref changes without fabricating feature commits',
    authorization:{writesAllowed:false,allowedPaths:[]},budget,
    units:[{id:'scan',effect:'READ',instruction:'Inspect feature and base'}],
  }});
  const p=(await operations.start()).packets[0];
  await operations.complete({unitId:p.unitId,token:p.token,
    leaseGeneration:p.leaseGeneration,
    outcome:{success:true,summary:'Reviewed exact fixture Git commits',
      evidence:['Observed feature SHA and original target base']}});
  return {dir,repo,file,git,featureSha,originalBase,
    advanceBase:async()=>{
      git('checkout','-q','main');
      await writeFile(join(repo,'BASE-CHANGED.md'),'target advanced');
      git('add','BASE-CHANGED.md');git('commit','-qm','advance target without changing feature');
      const nextBase=git('rev-parse','HEAD');
      git('checkout','-q','feature/test');
      assert.equal(git('rev-parse','HEAD'),featureSha);
      return nextBase;
    },
    cleanup:async()=>{
      for(const [k,v] of Object.entries({
        ZANA_STATE_FILE:old.state,ZANA_REVIEW_REPO:old.repo,
        ZANA_REVIEW_TARGET_REF:old.target})){
        if(v===undefined)delete process.env[k];else process.env[k]=v;
      }
      await rm(dir,{recursive:true,force:true});
    }};
}

test('advanced main invalidates review and permits same feature SHA in a new archived round',async()=>{
  const f=await fixture();
  try{
    const first=await operations.reviewOpen({candidateSha:f.featureSha});
    assert.equal(first.round,1);
    await assert.rejects(operations.reviewOpen({candidateSha:f.featureSha}),
      /Review already exists for this candidate/);
    const changedBase=await f.advanceBase();
    assert.notEqual(changedBase,f.originalBase);
    const invalid=await operations.reviewCheckCandidate();
    assert.equal(invalid.gate,'INVALIDATED_CANDIDATE');
    assert.equal(invalid.state,'INVALIDATED');
    const reopened=await operations.reviewOpen({candidateSha:f.featureSha});
    assert.equal(reopened.candidateSha,f.featureSha);
    assert.equal(reopened.round,2);
    assert.notEqual(reopened.reviewId,first.reviewId);
    const stored=await readState(f.file);
    assert.equal(stored.reviewCount,2);
    assert.equal(stored.review.gitEvidence.baseSha,changedBase);
    const archive=await readReviewArchive({limit:10},f.file);
    assert.equal(archive.items.length,1);
    assert.equal(archive.items[0].review.id,first.reviewId);
    assert.equal(archive.items[0].review.gitEvidence.baseSha,f.originalBase);
    assert.equal(archive.items[0].review.state,'INVALIDATED');
  }finally{await f.cleanup();}
});

test('manually invalidated review cannot reopen same candidate on identical Git snapshot',async()=>{
  const f=await fixture();
  try{
    const first=await operations.reviewOpen({candidateSha:f.featureSha});
    await transact(m=>{m.review.state='INVALIDATED';m.revision++;return m;},f.file);
    await assert.rejects(operations.reviewOpen({candidateSha:f.featureSha}),
      /only an invalidated and changed Git snapshot/);
    const state=await readState(f.file);
    assert.equal(state.review.id,first.reviewId);
    assert.equal(state.reviewCount,1);
  }finally{await f.cleanup();}
});

test('same SHA invalidated base change cannot bypass maxReviewRounds',async()=>{
  const f=await fixture({maxReviewRounds:1});
  try{
    const first=await operations.reviewOpen({candidateSha:f.featureSha});
    await f.advanceBase();
    const invalid=await operations.reviewCheckCandidate();
    assert.equal(invalid.gate,'INVALIDATED_CANDIDATE');
    await assert.rejects(operations.reviewOpen({candidateSha:f.featureSha}),
      /correction limit reached/);
    const current=await readState(f.file);
    assert.equal(current.reviewCount,1);
    assert.equal(current.review.id,first.reviewId);
    assert.equal(current.review.state,'INVALIDATED');
  }finally{await f.cleanup();}
});

test('synthetic review fixture permits same SHA only for invalidated changed target or tree',()=>{
  const sha='a'.repeat(40);
  const evidence={assurance:'LOCAL_GIT_OBSERVED',clean:true,candidateSha:sha,
    treeSha:'b'.repeat(40),baseSha:'c'.repeat(40),
    targetRef:'refs/heads/main',branchRef:'refs/heads/feature'};
  for(const field of ['baseSha','targetRef','treeSha']){
    const m=createMission({objective:'Synthetic Git boundary state transition test',
      authorization:{writesAllowed:false,allowedPaths:[]},
      units:[{id:'read',effect:'READ',instruction:'Check synthetic snapshot semantics'}]});
    m.units[0].status='DONE';
    const first=openReview(m,{candidateSha:sha,gitEvidence:evidence});
    m.review.state='INVALIDATED';
    const changed={...evidence,[field]:field==='targetRef'?'refs/heads/develop':'d'.repeat(40)};
    const reopened=openReview(m,{candidateSha:sha,gitEvidence:changed});
    assert.equal(reopened.round,2);
    assert.notEqual(reopened.reviewId,first.reviewId);
  }
});
