import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {observeGit} from '../src/git-evidence.mjs';

const git=(p,...args)=>execFileSync('git',['-C',p,...args],{
  encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'zana-r6-submodule-'));
  const root=join(dir,'repo');mkdirSync(root);
  git(root,'init','-q','-b','main');
  git(root,'config','user.name','Security Test');
  git(root,'config','user.email','security@example.invalid');
  writeFileSync(join(root,'f.txt'),'abc');
  git(root,'add','f.txt');git(root,'commit','-qm','baseline');
  git(root,'checkout','-qb','feature/rdd');
  return {dir,root,close:()=>rmSync(dir,{recursive:true,force:true})};
}
function child(f,name){
  const dir=join(f.dir,name+'-source');mkdirSync(dir);
  git(dir,'init','-q','-b','main');
  git(dir,'config','user.name','Security Test');
  git(dir,'config','user.email','security@example.invalid');
  writeFileSync(join(dir,'f.txt'),'abc');
  writeFileSync(join(dir,'.gitattributes'),'f.txt filter=evil\n');
  git(dir,'add','.');git(dir,'commit','-qm','tracked attributes');
  return dir;
}
for(const depth of [1,2])test('P1-a: submodule filter never executes, nesting '+depth,()=>{
  const f=fixture();
  try{
    const lib=child(f,'lib');
    if(depth===2){
      const inner=child(f,'inner');
      git(lib,'-c','protocol.file.allow=always','submodule','add',inner,'inner');
      git(lib,'commit','-qam','track nested gitlink');
    }
    git(f.root,'-c','protocol.file.allow=always','submodule','add',lib,'lib');
    git(f.root,'commit','-qam','track submodule');
    const nested=join(f.root,'lib');
    if(depth===2)git(nested,'-c','protocol.file.allow=always',
      'submodule','update','--init','--recursive');
    const target=depth===2?join(nested,'inner'):nested;
    const marker=join(f.dir,'FILTER_RAN');
    git(target,'config','filter.evil.clean','sh -c "touch '+marker+'; cat"');
    writeFileSync(join(target,'f.txt'),'xyz'); // misma longitud, distinto blob
    try{assert.equal(observeGit({repoPath:f.root}).clean,false);}
    catch(error){assert.match(error.message,/Git candidate rejected:.*(filter|attr|normaliz)/i);}
    assert.equal(existsSync(marker),false,'Git ejecutó el filtro antes de inspeccionar el submódulo');
  }finally{f.close();}
});
