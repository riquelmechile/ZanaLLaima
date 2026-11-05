import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,chmodSync,symlinkSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {observeGit} from '../src/git-evidence.mjs';
const git=(d,...args)=>execFileSync('git',['-C',d,...args],{encoding:'utf8'}).trim();
test('R8: matriz 60 estados sin atributos/CRLF coincide con git status --porcelain',()=>{
 const dir=mkdtempSync(join(tmpdir(),'r8-status-matrix-')),repo=join(dir,'repo');
 try{
  mkdirSync(repo);git(repo,'init','-qb','main');
  git(repo,'config','user.name','Matrix');git(repo,'config','user.email','matrix@example.invalid');
  const a=join(repo,'f.txt'),b=join(repo,'g.sh');
  writeFileSync(a,'same\n');writeFileSync(b,'echo baseline\n');chmodSync(b,0o644);
  git(repo,'add','.');git(repo,'commit','-qm','baseline');git(repo,'checkout','-qb','feature/matrix');
  const results=[];
  for(let round=0;round<6;round++){
   for(let scenario=0;scenario<10;scenario++){
    git(repo,'reset','--hard','HEAD');git(repo,'clean','-fd');
    switch(scenario){
     case 0:break;
     case 1:writeFileSync(a,'different '+round+'\n');break;
     case 2:writeFileSync(join(repo,'new-'+round),'new');break;
     case 3:rmSync(a);break;
     case 4:chmodSync(b,0o755);break;
     case 5:git(repo,'mv','f.txt','renamed.txt');break;
     case 6:writeFileSync(a,'staged\n');git(repo,'add','f.txt');break;
     case 7:writeFileSync(a,'staged\n');git(repo,'add','f.txt');writeFileSync(a,'unstaged\n');break;
     case 8:rmSync(b);symlinkSync('f.txt',b);break;
     case 9:rmSync(a);mkdirSync(a);writeFileSync(join(a,'nested'),'content');break;
    }
    const output=git(repo,'status','--porcelain=v1','--untracked-files=all');
    const expected=output.length===0;
    let actual;
    try{actual=observeGit({repoPath:repo}).clean;}
    catch(error){throw Error('Unexpected rejection at '+round+'/'+scenario+': '+error.message);}
    assert.equal(actual,expected,'Mismatch '+round+'/'+scenario+' status='+JSON.stringify(output));
    results.push({round,scenario,clean:actual});
   }
  }
  assert.equal(results.length,60);
  console.log('R8_GIT_STATUS_MATRIX_CASES='+results.length+' MISMATCHES=0');
 }finally{rmSync(dir,{recursive:true,force:true});}
});