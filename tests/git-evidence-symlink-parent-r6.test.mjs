import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,renameSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {observeGit} from '../src/git-evidence.mjs';
const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'zana-r6-symlink-'));
 const repo=join(dir,'repo');mkdirSync(repo);git(repo,'init','-qb','main');
 git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.invalid');
 mkdirSync(join(repo,'src'));writeFileSync(join(repo,'src','a.js'),'hello\n');
 git(repo,'add','.');git(repo,'commit','-qm','base');git(repo,'checkout','-qb','feature/test');
 return {dir,repo,close:()=>rmSync(dir,{recursive:true,force:true})};
}
for(const depth of [1,2])test('P2 ruta rastreada no admite directorio padre symlink interno, profundidad '+depth,()=>{
 const f=fixture();try{
  const origin=depth===1?'src':'src/sub';
  if(depth===2){
    mkdirSync(join(f.repo,'src','sub'));
    renameSync(join(f.repo,'src','a.js'),join(f.repo,'src','sub','a.js'));
    git(f.repo,'add','-A');git(f.repo,'commit','-qm','nested path');
  }
  assert.equal(observeGit({repoPath:f.repo}).clean,true,'El candidato antes del cambio debe estar limpio');
  renameSync(join(f.repo,origin),join(f.repo,'copy'));
  symlinkSync(depth===1?'copy':'../copy',join(f.repo,origin),'dir');
  writeFileSync(join(f.repo,'.git','info','exclude'),'copy/\nsrc/\nsrc\n');
  assert.equal(observeGit({repoPath:f.repo}).clean,false,
    'symlink en directorio intermedio ocultó una ruta eliminada');
 }finally{f.close();}
});
