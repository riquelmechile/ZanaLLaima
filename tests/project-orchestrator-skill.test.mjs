import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {remoteFixture} from './helpers/remote-fixture.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const skill=readFileSync(join(root,'skills/zana-project-orchestrator/SKILL.md'),'utf8');
function sourceFiles(dir){
  return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
    const path=join(dir,entry.name);
    return entry.isDirectory()?sourceFiles(path):/\.[cm]?js$/.test(entry.name)?[path]:[];
  });
}
const sources=sourceFiles(join(root,'src')).map(p=>readFileSync(p,'utf8')).join('\n');
const stringLiterals=sources.match(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|\x60(?:\\.|[^\x60\\\n])*\x60/g)??[];

test('C5: cada tool zana_* de la skill está en listTools MCP real',async()=>{
  const f=await remoteFixture({envExtra:{ZANA_GITHUB_FULL_ACCESS:'true',ZANA_BOOTSTRAP_GITHUB_TOKEN:'c5-test-fixture-only'}});
  let server,client;
  try{
    const owner=await f.session();
    server=f.runtime.createServer(async()=>owner);
    client=new Client({name:'c5-skill-tools',version:'1.0'});
    const [ct,st]=InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st),client.connect(ct)]);
    const real=new Set((await client.listTools()).tools.map(t=>t.name));
    const names=[...new Set(skill.match(/\bzana_[a-z][a-z0-9_]*\b/g)??[])];
    assert.ok(names.length>=10);
    for(const name of names)assert.ok(real.has(name),'Tool MCP inexistente: '+name);
  }finally{
    await client?.close();await server?.close();await f.cleanup();
  }
});
test('C5: códigos completos de la skill existen como literales en src/',()=>{
  const codes=[...new Set(skill.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)??[])];
  assert.ok(codes.length>=10);
  for(const code of codes){
    const word=new RegExp('\\b'+code+'\\b');
    assert.ok(stringLiterals.some(s=>word.test(s)),'Código inexistente: '+code);
  }
  assert.equal(stringLiterals.some(s=>/\bPR_STILL\b/.test(s)),false);
});

test('C6: la skill explica cierre sin campo run',()=>{
  assert.ok(skill.includes('sin campo `run`'));
});
