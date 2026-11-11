import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture} from './helpers/remote-fixture.mjs';
import {REMOTE_TOOL_NAMES} from '../src/remote.mjs';

const sources=[
  {id:'node',technology:'Node',rationale:'Integración',benefits:'TypeScript',tradeoffs:'Runtime',
    sources:[{title:'Node docs',url:'https://nodejs.org/docs/',checkedOn:'2026-11-10'}]},
  {id:'go',technology:'Go',rationale:'Concurrencia',benefits:'Binario',tradeoffs:'Otro lenguaje',
    sources:[{title:'Go docs',url:'https://go.dev/doc/',checkedOn:'2026-11-10'}]},
];
test('discovery y plan MCP funcionan sin misión ni repositorio',async()=>{
  const f=await remoteFixture();
  try{
    const session=await f.session();
    const brief=await f.call('zana_discovery_start',{idea:'Crear un sistema seguro para gestionar pedidos completos'},session);
    assert.equal(brief.status,'COLLECTING');
    const questions=await f.call('zana_discovery_questions',{brief,limit:2},session);
    assert.deepEqual(questions.map(x=>x.key),['goal','users']);
    const answered=await f.call('zana_discovery_answer',{brief,answers:{
      goal:'Organizar pedidos',users:'Comerciantes',platform:'Web',
      features:'Pedidos y cuentas',data:'Datos personales'}},session);
    assert.equal(answered.status,'READY_FOR_PLAN');
    const plan=await f.call('zana_project_plan_draft',{brief:answered,alternatives:sources,
      selectedId:'node',milestones:[{id:'core',objective:'Modelo',acceptance:'Tests',dependsOn:[]}]},session);
    assert.equal(plan.approval,'PENDING_AUTHENTICATED_USER');
    const proposal=await f.call('zana_bootstrap_prepare',{plan,owner:'o',name:'new-repo'},session);
    assert.equal(proposal.status,'AWAITING_AUTHORIZATION');
    assert.equal(proposal.visibility,'private');
    assert.deepEqual(f.api.state.dispatches,[],'no CI or external write');
    assert.deepEqual(f.api.state.pulls,[],'no PR or repository created');
    assert.equal(REMOTE_TOOL_NAMES.length,44);
  }finally{await f.cleanup();}
});
test('tampers y documentos sin fuente no crean propuesta',async()=>{
  const f=await remoteFixture();
  try{
    const session=await f.session();
    const bad=await f.call('zana_discovery_start',{idea:'x'},session);
    assert.match(bad.error,/INVALID|too_small|at least/i);
    const draft=await f.call('zana_project_plan_draft',{brief:{schema:'zana.discovery.v1'},
      alternatives:sources,selectedId:'node',milestones:[]},session);
    assert.ok(draft.error);
    const proposal=await f.call('zana_bootstrap_prepare',{plan:{schema:'fake'},owner:'o',name:'repo'},session);
    assert.match(proposal.error,/INVALID_PLAN/);
  }finally{await f.cleanup();}
});

test('workspace OAuth persiste entre sesiones, rechaza versiones obsoletas y clientes ajenos',async()=>{
  const f=await remoteFixture();
  try{
    const author=await f.session('zana-chatgpt','oauth-one');
    const w=await f.call('zana_workspace_create',{idea:'Plataforma privada para gestionar proyectos de desarrollo'},author);
    assert.equal(w.version,0);assert.equal(w.plan,null);
    const same=await f.session('zana-chatgpt','oauth-one');
    assert.equal((await f.call('zana_workspace_get',{workspaceId:w.workspaceId},same)).workspaceId,w.workspaceId);
    const v1=await f.call('zana_workspace_update',{workspaceId:w.workspaceId,expectedVersion:0,answers:{
      goal:'Gestionar proyectos',users:'Desarrolladores',platform:'Web',features:'Misiones',data:'Sin secretos'}},same);
    assert.equal(v1.version,1);
    const stale=await f.call('zana_workspace_update',{workspaceId:w.workspaceId,expectedVersion:0,answers:{goal:'Cambio'}},same);
    assert.match(stale.error,/STALE_REVISION/);
    const foreign=await f.session('zana-chatgpt','oauth-other');
    assert.match((await f.call('zana_workspace_get',{workspaceId:w.workspaceId},foreign)).error,/WORKSPACE_NOT_FOUND/);
    const p=await f.call('zana_project_plan_draft',{brief:v1.brief,alternatives:sources,
      selectedId:'node',milestones:[{id:'core',objective:'Diseñar',acceptance:'Tests',dependsOn:[]}]},same);
    const stored=await f.call('zana_workspace_update',{workspaceId:w.workspaceId,expectedVersion:1,plan:p},same);
    assert.equal(stored.plan.digest,p.digest);
    assert.deepEqual(f.api.state.dispatches,[]);
  }finally{await f.cleanup();}
});

test('workspace MCP: lista paginada, archiva, restaura y aísla OAuth',async()=>{
  const f=await remoteFixture();
  try{
    const owner=await f.session('zana-chatgpt','oauth-owner');
    const other=await f.session('zana-chatgpt','oauth-other');
    const created=[];
    for(let i=0;i<3;i++)created.push(await f.call('zana_workspace_create',{
      idea:'Proyecto privado de trabajo y gestión número '+i},owner));
    await f.call('zana_workspace_create',{idea:'Proyecto de otro cliente distinto'},other);
    const page1=await f.call('zana_workspace_list',{limit:2},owner);
    assert.equal(page1.items.length,2);assert.ok(page1.nextCursor);
    const page2=await f.call('zana_workspace_list',{limit:2,cursor:page1.nextCursor},owner);
    assert.equal(page2.items.length,1);assert.equal(page2.nextCursor,null);
    const all=[...page1.items,...page2.items];
    assert.deepEqual(all.map(x=>x.workspaceId).sort(),created.map(x=>x.workspaceId).sort());
    assert.ok(all.every(x=>!('brief' in x)&&!('plan' in x)&&!('ownerClient' in x)));
    assert.equal((await f.call('zana_workspace_list',{},other)).items.length,1);
    const target=created[0];
    assert.match((await f.call('zana_workspace_set_archived',{
      workspaceId:target.workspaceId,expectedVersion:0,archived:true},other)).error,/WORKSPACE_NOT_FOUND/);
    const archived=await f.call('zana_workspace_set_archived',{
      workspaceId:target.workspaceId,expectedVersion:0,archived:true},owner);
    assert.ok(archived.archivedAt);assert.equal(archived.version,1);
    assert.equal((await f.call('zana_workspace_list',{},owner)).items.length,2);
    assert.equal((await f.call('zana_workspace_list',{includeArchived:true},owner)).items.length,3);
    assert.match((await f.call('zana_workspace_set_archived',{
      workspaceId:target.workspaceId,expectedVersion:0,archived:false},owner)).error,/STALE_REVISION/);
    const restored=await f.call('zana_workspace_set_archived',{
      workspaceId:target.workspaceId,expectedVersion:1,archived:false},owner);
    assert.equal(restored.version,2);assert.equal(restored.archivedAt,null);
  }finally{await f.cleanup();}
});
