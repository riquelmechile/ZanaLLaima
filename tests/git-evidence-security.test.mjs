import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {observeGit} from '../src/git-evidence.mjs';

const git=(path,...args)=>execFileSync('git',['-C',path,...args],{encoding:'utf8'}).trim();

function repoFixture(){
  const root=mkdtempSync(join(tmpdir(),'zana-git-hooks-'));
  const path=join(root,'repo');mkdirSync(path);
  git(path,'init','-q','-b','main');
  git(path,'config','user.name','Security Fixture');
  git(path,'config','user.email','fixture@example.invalid');
  writeFileSync(join(path,'f.txt'),'before');
  git(path,'add','f.txt');git(path,'commit','-qm','main');
  git(path,'checkout','-qb','feature/hook');
  return {root,path,close:()=>rmSync(root,{recursive:true,force:true})};
}
function configureFsmonitor(root,path){
  const marker=join(root,'HOOK_EXECUTED');
  const hook=join(root,'fsmonitor.sh');
  writeFileSync(hook,'#!/bin/sh\nprintf "ran\\n" >> "'+marker+'"\nprintf "token\\n"\n',{mode:0o755});
  git(path,'config','core.fsmonitor',hook);
  git(path,'update-index','--fsmonitor');
  rmSync(marker,{force:true});
  return marker;
}
test('CRITICAL C2 root: Git fsmonitor cannot run or conceal changed tracked content',()=>{
  const f=repoFixture();
  try{
    const marker=configureFsmonitor(f.root,f.path);
    writeFileSync(join(f.path,'f.txt'),'changed after index');
    const observed=observeGit({repoPath:f.path});
    assert.equal(existsSync(marker),false,'observeGit executed an attacker hook');
    assert.equal(observed.clean,false,'fsmonitor masked a changed tracked file');
  }finally{f.close();}
});
test('CRITICAL C2 nested: Git fsmonitor does not run in initialized submodules',()=>{
  const f=repoFixture();
  try{
    const source=join(f.root,'library');mkdirSync(source);
    git(source,'init','-q','-b','main');
    git(source,'config','user.name','Security Fixture');
    git(source,'config','user.email','fixture@example.invalid');
    writeFileSync(join(source,'f.txt'),'initial');
    git(source,'add','f.txt');git(source,'commit','-qm','base');
    git(f.path,'-c','protocol.file.allow=always','submodule','add',source,'lib');
    git(f.path,'commit','-qam','add submodule');
    const nested=join(f.path,'lib');
    const marker=configureFsmonitor(f.root,nested);
    writeFileSync(join(nested,'f.txt'),'modified without commit');
    git(f.path,'config','submodule.lib.ignore','all');
    const observed=observeGit({repoPath:f.path});
    assert.equal(existsSync(marker),false,'submodule fsmonitor hook executed');
    assert.equal(observed.clean,false,'submodule changes must be visible');
  }finally{f.close();}
});
test('CRITICAL C2: local malicious clean filter must never execute during observation',()=>{
  const f=repoFixture();
  try{
    writeFileSync(join(f.path,'.gitattributes'),'f.txt filter=bad\n');
    git(f.path,'add','.gitattributes');git(f.path,'commit','-qm','attributes');
    const marker=join(f.root,'FILTER_EXECUTED');
    git(f.path,'config','filter.bad.clean','sh -c "touch '+marker+'; cat"');
    writeFileSync(join(f.path,'f.txt'),'content changed');
    try{observeGit({repoPath:f.path});}catch(error){
      assert.match(error.message,/Git candidate rejected/);
    }
    assert.equal(existsSync(marker),false,'unsafe filter ran during observation');
  }finally{f.close();}
});
