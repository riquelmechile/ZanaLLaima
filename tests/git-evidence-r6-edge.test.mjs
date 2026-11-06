import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,chmodSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {observeGit,matchesReviewCandidate} from '../src/git-evidence.mjs';

const git=(p,...args)=>execFileSync('git',['-C',p,...args],{
  encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'zana-r6-edges-')),repo=join(dir,'repo');
  mkdirSync(repo);git(repo,'init','-q','-b','main');
  git(repo,'config','user.name','Security Test');
  git(repo,'config','user.email','security@example.invalid');
  writeFileSync(join(repo,'f.txt'),'baseline');
  git(repo,'add','.');git(repo,'commit','-qm','base');
  git(repo,'checkout','-qb','feature/rdd');
  return {dir,repo,close:()=>rmSync(dir,{recursive:true,force:true})};
}
function withFixture(fn){
  const f=fixture();try{fn(f);}finally{f.close();}
}

test('RDD: cada campo de evidencia congelada se comprueba independientemente',()=>withFixture(f=>{
  const good=observeGit({repoPath:f.repo});
  const review={candidateSha:good.candidateSha,gitEvidence:good};
  assert.equal(matchesReviewCandidate(review,good),true);
  assert.equal(matchesReviewCandidate({},good),false);
  assert.equal(matchesReviewCandidate({candidateSha:good.candidateSha,
    gitEvidence:{assurance:'UNVERIFIED'}},good),false);
  assert.equal(matchesReviewCandidate(review,undefined),false);
  for(const key of ['repoRoot','candidateSha','treeSha','branchRef','targetRef','baseSha','clean']){
    const modified={...good,[key]:key==='clean'?false:'different'};
    assert.equal(matchesReviewCandidate(review,modified),false,key);
  }
  assert.equal(matchesReviewCandidate({...review,candidateSha:'not-verified'},good),false);
  assert.equal(matchesReviewCandidate({...review,gitEvidence:{...good,clean:false}},good),false);
}));
test('RDD: repositorio/ref inválidos, subdirectorio y detached HEAD se rechazan',()=>withFixture(f=>{
  for(const ref of ['',null,'x','refs/heads/','refs/heads/name..x',
    'refs/heads/name//x','refs/heads/name/','refs/heads/name@{','refs/heads/name*'])
    assert.throws(()=>observeGit({repoPath:f.repo,targetRef:ref}),/Invalid target/);
  assert.throws(()=>observeGit({repoPath:join(f.dir,'absent')}),/not available/);
  mkdirSync(join(f.repo,'nested'));
  assert.throws(()=>observeGit({repoPath:join(f.repo,'nested')}),/exact worktree root/);
  git(f.repo,'checkout','--detach','HEAD');
  assert.throws(()=>observeGit({repoPath:f.repo}),/Detached or invalid local branch/);
}));
test('RDD: borrado, tipo, modo, índice y untracked invalidan snapshot',()=>withFixture(f=>{
  assert.equal(observeGit({repoPath:f.repo}).clean,true);
  unlinkSync(join(f.repo,'f.txt'));
  assert.equal(observeGit({repoPath:f.repo}).clean,false);
  mkdirSync(join(f.repo,'f.txt'));
  assert.equal(observeGit({repoPath:f.repo}).clean,false);
  rmSync(join(f.repo,'f.txt'),{recursive:true});
  writeFileSync(join(f.repo,'f.txt'),'baseline');
  chmodSync(join(f.repo,'f.txt'),0o755);
  assert.equal(observeGit({repoPath:f.repo}).clean,false);
  git(f.repo,'add','f.txt');
  assert.equal(observeGit({repoPath:f.repo}).clean,false);
  git(f.repo,'commit','-qm','change executable mode');
  assert.equal(observeGit({repoPath:f.repo}).clean,true);
  chmodSync(join(f.repo,'f.txt'),0o644);
  assert.equal(observeGit({repoPath:f.repo}).clean,false);
  chmodSync(join(f.repo,'f.txt'),0o755);
  writeFileSync(join(f.repo,'untracked'),'untracked');
  assert.equal(observeGit({repoPath:f.repo}).clean,false);
}));
test('RDD: symlink se compara por destino literal y no por filtro',()=>withFixture(f=>{
  symlinkSync('f.txt',join(f.repo,'link'));
  git(f.repo,'add','link');git(f.repo,'commit','-qm','track symlink');
  assert.equal(observeGit({repoPath:f.repo}).clean,true);
  unlinkSync(join(f.repo,'link'));
  symlinkSync('changed',join(f.repo,'link'));
  assert.equal(observeGit({repoPath:f.repo}).clean,false);
  unlinkSync(join(f.repo,'link'));
  writeFileSync(join(f.repo,'link'),'f.txt');
  assert.equal(observeGit({repoPath:f.repo}).clean,false);
}));
test('RDD: gitlink divergente y submódulo no inicializado fallan cerrados',()=>withFixture(f=>{
  const original=join(f.dir,'submodule-source');mkdirSync(original);
  git(original,'init','-q','-b','main');
  git(original,'config','user.name','Security Test');
  git(original,'config','user.email','security@example.invalid');
  writeFileSync(join(original,'sub.txt'),'one');
  git(original,'add','sub.txt');git(original,'commit','-qm','base');
  git(f.repo,'-c','protocol.file.allow=always','submodule','add',original,'lib');
  git(f.repo,'commit','-qam','add gitlink');
  assert.equal(observeGit({repoPath:f.repo}).clean,true);
  const nested=join(f.repo,'lib');
  git(nested,'config','user.name','Security Test');
  git(nested,'config','user.email','security@example.invalid');
  writeFileSync(join(nested,'sub.txt'),'two');
  git(nested,'add','sub.txt');git(nested,'commit','-qm','advance submodule');
  assert.throws(()=>observeGit({repoPath:f.repo}),/Submodule HEAD differs from parent gitlink/);
  rmSync(nested,{recursive:true});
  assert.throws(()=>observeGit({repoPath:f.repo}),/submodule|Git command failed/);
}));
