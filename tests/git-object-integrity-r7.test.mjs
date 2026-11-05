import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmodSync,copyFileSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {observeGit} from '../src/git-evidence.mjs';

const git=(dir,...args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'zana-r7-integrity-'));
  const repo=join(dir,'repo');mkdirSync(repo);
  git(repo,'init','-qb','main');
  git(repo,'config','user.name','Security Test');git(repo,'config','user.email','test@example.invalid');
  mkdirSync(join(repo,'src'));
  writeFileSync(join(repo,'src','app.mjs'), 'malicious();\n');
  git(repo,'add','.');git(repo,'commit','-qm','snapshot');
  git(repo,'checkout','-qb','feature/test');
  return {repo,dir,close:()=>rmSync(dir,{recursive:true,force:true})};
}
const objectFile=(repo,hash)=>join(repo,'.git','objects',hash.slice(0,2),hash.slice(2));
const shouldReject=repo=>{
  let dirty=false;
  try{dirty=observeGit({repoPath:repo}).clean===false;}
  catch(e){assert.match(e.message,/Git candidate rejected/);dirty=true;}
  assert.equal(dirty,true,'Se aceptaron bytes almacenados en Git sin re-hashearlos');
};
test('R7 CRITICAL 1: subárbol sustituido a igual SHA no debe parecer limpio',()=>{
  const f=fixture();try{
    const oldTree=git(f.repo,'rev-parse','HEAD:src');
    writeFileSync(join(f.repo,'src','app.mjs'),'harmless();\n');
    git(f.repo,'add','src/app.mjs');
    const newTree=git(f.repo,'write-tree');
    const newSubtree=git(f.repo,'rev-parse',newTree+':src');
    assert.notEqual(oldTree,newSubtree);
    chmodSync(objectFile(f.repo,oldTree),0o644); // Git 2.56 deja objetos loose 0444
    copyFileSync(objectFile(f.repo,newSubtree),objectFile(f.repo,oldTree));
    shouldReject(f.repo);
  }finally{f.close();}
});
test('R7 CRITICAL 1: blob corrupto en .git/objects se rechaza',()=>{
  const f=fixture();try{
    const oldBlob=git(f.repo,'rev-parse','HEAD:src/app.mjs');
    writeFileSync(join(f.repo,'other.txt'),'different blob bytes\n');
    const newBlob=git(f.repo,'hash-object','-w','other.txt');
    chmodSync(objectFile(f.repo,oldBlob),0o644);
    copyFileSync(objectFile(f.repo,newBlob),objectFile(f.repo,oldBlob));
    rmSync(join(f.repo,'other.txt'));
    shouldReject(f.repo);
  }finally{f.close();}
});
test('R7 CRITICAL 1: shallow y grafts alteran historia y se rechazan',()=>{
  const f=fixture();try{
    writeFileSync(join(f.repo,'.git','shallow'),git(f.repo,'rev-parse','HEAD')+'\n');
    shouldReject(f.repo);
    rmSync(join(f.repo,'.git','shallow'));
    writeFileSync(join(f.repo,'.git','info','grafts'),git(f.repo,'rev-parse','HEAD')+'\n');
    shouldReject(f.repo);
  }finally{f.close();}
});
test('R7 CRITICAL 1: objetos corruptos en alternates se rechazan',()=>{
  const f=fixture();try{
    const oldBlob=git(f.repo,'rev-parse','HEAD:src/app.mjs');
    const alt=join(f.dir,'altobjects');mkdirSync(alt);
    const altObj=join(alt,oldBlob.slice(0,2));mkdirSync(altObj);
    writeFileSync(join(f.repo,'other.txt'),'evil alternate bytes\n');
    const newBlob=git(f.repo,'hash-object','-w','other.txt');
    copyFileSync(objectFile(f.repo,newBlob),join(altObj,oldBlob.slice(2)));
    rmSync(objectFile(f.repo,oldBlob));rmSync(join(f.repo,'other.txt'));
    writeFileSync(join(f.repo,'.git','objects','info','alternates'),alt+'\n');
    shouldReject(f.repo);
  }finally{f.close();}
});

test('R7 CRITICAL 1: árbol raíz sustituido no conserva una identidad confiable',()=>{
 const f=fixture();try{
   const oldTree=git(f.repo,'rev-parse','HEAD^{tree}');
   writeFileSync(join(f.repo,'src','app.mjs'),'different bytes\n');
   git(f.repo,'add','src/app.mjs');
   const nextTree=git(f.repo,'write-tree');
   assert.notEqual(oldTree,nextTree);
   chmodSync(objectFile(f.repo,oldTree),0o644);
   copyFileSync(objectFile(f.repo,nextTree),objectFile(f.repo,oldTree));
   shouldReject(f.repo);
 }finally{f.close();}
});
test('R7 CRITICAL 1: commit sustituido no conserva SHA del contenido',()=>{
 const f=fixture();try{
   const old=git(f.repo,'rev-parse','HEAD');
   const next=git(f.repo,'commit-tree',git(f.repo,'rev-parse','HEAD^{tree}'),'-m','different author payload');
   assert.notEqual(old,next);
   chmodSync(objectFile(f.repo,old),0o644);
   copyFileSync(objectFile(f.repo,next),objectFile(f.repo,old));
   shouldReject(f.repo);
 }finally{f.close();}
});
test('R7 CRITICAL 1: mutación de un pack de objetos alcanzables se rechaza',()=>{
 const f=fixture();try{
   git(f.repo,'gc','--prune=now');
   const packdir=join(f.repo,'.git','objects','pack');
   const pack=readdirSync(packdir).find(name=>name.endsWith('.pack'));
   assert.ok(pack,'Fixture debe producir pack');
   const path=join(packdir,pack);
   const bytes=readFileSync(path);
   const pos=Math.floor(bytes.length*0.45);
   bytes[pos]^=1;
   chmodSync(path,0o644);writeFileSync(path,bytes);
   shouldReject(f.repo);
 }finally{f.close();}
});
