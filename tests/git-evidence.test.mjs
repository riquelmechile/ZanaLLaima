import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,mkdirSync,rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { observeGit,matchesReviewCandidate } from '../src/git-evidence.mjs';

const fixture=()=>{
  const dir=mkdtempSync(join(tmpdir(),'zana-git-'));
  const repo=join(dir,'repo');
  mkdirSync(repo);
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
  git('init','-q','-b','main');
  git('config','user.name','Independent Test');
  git('config','user.email','tests@example.invalid');
  writeFileSync(join(repo,'README.md'),'baseline');
  git('add','README.md');
  git('commit','-qm','baseline');
  git('checkout','-qb','feature/review');
  writeFileSync(join(repo,'README.md'),'candidate');
  git('add','README.md');
  git('commit','-qm','candidate');
  return {dir,repo,git,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
};

test('local Git evidence records real HEAD tree, branch and target base',()=>{
  const f=fixture();
  try{
    const result=observeGit({repoPath:f.repo,targetRef:'refs/heads/main'});
    assert.equal(result.candidateSha,f.git('rev-parse','HEAD'));
    assert.equal(result.treeSha,f.git('rev-parse','HEAD^{tree}'));
    assert.equal(result.baseSha,f.git('rev-parse','main'));
    assert.equal(result.branchRef,'refs/heads/feature/review');
    assert.equal(result.clean,true);
    assert.equal(matchesReviewCandidate({candidateSha:result.candidateSha,gitEvidence:result},result),true);
  }finally{f.cleanup();}
});

test('untracked and staged changes invalidate clean candidate observation',()=>{
  const f=fixture();
  try{
    const frozen=observeGit({repoPath:f.repo});
    writeFileSync(join(f.repo,'UNTRACKED.md'),'not committed');
    const dirty=observeGit({repoPath:f.repo});
    assert.equal(dirty.candidateSha,frozen.candidateSha);
    assert.equal(dirty.clean,false);
    assert.equal(matchesReviewCandidate({candidateSha:frozen.candidateSha,gitEvidence:frozen},dirty),false);
    f.git('add','UNTRACKED.md');
    assert.equal(observeGit({repoPath:f.repo}).clean,false);
  }finally{f.cleanup();}
});

test('target base movement invalidates frozen review even when candidate HEAD is unchanged',()=>{
  const f=fixture();
  try{
    const frozen=observeGit({repoPath:f.repo});
    f.git('checkout','main');
    writeFileSync(join(f.repo,'README.md'),'new base');
    f.git('add','README.md');
    f.git('commit','-qm','base changed');
    f.git('checkout','feature/review');
    const current=observeGit({repoPath:f.repo});
    assert.equal(current.candidateSha,frozen.candidateSha);
    assert.notEqual(current.baseSha,frozen.baseSha);
    assert.equal(matchesReviewCandidate({candidateSha:frozen.candidateSha,gitEvidence:frozen},current),false);
  }finally{f.cleanup();}
});

test('invalid target refs and detached HEAD are rejected',()=>{
  const f=fixture();
  try{
    assert.throws(()=>observeGit({repoPath:f.repo,targetRef:'--exec=unsafe'}),/Invalid target/);
    f.git('checkout','--detach','HEAD');
    assert.throws(()=>observeGit({repoPath:f.repo}),/Git command failed: symbolic-ref/);
  }finally{f.cleanup();}
});


test('assume-unchanged cannot conceal modified tracked content from RDD',()=>{
  const f=fixture();
  try{
    const frozen=observeGit({repoPath:f.repo});
    f.git('update-index','--assume-unchanged','README.md');
    writeFileSync(join(f.repo,'README.md'),'silently changed candidate');
    assert.throws(()=>observeGit({repoPath:f.repo}),/hidden\/unsupported tracked-file flags/);
    f.git('update-index','--no-assume-unchanged','README.md');
    const observed=observeGit({repoPath:f.repo});
    assert.equal(observed.clean,false);
    assert.equal(matchesReviewCandidate({candidateSha:frozen.candidateSha,gitEvidence:frozen},observed),false);
  }finally{f.cleanup();}
});

test('skip-worktree cannot conceal modified tracked content from RDD',()=>{
  const f=fixture();
  try{
    const frozen=observeGit({repoPath:f.repo});
    f.git('update-index','--skip-worktree','README.md');
    writeFileSync(join(f.repo,'README.md'),'silently changed via sparse checkout hint');
    assert.throws(()=>observeGit({repoPath:f.repo}),/hidden\/unsupported tracked-file flags/);
    f.git('update-index','--no-skip-worktree','README.md');
    const observed=observeGit({repoPath:f.repo});
    assert.equal(observed.clean,false);
    assert.equal(matchesReviewCandidate({candidateSha:frozen.candidateSha,gitEvidence:frozen},observed),false);
  }finally{f.cleanup();}
});


test('ignore=all cannot conceal modified tracked submodule content',()=>{
  const f=fixture();
  try{
    const nested=join(f.dir,'nested-library');
    mkdirSync(nested);
    const nestedGit=(...args)=>execFileSync('git',['-C',nested,...args],
      {encoding:'utf8'}).trim();
    nestedGit('init','-q','-b','main');
    nestedGit('config','user.name','Nested Test');
    nestedGit('config','user.email','tests@example.invalid');
    writeFileSync(join(nested,'API.md'),'original library content');
    nestedGit('add','API.md');
    nestedGit('commit','-qm','initialize nested fixture');
    f.git('-c','protocol.file.allow=always','submodule','add',nested,'lib');
    f.git('commit','-qam','track submodule');
    const frozen=observeGit({repoPath:f.repo});
    assert.equal(frozen.clean,true);
    f.git('config','submodule.lib.ignore','all');
    writeFileSync(join(f.repo,'lib','API.md'),'changed without commit');
    assert.equal(f.git('status','--porcelain=v1','--untracked-files=all'),'',
      'Fixture must demonstrate the submodule ignore bypass');
    assert.match(f.git('status','--porcelain=v1','--untracked-files=all',
      '--ignore-submodules=none'),/lib/);
    const observed=observeGit({repoPath:f.repo});
    assert.equal(observed.clean,false);
    assert.equal(matchesReviewCandidate({candidateSha:frozen.candidateSha,
      gitEvidence:frozen},observed),false);
  }finally{f.cleanup();}
});
