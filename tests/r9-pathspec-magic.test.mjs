import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {observeGit} from '../src/git-evidence.mjs';
const git=(r,...a)=>execFileSync('git',['-C',r,...a],{encoding:'utf8'}).trim();
const fixture=()=>{
 const d=mkdtempSync(join(tmpdir(),'zana-r9-magic-')),r=join(d,'repo');
 mkdirSync(r);git(r,'init','-qb','main');git(r,'config','user.name','Test');
 git(r,'config','user.email','test@example.invalid');
 writeFileSync(join(r,'.gitignore'),'build/\n');
 writeFileSync(join(r,'index.js'),'tracked\n');
 git(r,'add','.');git(r,'commit','-qm','base');git(r,'checkout','-qb','feature/r9');
 return {d,r,close:()=>rmSync(d,{recursive:true,force:true})};
};
for(const name of [':build','::x',':(top)x',':!x']){
 test('R9-C1 pathspec magic: carpeta '+name+' no puede desaparecer',()=>{
   const f=fixture();
   try{
     mkdirSync(join(f.r,name));
     writeFileSync(join(f.r,name,'evil.test.mjs'),'export const hidden=true;\n');
     const porcelain=git(f.r,'status','--porcelain=v1','-uall','--ignore-submodules=none');
     assert.match(porcelain,/evil[.]test[.]mjs/);
     const result=observeGit({repoPath:f.r});
     assert.equal(result.clean,false,'Falso limpio por check-ignore pathspec magic: '+name);
   }finally{f.close();}
 });
}
