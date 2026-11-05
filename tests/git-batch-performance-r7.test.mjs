import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {observeGit} from '../src/git-evidence.mjs';
const git=(r,...args)=>execFileSync('git',['-C',r,...args],{encoding:'utf8'}).trim();
test('R7 W1 benchmark: observar 5000 archivos rastreados en menos de 1 segundo',()=>{
 const dir=mkdtempSync(join(tmpdir(),'zana-r7-batch-')),repo=join(dir,'repo');
 try{
   mkdirSync(repo);git(repo,'init','-qb','main');
   git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.invalid');
   const folder=join(repo,'assets');mkdirSync(folder);
   for(let i=0;i<5000;i++)
     writeFileSync(join(folder,String(i).padStart(5,'0')+'.txt'),'content '+i+'\n');
   git(repo,'add','.');git(repo,'commit','-qm','5000 files');git(repo,'checkout','-qb','feature/performance');
   const started=performance.now();
   const observed=observeGit({repoPath:repo});
   const elapsed=performance.now()-started;
   console.log('R8_BENCH_FILES_5000_MS='+elapsed.toFixed(2));
   assert.equal(observed.clean,true);
   assert.ok(elapsed<1000,'RDD 5000 archivos demoró '+elapsed.toFixed(0)+'ms (máximo 1000ms)');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
