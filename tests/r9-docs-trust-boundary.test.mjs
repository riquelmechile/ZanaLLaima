import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
function allMarkdown(dir,relative=''){
 return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
  const rel=relative?relative+'/'+entry.name:entry.name;
  if(entry.isDirectory())return allMarkdown(join(dir,entry.name),rel);
  return entry.isFile()&&entry.name.endsWith('.md')?[rel]:[];
 });
}
test('R9-C6: documento de frontera RDD no admite verificador Git antiguo',()=>{
 const s=readFileSync(new URL('../docs/solo-rdd.md',import.meta.url),'utf8');
 for(const old of ['fsck','ls-tree','ls-files','hash-object','--exclude-standard'])
  assert.equal(s.includes(old),false,'Método RDD inseguro/obsoleto en docs: '+old);
 assert.match(s,/commit[\s\S]*re-hash|re-hash[\s\S]*commit/i);
 assert.match(s,/shadow|gitdir privado/i);
 assert.match(s,/Node/);
 assert.match(s,/shallow/i);
});
test('R10: versión activa e historia delimitada',()=>{
 assert.equal(pkg.version,'0.6.0');
 const files=[...allMarkdown(new URL('..',import.meta.url).pathname).filter(p=>!p.includes('/')),
  ...allMarkdown(new URL('../docs/',import.meta.url).pathname,'docs')];
 assert.ok(files.length>=12);
 for(const path of files){
  const s=readFileSync(new URL('../'+path,import.meta.url),'utf8');
  if(path==='CHANGELOG.md'){assert.ok(s.includes('## ['+pkg.version+']'));continue;}
  let historical=false;
  for(const [i,line] of s.split('\n').entries()){
   if(line.includes('<!-- HISTORICAL_VERSIONS_START -->')){historical=true;continue;}
   if(line.includes('<!-- HISTORICAL_VERSIONS_END -->')){historical=false;continue;}
   assert.doesNotMatch(line,/(?:job|trabajo)\s+\x60?attest\x60?/i,path);
   if(!historical)for(const m of line.matchAll(/\b0\.\d+\.\d+\b/g))
    assert.equal(m[0],pkg.version,path+': versión fuera de historia línea '+(i+1));
  }
  assert.equal(historical,false,path+': historia sin cerrar');
 }
});
test('R10: errores y comandos del runbook corresponden al código real',()=>{
 const docs=readFileSync(new URL('../docs/sqlite-storage.md',import.meta.url),'utf8');
 const cli=readFileSync(new URL('../src/cli.mjs',import.meta.url),'utf8');
 const table=docs.split('**Diagnóstico y acciones del operador:**')[1]?.split('Comandos de operador')[0];
 assert.ok(table,'Sin tabla de errores');
 const mentioned=new Set([...table.matchAll(/\x60([A-Z][A-Z_]+)\x60/g)].map(m=>m[1]));
 const source=['src/store.mjs','src/restore-journal.mjs'].map(path=>
  readFileSync(new URL('../'+path,import.meta.url),'utf8')).join('\n');
 const actual=new Set([...source.matchAll(/(?:guardRestore|refuse)\('([A-Z_]+)'/g)].map(m=>m[1]));
 for(const code of actual)assert.ok(mentioned.has(code),'Código sin remedio '+code);
 const usage=cli.match(/const usage='Commands: ([^']+)'/)?.[1];
 assert.ok(usage);
 const commands=new Set(usage.split(',').map(s=>s.trim()));
 for(const m of docs.matchAll(/node src\/cli\.mjs ([a-z][a-z-]+)/g))
  assert.ok(commands.has(m[1]),'Comando sin CLI: '+m[1]);
});
