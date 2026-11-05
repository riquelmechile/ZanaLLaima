import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,renameSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {observeGit} from '../src/git-evidence.mjs';
const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'zana-r6-gitlink-symlink-'));
  const repo=join(dir,'repo');mkdirSync(repo);git(repo,'init','-qb','main');
  git(repo,'config','user.name','Security Test');git(repo,'config','user.email','fixture@example.invalid');
  writeFileSync(join(repo,'f.txt'),'before');git(repo,'add','f.txt');git(repo,'commit','-qm','base');
  git(repo,'checkout','-qb','feature/review');
  return {repo,dir,close:()=>rmSync(dir,{recursive:true,force:true})};
}
test('P2: symlink en entrada gitlink no pasa como submódulo real',()=>{
  const f=fixture();try{
    const source=join(f.dir,'source');mkdirSync(source);git(source,'init','-qb','main');
    git(source,'config','user.name','Security Test');git(source,'config','user.email','fixture@example.invalid');
    writeFileSync(join(source,'f.txt'),'before');git(source,'add','f.txt');git(source,'commit','-qm','base');
    git(f.repo,'-c','protocol.file.allow=always','submodule','add',source,'lib');
    git(f.repo,'commit','-qam','add submodule');
    assert.equal(observeGit({repoPath:f.repo}).clean,true);
    renameSync(join(f.repo,'lib'),join(f.repo,'copy'));
    symlinkSync('copy',join(f.repo,'lib'),'dir');
    writeFileSync(join(f.repo,'.git','info','exclude'),'copy/\nlib/\nlib\n');
    let rejected=false;
    try{const observed=observeGit({repoPath:f.repo});rejected=observed.clean===false;}
    catch(error){assert.match(error.message,/Git candidate rejected/);rejected=true;}
    assert.equal(rejected,true,'un symlink directo en lugar del gitlink se observó limpio');
  }finally{f.close();}
});
