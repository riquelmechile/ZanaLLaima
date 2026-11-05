import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {observeGit} from '../src/git-evidence.mjs';
const git=(r,...a)=>execFileSync('git',['-C',r,...a],{encoding:'utf8'}).trim();
test('R9-C3: 150 carreras .gitignore no pueden declarar limpio un evil.mjs adicional',()=>{
 const dir=mkdtempSync(join(tmpdir(),'zana-r9-race-')),repo=join(dir,'repo');
 let child;
 try{
  mkdirSync(repo);git(repo,'init','-qb','main');git(repo,'config','user.name','Race');
  git(repo,'config','user.email','race@example.invalid');
  writeFileSync(join(repo,'.gitignore'),'safe/\n');writeFileSync(join(repo,'tracked.txt'),'base\n');
  git(repo,'add','.');git(repo,'commit','-qm','base');git(repo,'checkout','-qb','feature/race');
  writeFileSync(join(repo,'evil.mjs'),'malicious();\n');
  const script=String.raw`
    const {writeFileSync,renameSync}=require('node:fs');
    const path=process.argv[1],tmpA=process.argv[2],tmpB=process.argv[3];
    while(true){
      writeFileSync(tmpA,'evil.mjs\n');renameSync(tmpA,path);
      writeFileSync(tmpB,'safe/\n');renameSync(tmpB,path);
    }
  `;
  child=spawn(process.execPath,['-e',script,join(repo,'.gitignore'),
    join(dir,'tmp-a'),join(dir,'tmp-b')],{stdio:'ignore'});
  let bad=0;
  for(let i=0;i<150;i++){
   try{if(observeGit({repoPath:repo}).clean===true)bad++;}
   catch(e){assert.match(e.message,/Git candidate rejected/);}
  }
  assert.equal(bad,0,'Una carrera entre copiar y hashear .gitignore produjo '+bad+' falsos clean:true');
 }finally{child?.kill('SIGKILL');rmSync(dir,{force:true,recursive:true});}
});
