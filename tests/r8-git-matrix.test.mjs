import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,chmodSync,symlinkSync,renameSync,appendFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {observeGit} from '../src/git-evidence.mjs';

const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{
 encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000}).trim();
const put=(root,path,data='extra\n')=>{
 const target=join(root,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,data);
};
const del=(root,path)=>rmSync(join(root,path),{recursive:true,force:true});
const scenarios=[];
const add=(name,mutate,{ignore='',attrs='',seed}={})=>scenarios.push({name,mutate,ignore,attrs,seed});

add('baseline sin modificaciones',()=>{});
for(const [name,path,bytes] of [
 ['f reemplazado','f.txt','replacement\n'],
 ['g reemplazado','g.sh','echo replacement\n'],
 ['f línea agregada','f.txt','same\nsecond line\n'],
 ['f vacío','f.txt',''],
 ['g espacio final','g.sh','echo baseline \n'],
 ['f unicode','f.txt','jalapeño\n'],
 ['documentación editada','docs/a.md','updated docs\n'],
 ['f de 1 MiB','f.txt','x'.repeat(1024*1024)],
 ['f CRLF','f.txt','same\r\n']
])add('contenido: '+name,r=>put(r,path,bytes));
for(const path of ['f.txt','g.sh','docs/a.md','tracked-dir/keep.txt'])
 add('eliminado '+path,r=>del(r,path));
add('eliminados f y g',r=>{del(r,'f.txt');del(r,'g.sh');});
for(const [path,mode] of [['f.txt',0o755],['g.sh',0o755],
 ['docs/a.md',0o700],['tracked-dir/keep.txt',0o744]])
 add('modo '+path+' '+mode.toString(8),r=>chmodSync(join(r,path),mode));
add('staged f cambiado',r=>{put(r,'f.txt','staged f\n');git(r,'add','f.txt');});
add('staged g cambiado',r=>{put(r,'g.sh','staged g\n');git(r,'add','g.sh');});
add('staged rename f',r=>git(r,'mv','f.txt','moved.txt'));
add('staged archivo extra',r=>{put(r,'added.js');git(r,'add','added.js');});
add('staged eliminación docs',r=>{del(r,'docs/a.md');git(r,'add','-u','docs/a.md');});
add('staged + unstaged f',r=>{put(r,'f.txt','staged\n');git(r,'add','f.txt');put(r,'f.txt','unstaged\n');});
add('f convertido a symlink',r=>{del(r,'f.txt');symlinkSync('g.sh',join(r,'f.txt'));});
add('g convertido a symlink',r=>{del(r,'g.sh');symlinkSync('f.txt',join(r,'g.sh'));});
add('symlink nuevo',r=>symlinkSync('f.txt',join(r,'new-link')));
for(const path of [
 'untracked.js','abc/d.txt','space dir/hello there.txt',
 ':build/evil.test.mjs','::x/evil.test.mjs',
 ':(top)x/evil.test.mjs',':!x/evil.test.mjs',
 'src/new.mjs','nested/deep/thing.txt','f+.new',
 'Ñuble/área.txt','.hidden/file.txt','z-dir/x.js'
])add('archivo extra '+path,r=>put(r,path),{ignore:'build/\n'});
for(const [label,ignore,path] of [
 ['build','build/\n','build/entry.bin'],
 ['venv','.venv/\n','.venv/file.pyc'],
 ['node_modules','node_modules/\n','node_modules/pkg/index.js'],
 ['cache','cache/\n','cache/item.bin'],
 ['out','out/\n','out/index.js'],
 ['logs','*.log\n','logs/a.log'],
 ['tmp','*.tmp\n','src/tmp.tmp']
])add('ignored legítimo '+label,r=>put(r,path),{ignore});
for(const [label,ignore,path] of [
 ['dist','/dist/*\n!/dist/index.js\n','dist/index.js'],
 ['cfg','cfg/**\n!cfg/keep\n','cfg/keep'],
 ['logs','logs/*\n!logs/.gitkeep\n','logs/.gitkeep'],
 ['nested','a/b/*\n!a/b/c.js\n','a/b/c.js'],
 ['whitelist','*\n!*/\n!*.js\n','src/keep.js'],
 ['storage','storage/**\n!storage/**/\n!storage/**/.gitkeep\n','storage/cache/.gitkeep']
])add('negación reincluye '+label,r=>put(r,path),{ignore});
for(const name of ['.venv','.pytest_cache'])
 add('Python autoignore '+name,r=>{
   put(r,name+'/.gitignore','*\n');
   put(r,name+'/cache.bin','untracked but ignored\n');
 });
add('repositorio anidado válido',r=>{
 const nested=join(r,'nested');mkdirSync(nested);git(nested,'init','-qb','main');
 git(nested,'config','user.name','Nested');git(nested,'config','user.email','nested@example.invalid');
 put(nested,'inner.txt');git(nested,'add','.');git(nested,'commit','-qm','nested');
});
add('directorio .git falso no es repositorio',r=>{
 mkdirSync(join(r,'nest','.git'),{recursive:true});put(r,'nest/file.txt','extra\n');
 put(r,'nest/.git/not-real','no credentials');
});
add('shallow clone limpio',r=>put(r,'.git/shallow',git(r,'rev-parse','HEAD')+'\n'));
add('atributo text=auto con LF idéntico',()=>{}, {attrs:'* text=auto\n'});
add('directorio vacío no rastreado',r=>mkdirSync(join(r,'empty')));
add('directorio anidado vacío',r=>mkdirSync(join(r,'a','b','empty'),{recursive:true}));
add('dos directorios vacíos',r=>{mkdirSync(join(r,'foo'));mkdirSync(join(r,'bar'));});
for(const type of ['clean','dirty','missing']){
 const seed=(root,dir)=>{
   const source=join(dir,'submodule-source');mkdirSync(source);
   git(source,'init','-qb','main');git(source,'config','user.name','Sub');
   git(source,'config','user.email','sub@example.invalid');
   put(source,'lib.txt','clean\n');git(source,'add','.');git(source,'commit','-qm','submodule');
   git(root,'-c','protocol.file.allow=always','submodule','add',source,'vendor/lib');
 };
 const mutate=type==='clean'?()=>{}:type==='dirty'
   ?r=>put(r,'vendor/lib/lib.txt','dirty\n')
   :r=>del(r,'vendor/lib');
 add('submódulo '+type,mutate,{seed});
}

test('R9: 60+ escenarios únicos contra git status porcelain -uall --ignore-submodules=none',()=>{
 const unique=new Set(scenarios.map(x=>x.name));
 assert.equal(unique.size,scenarios.length,'Los casos de la matriz deben ser distintos');
 assert.ok(scenarios.length>=60,'La matriz no puede repetir 10 escenarios seis veces');
 let falsePositives=0,falseNegatives=0;
 const discrepancies=[];
 for(const [index,s] of scenarios.entries()){
   const dir=mkdtempSync(join(tmpdir(),'zana-r9-matrix-')),repo=join(dir,'repo');
   try{
     mkdirSync(repo);git(repo,'init','-qb','main');
     git(repo,'config','user.name','Matrix');git(repo,'config','user.email','matrix@example.invalid');
     put(repo,'f.txt','same\n');put(repo,'g.sh','echo baseline\n');
     put(repo,'docs/a.md','original docs\n');put(repo,'tracked-dir/keep.txt','original\n');
     if(s.ignore)put(repo,'.gitignore',s.ignore);
     if(s.attrs)put(repo,'.gitattributes',s.attrs);
     if(s.seed)s.seed(repo,dir);
     git(repo,'add','.');
     // Una whitelist `*` ignora archivos base aunque tengan que estar rastreados.
     // Forzarlos en la línea base para que todas las fixtures tengan un commit real.
     git(repo,'add','-f','--','f.txt','g.sh','docs/a.md','tracked-dir/keep.txt');
     if(s.ignore)git(repo,'add','-f','--','.gitignore');
     if(s.attrs)git(repo,'add','-f','--','.gitattributes');
     git(repo,'commit','-qm','baseline');git(repo,'checkout','-qb','feature/matrix');
     s.mutate(repo);
     const status=git(repo,'status','--porcelain=v1','-uall','--ignore-submodules=none');
     const expectedClean=status.length===0;
     let actualClean,reason;
     try{
       const obs=observeGit({repoPath:repo});actualClean=obs.clean;reason=obs.reason;
     }catch(error){actualClean=false;reason=error.message;}
     if(expectedClean!==actualClean){
       if(actualClean)falseNegatives++;else falsePositives++;
       discrepancies.push({index,name:s.name,status,expectedClean,actualClean,reason});
     }
   }finally{rmSync(dir,{recursive:true,force:true});}
 }
 console.log('R9_GIT_STATUS_MATRIX_CASES='+scenarios.length+
   ' FALSE_POSITIVES='+falsePositives+' FALSE_NEGATIVES='+falseNegatives);
 assert.deepEqual(discrepancies,[],'Discrepancias Git: '+JSON.stringify(discrepancies));
});
