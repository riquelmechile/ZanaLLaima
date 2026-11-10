import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture} from './helpers/remote-fixture.mjs';
import {CATALOG} from '../src/github-policy.mjs';
import {REMOTE_TOOL_NAMES,remoteAnnotations} from '../src/remote.mjs';

const read=(f,operation,args,s)=>f.call('zana_ds_github_read',{operation,arguments:args},s);
const errText=r=>r.error??r.raw?.content?.[0]?.text??r.content?.[0]?.text??'';

test('zana_ds_github_read: lee e indexa sin misión',async()=>{
  const f=await remoteFixture();
  try{
    const {author}=await f.authorReady();
    const index=await read(f,'index',{},author);
    assert.equal(index.catalogVersion,CATALOG.version);
    assert.equal((await read(f,'index',{operation:'push_files'},author)).rule,'files');
    const file=await read(f,'get_file_contents',{owner:'o',repo:'r',path:'README.md'},author);
    assert.equal(Boolean(file.error||file.isError),false);
    assert.equal(f.ds.calls.filter(c=>c.name==='get_file_contents').length,1);
  }finally{await f.cleanup();}
});

test('zana_ds_github_read: nada que no sea lectura sale hacia GitHub',async()=>{
  const f=await remoteFixture({mcp:{extra:[{name:'shiny_read',annotations:{readOnlyHint:true}}],
    annotationsOverride:{get_me:{readOnlyHint:false,destructiveHint:false}}}});
  try{
    const {author,missionId}=await f.authorReady();
    const before=f.ds.calls.length;
    const notRead=Object.entries(CATALOG.tools).filter(([,t])=>t.zana!=='read').map(([name])=>name);
    assert.ok(notRead.includes('push_files')&&notRead.includes('merge_pull_request')&&notRead.includes('delete_file'));
    for(const name of notRead)
      assert.match(errText(await read(f,name,{owner:'o',repo:'r',branch:'zana/'+missionId},author)),/NOT_A_READ/,name);
    // Sin clasificar o desconocida: tampoco.
    for(const name of ['shiny_read','does_not_exist','constructor','__proto__','toString'])
      assert.match(errText(await read(f,name,{},author)),/NOT_A_READ/,name);
    // El catálogo dice lectura pero el servidor ya no la declara de solo lectura: la política la niega.
    assert.match(errText(await read(f,'get_me',{},author)),/CLASSIFICATION_DRIFT/);
    // missionId no es parte de la tool de lectura.
    assert.ok(errText(await f.call('zana_ds_github_read',{operation:'get_file_contents',missionId,
      arguments:{owner:'o',repo:'r',path:'README.md'}},author)));
    assert.equal(f.ds.calls.length,before,'ninguna llamada llegó al downstream');
  }finally{await f.cleanup();}
});

test('anotaciones: solo lectura sin confirmación, destructivas solo las que lo son',()=>{
  const destructive=[],readOnly=[];
  for(const name of REMOTE_TOOL_NAMES){
    const a=remoteAnnotations(name);
    for(const key of ['readOnlyHint','destructiveHint','openWorldHint','idempotentHint'])
      assert.equal(typeof a[key],'boolean',name+'.'+key);
    if(a.readOnlyHint){readOnly.push(name);assert.equal(a.destructiveHint,false,name);}
    if(a.destructiveHint)destructive.push(name);
  }
  assert.deepEqual(destructive,['zana_budget_extend','zana_ds_github','zana_merge','zana_mission_cancel']);
  assert.ok(readOnly.includes('zana_ds_github_read'));
  assert.equal(remoteAnnotations('zana_ds_github').readOnlyHint,false);
  for(const name of ['zana_ds_github','zana_ds_github_read'])assert.equal(remoteAnnotations(name).openWorldHint,true,name);
  assert.equal(remoteAnnotations('zana_merge').openWorldHint,false);
  // Una tool que no está en ninguna lista se trata como destructiva.
  assert.deepEqual(remoteAnnotations('zana_tool_nueva'),
    {readOnlyHint:false,destructiveHint:true,openWorldHint:false,idempotentHint:false});
});
