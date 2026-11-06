import test from 'node:test';import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {observeGit} from '../src/git-evidence.mjs';
const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
const fixture=()=>{
 const dir=mkdtempSync(join(tmpdir(),'r8-bench-')),repo=join(dir,'repo');
 mkdirSync(repo);git(repo,'init','-qb','main');
 git(repo,'config','user.name','Benchmark');git(repo,'config','user.email','b@example.invalid');
 return {dir,repo,close:()=>rmSync(dir,{recursive:true,force:true})};
};
test('R8 benchmark: 150k archivos ignorados no se visitan; observeGit <1s',()=>{
 const f=fixture();try{
  writeFileSync(join(f.repo,'.gitignore'),'node_modules/\n.venv/\n.pytest_cache/\n');
  writeFileSync(join(f.repo,'index.mjs'),'export const ok=true;\n');
  git(f.repo,'add','.');git(f.repo,'commit','-qm','baseline');git(f.repo,'checkout','-qb','feature/bench');
  const folders=['node_modules','.venv','.pytest_cache'];
  for(const name of folders)mkdirSync(join(f.repo,name));
  for(let i=0;i<150000;i++){
   const name=folders[i%3],path=join(f.repo,name,'f'+i+'.bin');
   writeFileSync(path,'x');
  }
  writeFileSync(join(f.repo,'.venv','.gitignore'),'*');
  const start=performance.now(),v=observeGit({repoPath:f.repo}),ms=performance.now()-start;
  console.log('R8_BENCH_IGNORED_150K_MS='+ms.toFixed(2));
  assert.equal(v.clean,true,JSON.stringify(v.reason));
  assert.ok(ms<1000,'150k ignored took '+ms.toFixed(2)+'ms');
 }finally{f.close();}
});
test('R8 benchmark: 150k commits no alteran coste de observar un archivo; <1s',()=>{
 const f=fixture();try{
  const commands=['blob\nmark :1\ndata 6\nhello\n'];
  for(let i=0;i<150000;i++){
   const message='commit '+i,when=i+1;
   commands.push('commit refs/heads/main\nmark :'+(i+2)+
    '\nauthor Benchmark <b@example.invalid> '+when+' +0000'+
    '\ncommitter Benchmark <b@example.invalid> '+when+' +0000'+
    '\ndata '+Buffer.byteLength(message)+'\n'+message+'\n'+
    (i===0?'M 100644 :1 file.txt\n':'')+'\n');
  }
  const importing=spawnSync('git',['fast-import','--quiet'],{
   cwd:f.repo,input:commands.join(''),encoding:'utf8',timeout:180000,maxBuffer:1024*1024
  });
  assert.equal(importing.status,0,importing.stderr?.slice(-500));
  git(f.repo,'checkout','-qf','main');git(f.repo,'checkout','-qb','feature/bench');
  assert.equal(Number(git(f.repo,'rev-list','--count','main')),150000);
  const start=performance.now(),v=observeGit({repoPath:f.repo}),ms=performance.now()-start;
  console.log('R8_BENCH_COMMITS_150K_MS='+ms.toFixed(2));
  assert.equal(v.clean,true,JSON.stringify(v.reason));
  assert.ok(ms<1000,'150k commits observation took '+ms.toFixed(2)+'ms');
 }finally{f.close();}
});
