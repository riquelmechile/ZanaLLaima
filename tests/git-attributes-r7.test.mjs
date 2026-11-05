import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {observeGit} from '../src/git-evidence.mjs';
const git=(r,...args)=>execFileSync('git',['-C',r,...args],{encoding:'utf8'}).trim();
for(const a of [
 {label:'filter',rule:'filter=evil'},
 {label:'eol',rule:'eol=crlf'},
 {label:'ident',rule:'ident'},
 {label:'text auto con autocrlf',rule:'text=auto',autocrlf:true}
]){
 test('R7 W4: atributo '+a.label+' requiere rechazo explícito sin ejecutar drivers',()=>{
  const dir=mkdtempSync(join(tmpdir(),'zana-r7-attrs-')),repo=join(dir,'repo');
  try{
   mkdirSync(repo);git(repo,'init','-qb','main');
   git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.invalid');
   if(a.autocrlf)git(repo,'config','core.autocrlf','true');
   writeFileSync(join(repo,'.gitattributes'),'f.txt '+a.rule+'\n');
   writeFileSync(join(repo,'f.txt'),a.rule.includes('eol')?'line\r\n':'line\n');
   git(repo,'add','.');git(repo,'commit','-qm','attributes tracked');
   git(repo,'checkout','-qb','feature/attr');
   assert.throws(()=>observeGit({repoPath:repo}),/Git candidate rejected:.*(attr|filter|normaliz|eol|ident)/i,
     'El usuario necesita un rechazo explícito, no clean:false mudo');
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
}
