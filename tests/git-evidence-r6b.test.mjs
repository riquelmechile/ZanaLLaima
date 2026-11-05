import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {observeGit} from '../src/git-evidence.mjs';

const git=(p,...args)=>execFileSync('git',['-C',p,...args],{
  encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const fixture=()=>{
  const dir=mkdtempSync(join(tmpdir(),'zana-r6-config-'));
  const repo=join(dir,'repo');mkdirSync(repo);
  git(repo,'init','-q','-b','main');
  git(repo,'config','user.name','Security Test');
  git(repo,'config','user.email','security@example.invalid');
  writeFileSync(join(repo,'f.txt'),'abc');
  writeFileSync(join(repo,'.gitattributes'),'f.txt filter=evil\n');
  git(repo,'add','.');git(repo,'commit','-qm','baseline');
  git(repo,'checkout','-qb','feature/rdd');
  return {dir,repo,close:()=>rmSync(dir,{recursive:true,force:true})};
};

for(const variant of ['worktree','include','includeIf','local-attributes']){
  test('P1-b: no se ejecutan filtros desde '+variant,()=>{
    const f=fixture();
    try{
      const marker=join(f.dir,'FILTER_EXECUTED');
      const command='sh -c "touch '+marker+'; printf abc"';
      if(variant==='worktree'){
        git(f.repo,'config','extensions.worktreeConfig','true');
        git(f.repo,'config','--worktree','filter.evil.clean',command);
      }else if(variant==='include'||variant==='includeIf'){
        const configPath=join(f.dir,'untrusted-git-config');
        writeFileSync(configPath,'[filter "evil"]\n\tclean = '+JSON.stringify(command)+'\n');
        if(variant==='include')git(f.repo,'config','include.path',configPath);
        else git(f.repo,'config','includeIf.gitdir:'+join(f.repo,'.git')+'.path',configPath);
      }else{
        git(f.repo,'config','filter.evil.clean',command);
      }
      assert.equal(git(f.repo,'config','--get','filter.evil.clean'),command,
        'la configuración maliciosa debe ser efectiva');
      writeFileSync(join(f.repo,'f.txt'),'xyz'); // filtro podría convertir xyz a abc
      try{assert.equal(observeGit({repoPath:f.repo}).clean,false,
        'Git no debe declarar limpio el contenido diferente');}
      catch(error){assert.match(error.message,/Git candidate rejected:.*(filter|attr|normaliz)/i);}
      assert.equal(existsSync(marker),false,'observeGit ejecutó el filtro '+variant);
    }finally{f.close();}
  });
}
