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
    assert.equal(REMOTE_TOOL_NAMES.length,39);
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
