import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {observeGit} from '../src/git-evidence.mjs';
const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8'}).trim();
test('R8-C1 partial clone and remote uploadpack config rejected before Git execution',()=>{
 const d=mkdtempSync(join(tmpdir(),'r8-partial-')),r=join(d,'repo');
 try{
  mkdirSync(r);git(r,'init','-qb','main');git(r,'config','user.name','Fixture');
  git(r,'config','user.email','fixture@example.invalid');writeFileSync(join(r,'f'),'ok');
  git(r,'add','.');git(r,'commit','-qm','baseline');git(r,'checkout','-qb','feature/test');
  const marker=join(d,'UPLOADPACK_EXECUTED');
  git(r,'config','extensions.partialClone','origin');
  git(r,'config','remote.origin.promisor','true');
  git(r,'config','remote.origin.uploadpack','sh -c "touch '+marker+'; git-upload-pack"');
  assert.throws(()=>observeGit({repoPath:r}),/Git candidate rejected:.*(partial|promisor|uploadpack|extension|configuration)/i);
  assert.equal(existsSync(marker),false,'No ejecutar uploadpack ni lazy fetch');
 }finally{rmSync(d,{recursive:true,force:true});}
});