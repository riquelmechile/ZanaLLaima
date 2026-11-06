import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {observeGit,matchesReviewCandidate} from '../src/git-evidence.mjs';
const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'zana-r6-replace-'));
  const repo=join(dir,'repo');mkdirSync(repo);git(repo,'init','-qb','main');
  git(repo,'config','user.name','Security Test');git(repo,'config','user.email','fixture@example.invalid');
  writeFileSync(join(repo,'f.txt'),'before');git(repo,'add','f.txt');git(repo,'commit','-qm','base');
  git(repo,'checkout','-qb','feature/review');
  return {repo,dir,close:()=>rmSync(dir,{recursive:true,force:true})};
}
function submodule(f){
  const source=join(f.dir,'source');mkdirSync(source);git(source,'init','-qb','main');
  git(source,'config','user.name','Security Test');git(source,'config','user.email','fixture@example.invalid');
  writeFileSync(join(source,'f.txt'),'before');git(source,'add','f.txt');git(source,'commit','-qm','base');
  git(f.repo,'-c','protocol.file.allow=always','submodule','add',source,'lib');
  git(f.repo,'commit','-qam','add submodule');return join(f.repo,'lib');
}
function replaceTree(repo){
  const tree=git(repo,'rev-parse','HEAD^{tree}');
  writeFileSync(join(repo,'f.txt'),'modified');
  writeFileSync(join(repo,'added.txt'),'new object');
  git(repo,'add','f.txt','added.txt');
  const different=git(repo,'write-tree');assert.notEqual(tree,different);
  git(repo,'replace',tree,different);
}
for(const target of ['root','submodule']){
  test('P1 Git replace no puede validar blob no comprometido: '+target,()=>{
    const f=fixture();try{
      const repo=target==='root'?f.repo:submodule(f);
      const frozen=observeGit({repoPath:f.repo});assert.equal(frozen.clean,true);
      replaceTree(repo);
      const observed=observeGit({repoPath:f.repo});
      assert.equal(observed.clean,false,'git replace alteró la identidad de los blobs de HEAD');
      assert.equal(matchesReviewCandidate({candidateSha:frozen.candidateSha,gitEvidence:frozen},observed),false);
    }finally{f.close();}
  });
}
