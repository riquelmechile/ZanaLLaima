import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {REMOTE_TOOL_NAMES} from '../src/remote.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const skill=readFileSync(join(root,'skills/zana-project-orchestrator/SKILL.md'),'utf8');
function sourceFiles(dir){
  return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
    const path=join(dir,entry.name);
    return entry.isDirectory()?sourceFiles(path):/\.[cm]?js$/.test(entry.name)?[path]:[];
  });
}
const sources=sourceFiles(join(root,'src')).map(p=>readFileSync(p,'utf8')).join('\n');

test('C4: cada tool zana_* de la skill está expuesta en REMOTE_TOOL_NAMES',()=>{
  const tools=[...new Set(skill.match(/\bzana_[a-z][a-z0-9_]*\b/g)??[])];
  assert.ok(tools.length>=10);
  for(const tool of tools)assert.ok(REMOTE_TOOL_NAMES.includes(tool),'Tool inexistente: '+tool);
});
test('C4: cada código MAYÚSCULAS_CON_GUION_BAJO de la skill existe en src/',()=>{
  const codes=[...new Set(skill.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)??[])];
  assert.ok(codes.length>=10);
  for(const code of codes)assert.ok(sources.includes(code),'Código inexistente: '+code);
});
