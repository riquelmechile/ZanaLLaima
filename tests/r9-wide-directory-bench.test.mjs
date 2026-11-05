import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {observeGit} from '../src/git-evidence.mjs';

const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();

test('R9-W7: observeGit 5000 archivos en 3400 directorios en menos de 1 s',()=>{
  const dir=mkdtempSync(join(tmpdir(),'zana-r9-wide-bench-'));
  const repo=join(dir,'repo');
  try{
    mkdirSync(repo);git(repo,'init','-qb','main');
    git(repo,'config','user.name','R9 Benchmark');
    git(repo,'config','user.email','r9-benchmark@example.invalid');
    for(let i=0;i<3400;i++)
      mkdirSync(join(repo,'bucket-'+String(i).padStart(4,'0')));
    for(let i=0;i<5000;i++){
      const bucket=String(i%3400).padStart(4,'0');
      writeFileSync(join(repo,'bucket-'+bucket,'f-'+String(i).padStart(4,'0')+'.txt'),
        'content '+i+'\n');
    }
    git(repo,'add','.');git(repo,'commit','-qm','5k tracked in 3400 directories');
    git(repo,'checkout','-qb','feature/r9-wide');
    const begin=performance.now();
    const observed=observeGit({repoPath:repo});
    const ms=performance.now()-begin;
    console.log('R9_BENCH_FILES_5000_DIRS_3400_MS='+ms.toFixed(2));
    assert.equal(observed.clean,true,JSON.stringify(observed.reason));
    assert.ok(ms<1000,'R9 5000 files/3400 directories observation took '+ms.toFixed(2)+'ms');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
