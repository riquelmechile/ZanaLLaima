import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {observeGit} from '../src/git-evidence.mjs';
const git=(r,...a)=>execFileSync('git',['-C',r,...a],{encoding:'utf8',
 env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}}).trim();
const fixture=(ignored=false)=>{
 const dir=mkdtempSync(join(tmpdir(),'zana-r10-nested-')),repo=join(dir,'repo');
 mkdirSync(repo);git(repo,'init','-qb','main');
 git(repo,'config','user.name','R10');git(repo,'config','user.email','r10@example.invalid');
 writeFileSync(join(repo,'tracked.txt'),'base\n');
 if(ignored)writeFileSync(join(repo,'.gitignore'),'nest/\n');
 git(repo,'add','.');git(repo,'commit','-qm','base');git(repo,'checkout','-qb','feature/nested');
 const nest=join(repo,'nest');mkdirSync(nest);
 return {dir,repo,nest,close:()=>rmSync(dir,{recursive:true,force:true})};
};
for(const branch of ['v1+fix','v1@fix','rama-ñ']){
 test('R10-C3: Git anidado vacío con HEAD '+branch+' nunca pasa limpio',()=>{
  const f=fixture();
  try{
   git(f.nest,'init','-qb',branch);
   assert.match(git(f.repo,'status','--porcelain=v1','-uall','--ignore-submodules=none'),
    /\?\? nest\//);
   assert.equal(observeGit({repoPath:f.repo}).clean,false,'Anidado en rama '+branch);
  }finally{f.close();}
 });
}
for(const [label,prepare] of [
 ['sin config',nest=>{git(nest,'init','-qb','main');rmSync(join(nest,'.git','config'));}],
 ['.git symlink',nest=>symlinkSync('../.git',join(nest,'.git'))],
 ['gitfile sin gitdir válido',nest=>writeFileSync(join(nest,'.git'),'gitdir: /tmp/externo-ausente\n')],
 ['worktree externo vaciado',nest=>writeFileSync(join(nest,'.git'),'gitdir: /tmp/worktree-gitdir-vaciado\n')],
 ['.git basura',nest=>mkdirSync(join(nest,'.git'))]
]){
 test('R10-C3: cualquier entrada .git en directorio no rastreado es extra: '+label,()=>{
  const f=fixture();
  try{
   prepare(f.nest);
   // Fail closed incluso cuando git porcelain no reconoce una .git basura
   // como repositorio y, por tanto, no enumera el directorio vacío.
   assert.equal(observeGit({repoPath:f.repo}).clean,false,label);
  }finally{f.close();}
 });
}
test('R10-C3: repo anidado dentro de carpeta ignorada en .gitignore rastreado sigue limpio',()=>{
 const f=fixture(true);
 try{
  git(f.nest,'init','-qb','v1+fix');
  assert.equal(git(f.repo,'status','--porcelain=v1','-uall','--ignore-submodules=none'),'');
  assert.equal(observeGit({repoPath:f.repo}).clean,true);
 }finally{f.close();}
});
