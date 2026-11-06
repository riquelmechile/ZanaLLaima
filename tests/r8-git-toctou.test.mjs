import test from 'node:test';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {observeGit} from '../src/git-evidence.mjs';
const git=(d,...a)=>execFileSync('git',['-C',d,...a],{encoding:'utf8'}).trim();
test('R8-C2 no separate object-store scan, tree read or status during observation',()=>{
 const d=mkdtempSync(join(tmpdir(),'r8-toctou-')),r=join(d,'repo'),bin=join(d,'bin'),log=join(d,'git.log');
 const oldPath=process.env.PATH,oldLog=process.env.R8_GIT_LOG;
 try{
  mkdirSync(r);mkdirSync(bin);git(r,'init','-qb','main');
  git(r,'config','user.name','Fixture');git(r,'config','user.email','fixture@example.invalid');
  writeFileSync(join(r,'f'),'committed');git(r,'add','.');git(r,'commit','-qm','baseline');
  git(r,'checkout','-qb','feature/test');
  writeFileSync(join(bin,'git'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$R8_GIT_LOG"\nexec /usr/bin/git "$@"\n',{mode:0o755});
  process.env.PATH=bin+':'+oldPath;process.env.R8_GIT_LOG=log;
  assert.equal(observeGit({repoPath:r}).clean,true);
  const calls=readFileSync(log,'utf8').split('\n').filter(Boolean);
  assert.equal(calls.filter(x=>/cat-file commit/.test(x)).length,1,'Solo una lectura de commit');
  assert.equal(calls.some(x=>/\b(fsck|ls-tree|status|ls-files|rev-parse|hash-object|check-attr)\b/.test(x)),false,
     'No consultar árboles/objetos y comparar en procesos separados');
 }finally{process.env.PATH=oldPath;
  if(oldLog===undefined)delete process.env.R8_GIT_LOG;else process.env.R8_GIT_LOG=oldLog;
  rmSync(d,{recursive:true,force:true});}
});