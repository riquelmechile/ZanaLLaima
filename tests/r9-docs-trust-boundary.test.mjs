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
test('R9-C6: versión 0.5.0 y todas las guías operativas son coherentes',()=>{
 assert.equal(pkg.version,'0.5.0','Ronda 9 debe declarar 0.5.0');
 const files=[...allMarkdown(new URL('..',import.meta.url).pathname).filter(p=>!p.includes('/')),
   ...allMarkdown(new URL('../docs/',import.meta.url).pathname,'docs')];
 assert.ok(files.length>=12,'Debe recorrer TODOS los documentos de raíz y docs');
 for(const path of files){
  const s=readFileSync(new URL('../'+path,import.meta.url),'utf8');
  if(path!=='CHANGELOG.md'){
   assert.doesNotMatch(s,/(?:job|trabajo)\s+\x60?attest\x60?/i,path+': job attest obsoleto');
   for(const m of s.matchAll(/\b0\.\d+\.\d+\b/g))
    assert.equal(m[0],pkg.version,path+': versión obsoleta '+m[0]);
  }else{
   assert.ok(s.includes('## ['+pkg.version+']'), 'CHANGELOG no declara versión actual');
  }
 }
});
