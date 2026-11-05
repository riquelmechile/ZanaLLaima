import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {observeGit} from '../src/git-evidence.mjs';
const git=(r,...a)=>execFileSync('git',['-C',r,...a],{encoding:'utf8'}).trim();
function fixture(){
 const base=mkdtempSync(join(tmpdir(),'zana-r9-python-')),repo=join(base,'repo');
 mkdirSync(repo);git(repo,'init','-qb','main');git(repo,'config','user.name','Py');
 git(repo,'config','user.email','py@example.invalid');
 writeFileSync(join(repo,'tracked.txt'),'present');
 git(repo,'add','.');git(repo,'commit','-qm','baseline');
 git(repo,'checkout','-qb','feature/python');
 return {base,repo,close:()=>rmSync(base,{recursive:true,force:true})};
}
for(const [dir,filename] of [['.venv','pyvenv.cfg'],['.pytest_cache','CACHEDIR.TAG']]){
 test('R9-C4: '+dir+' autoignore solo * equivale a Python real',()=>{
 const f=fixture();
 try{
  mkdirSync(join(f.repo,dir));
  writeFileSync(join(f.repo,dir,'.gitignore'),'*\n');
  writeFileSync(join(f.repo,dir,filename),'contenido generado\n');
  assert.equal(git(f.repo,'status','--porcelain=v1','-uall'),'', 'git status Python limpio');
  assert.equal(observeGit({repoPath:f.repo}).clean,true,
    '.gitignore de entorno Python no rastreado no debe ensuciar un repo limpio');
 }finally{f.close();}
 });
}
test('R9-C4: sub/.gitignore "*" no oculta cambios en un directorio con entradas rastreadas',()=>{
 const f=fixture();
 try{
  mkdirSync(join(f.repo,'sub'));
  writeFileSync(join(f.repo,'sub','tracked.txt'),'original');
  git(f.repo,'add','sub/tracked.txt');git(f.repo,'commit','-qm','sub tracked');
  writeFileSync(join(f.repo,'sub','.gitignore'),'*\n');
  writeFileSync(join(f.repo,'sub','evil.mjs'),'oculto\n');
  assert.equal(observeGit({repoPath:f.repo}).clean,false,
    'Directorios con archivos rastreados no admiten autoignore Python');
 }finally{f.close();}
});
test('R9-C4: un .gitignore no rastreado con negación no se admite como autoignore',()=>{
 const f=fixture();
 try{
  mkdirSync(join(f.repo,'sub'));
  writeFileSync(join(f.repo,'sub','.gitignore'),'*\n!evil.mjs\n');
  writeFileSync(join(f.repo,'sub','evil.mjs'),'oculto\n');
  assert.match(git(f.repo,'status','--porcelain=v1','-uall'),/evil[.]mjs/);
  assert.equal(observeGit({repoPath:f.repo}).clean,false);
 }finally{f.close();}
});
