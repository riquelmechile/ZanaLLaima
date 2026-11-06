import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {observeGit} from '../src/git-evidence.mjs';
const git=(r,...a)=>execFileSync('git',['-C',r,...a],{encoding:'utf8',
 env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();
const fixture=()=>{
 const dir=mkdtempSync(join(tmpdir(),'zana-r10-config-')),r=join(dir,'r');
 mkdirSync(r);git(r,'init','-qb','main');
 git(r,'config','user.name','R10');git(r,'config','user.email','r10@example.invalid');
 writeFileSync(join(r,'src.txt'),'safe\n');git(r,'add','.');git(r,'commit','-qm','base');
 git(r,'checkout','-qb','feat/config');
 return {dir,r,close:()=>rmSync(dir,{recursive:true,force:true})};
};
const cases=[
 ['core.worktree',f=>git(f.r,'config','core.worktree','/tmp/untrusted')],
 ['remote.origin.promisor full key',f=>appendFileSync(join(f.r,'.git','config'),'\n[core]\nremote.origin.promisor = true\n')],
 ['remote.origin.uploadpack',f=>appendFileSync(join(f.r,'.git','config'),'\n[remote "origin"]\n uploadpack = anything\n')],
 ['config continuation',f=>appendFileSync(join(f.r,'.git','config'),'\n[core]\n foo = bar\\\n remote.origin.promisor = true\n')],
 ['info/attributes filter',f=>{
  mkdirSync(join(f.r,'.git','info'),{recursive:true});
  writeFileSync(join(f.r,'.git','info','attributes'),'* filter=unsafe\n');
 }],
 ['core.attributesFile text',f=>{
  const attrs=join(f.dir,'attrs');
  writeFileSync(attrs,'* text=auto\n');
  git(f.r,'config','core.attributesFile',attrs);
 }]
];
for(const [label,modify] of cases)
 test('R10-W1: config y atributos hostiles rechazados: '+label,()=>{
  const f=fixture();
  try{modify(f);assert.throws(()=>observeGit({repoPath:f.r}),
    /Git candidate rejected:.*(config|attributes|remote|core|continuation)/i);}
  finally{f.close();}
 });
