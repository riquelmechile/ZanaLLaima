import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {observeGit} from '../src/git-evidence.mjs';
const git=(r,...args)=>execFileSync('git',['-C',r,...args],{encoding:'utf8'}).trim();
const cases=[
 ['dist','/dist/*\n!/dist/index.js\n','dist/index.js'],
 ['cfg','cfg/**\n!cfg/keep\n','cfg/keep'],
 ['logs','logs/*\n!logs/.gitkeep\n','logs/.gitkeep'],
 ['nested','a/b/*\n!a/b/c.js\n','a/b/c.js'],
 ['whitelist','*\n!*/\n!*.js\n','src/keep.js'],
 ['storage','storage/**\n!storage/**/\n!storage/**/.gitkeep\n','storage/cache/.gitkeep']
];
for(const [label,rules,path] of cases){
 test('R9-C2 negación en directorio '+label+' no oculta '+path,()=>{
   const base=mkdtempSync(join(tmpdir(),'zana-r9-neg-')),repo=join(base,'repo');
   try{
     mkdirSync(repo);git(repo,'init','-qb','main');git(repo,'config','user.name','Test');
     git(repo,'config','user.email','test@example.invalid');
     writeFileSync(join(repo,'.gitignore'),rules);
     writeFileSync(join(repo,'tracked.txt'),'original');
     git(repo,'add','-f','.gitignore','tracked.txt');git(repo,'commit','-qm','base');git(repo,'checkout','-qb','feature/neg');
     mkdirSync(dirname(join(repo,path)),{recursive:true});
     writeFileSync(join(repo,path),'untracked\n');
     const output=git(repo,'status','--porcelain=v1','-uall','--ignore-submodules=none');
     assert.notEqual(output.length,0,'Git debe mostrar el archivo re-incluido '+path);
     const observation=observeGit({repoPath:repo});
     assert.equal(observation.clean,false,
       'Falso negativo de negación en '+label+': '+JSON.stringify(observation));
   }finally{rmSync(base,{recursive:true,force:true});}
 });
}
