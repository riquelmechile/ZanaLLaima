import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {observeGit} from '../src/git-evidence.mjs';
const git=(r,...a)=>execFileSync('git',['-C',r,...a],{encoding:'utf8',
 env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}}).trim();
const fixture=()=>{
 const dir=mkdtempSync(join(tmpdir(),'zana-r10-autoignore-')),repo=join(dir,'repo');
 mkdirSync(repo);git(repo,'init','-qb','main');git(repo,'config','user.name','R10');
 git(repo,'config','user.email','r10@example.invalid');
 writeFileSync(join(repo,'base.txt'),'baseline\n');
 git(repo,'add','.');git(repo,'commit','-qm','base');git(repo,'checkout','-qb','feature/autoignore');
 return {repo,close:()=>rmSync(dir,{recursive:true,force:true})};
};
const invalid=[
 ['ASCII leading space',' *'],
 ['tab leading','\t*'],
 ['trailing tab','*\t'],
 ['vertical tab','*\v'],
 ['form feed','*\f'],
 ['NBSP trailing','*\u00a0'],
 ['non-ASCII leading space','\u2002*'],
 ['leading CR','\r*\n'],
 ['double BOM','\ufeff\ufeff*\n'],
 ['double CR','*\r\r\n']
];
for(const [label,pattern] of invalid){
 test('R10-C1: autoignore solo admite gramática Git exacta: '+label,()=>{
  const f=fixture();
  try{
   mkdirSync(join(f.repo,'v'));
   writeFileSync(join(f.repo,'v','.gitignore'),pattern);
   writeFileSync(join(f.repo,'v','secret.test.mjs'),'export const secret=1;\n');
   const porcelain=git(f.repo,'status','--porcelain=v1','-uall','--ignore-submodules=none');
   assert.match(porcelain,/secret[.]test[.]mjs/,'Git debe mostrar secret como untracked');
   assert.equal(observeGit({repoPath:f.repo}).clean,false,
     'Autoignore de JS aceptó bytes que Git no interpreta como un único *');
  }finally{f.close();}
 });
}
for(const [label,pattern] of [
 ['BOM y comentarios','\ufeff# autoignore\n\n*\n'],
 ['CRLF y comentarios','\r\n# comentario\r\n*   \r\n']
]){
 test('R10-C1: autoignore válido '+label,()=>{
  const f=fixture();
  try{
   mkdirSync(join(f.repo,'v'));
   writeFileSync(join(f.repo,'v','.gitignore'),pattern);
   writeFileSync(join(f.repo,'v','cache.pyc'),'ignored');
   assert.equal(git(f.repo,'status','--porcelain=v1','-uall'),'');
   assert.equal(observeGit({repoPath:f.repo}).clean,true);
  }finally{f.close();}
 });
}
