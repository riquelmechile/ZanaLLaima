import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {observeGit} from '../src/git-evidence.mjs';
const git=(r,...args)=>execFileSync('git',['-C',r,...args],{encoding:'utf8'}).trim();
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'zana-r7-ignore-')),repo=join(dir,'repo');
 mkdirSync(repo);git(repo,'init','-qb','main');
 git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.invalid');
 writeFileSync(join(repo,'f.txt'),'snapshot');
 git(repo,'add','.');git(repo,'commit','-qm','base');git(repo,'checkout','-qb','feature/test');
 return {repo,dir,close:()=>rmSync(dir,{recursive:true,force:true})};
}
for(const vector of ['info/exclude','core.excludesFile','gitignore-no-rastreado']){
 test('R7 W2: '+vector+' no puede ocultar archivos nuevos del RDD',()=>{
   const f=fixture();try{
     if(vector==='info/exclude'){
       writeFileSync(join(f.repo,'.git','info','exclude'),'evil.mjs\n');
       writeFileSync(join(f.repo,'evil.mjs'),'payload\n');
     }else if(vector==='core.excludesFile'){
       const file=join(f.dir,'exclude-global');
       writeFileSync(file,'evil.mjs\n');git(f.repo,'config','core.excludesFile',file);
       writeFileSync(join(f.repo,'evil.mjs'),'payload\n');
     }else{
       mkdirSync(join(f.repo,'untracked'));
       writeFileSync(join(f.repo,'untracked','.gitignore'),'*\n!evil.mjs\n');
       writeFileSync(join(f.repo,'untracked','evil.mjs'),'payload\n');
     }
     assert.equal(observeGit({repoPath:f.repo}).clean,false,
       'Configuración no comprometida ocultó archivos no rastreados');
   }finally{f.close();}
 });
}
test('R7 W2: .gitignore rastreado en HEAD sí se respeta',()=>{
 const f=fixture();try{
   writeFileSync(join(f.repo,'.gitignore'),'cache/\n');
   git(f.repo,'add','.gitignore');git(f.repo,'commit','-qm','ignore tracked');
   mkdirSync(join(f.repo,'cache'));writeFileSync(join(f.repo,'cache','auto.dat'),'generated');
   assert.equal(observeGit({repoPath:f.repo}).clean,true);
 }finally{f.close();}
});
