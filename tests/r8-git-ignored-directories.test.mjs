import test from 'node:test';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {observeGit} from '../src/git-evidence.mjs';
const git=(d,...a)=>execFileSync('git',['-C',d,...a],{encoding:'utf8'}).trim();
test('R8-C3 nested .gitignore under ignored venv must not dirty candidate',()=>{
 const d=mkdtempSync(join(tmpdir(),'r8-venv-')),r=join(d,'repo');
 try{
  mkdirSync(r);git(r,'init','-qb','main');git(r,'config','user.name','Fixture');
  git(r,'config','user.email','fixture@example.invalid');
  writeFileSync(join(r,'.gitignore'),'.venv/\nnode_modules/\n');
  writeFileSync(join(r,'f'),'tracked');git(r,'add','.');git(r,'commit','-qm','baseline');
  git(r,'checkout','-qb','feature/test');
  mkdirSync(join(r,'.venv'));writeFileSync(join(r,'.venv','.gitignore'),'*');
  writeFileSync(join(r,'.venv','evil.mjs'),'ignored');
  assert.equal(git(r,'status','--porcelain'),'');
  const evidence=observeGit({repoPath:r});
  assert.equal(evidence.clean,true,'No entrar en directorios ignorados del commit');
 }finally{rmSync(d,{recursive:true,force:true});}
});