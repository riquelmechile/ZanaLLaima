import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {observeGit} from '../src/git-evidence.mjs';
const git=(r,...args)=>execFileSync('git',['-C',r,...args],{encoding:'utf8'}).trim();
for(const scenario of [
 {committed:0o755,current:0o655,fileMode:true},
 {committed:0o644,current:0o654,fileMode:true},
 {committed:0o755,current:0o655,fileMode:false},
 {committed:0o644,current:0o744,fileMode:false}
]){
 test('R7 W3: ejecución coincide con git status '+JSON.stringify(scenario),()=>{
 const dir=mkdtempSync(join(tmpdir(),'zana-r7-exec-')),repo=join(dir,'repo');
 try{
  mkdirSync(repo);git(repo,'init','-qb','main');
  git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.invalid');
  const path=join(repo,'exec.sh');writeFileSync(path,'echo hello\n');
  chmodSync(path,scenario.committed);git(repo,'add','.');git(repo,'commit','-qm','baseline');
  git(repo,'checkout','-qb','feature/test');
  git(repo,'config','core.filemode',String(scenario.fileMode));
  chmodSync(path,scenario.current);
  const expected=scenario.fileMode?git(repo,'status','--porcelain=v1').length===0:false;
  assert.equal(observeGit({repoPath:repo}).clean,expected,
   'RDD no puede confiar en core.fileMode=false del autor para ocultar un cambio');
 }finally{rmSync(dir,{recursive:true,force:true});}
 });
}
