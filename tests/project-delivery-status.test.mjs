import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture,sha} from './helpers/remote-fixture.mjs';
import {makePlan} from './helpers/plan-fixture.mjs';
import {remoteRead,remoteWrite} from '../src/store.mjs';
import {saveRun} from '../src/project-run-store.mjs';
import {sessionIsWriter} from '../src/remote-state.mjs';

const repo='o/r',head=sha('f'),merged=sha('9');
async function setup(){
  const f=await remoteFixture({envExtra:{ZANA_REQUIRED_CHECKS:'test,security'}});
  const owner=await f.session();
  let w=await f.call('zana_workspace_create',{idea:'Gestionar un proyecto con hitos verificados'},owner);
  w=await f.call('zana_workspace_update',{workspaceId:w.workspaceId,expectedVersion:0,
    answers:{goal:'Hitos',users:'Equipos',platform:'Web',features:'Hitos',data:'Sin secretos'}},owner);
  w=await f.call('zana_workspace_update',{workspaceId:w.workspaceId,expectedVersion:1,plan:makePlan(w.brief)},owner);
  const req=await f.call('zana_plan_approval_request',{workspaceId:w.workspaceId,expectedVersion:w.version},owner);
  await f.runtime.planApproval.decide({approvalId:req.approvalId,decision:'allow',passwordOk:true});
  const started=await f.call('zana_project_run_start',{workspaceId:w.workspaceId,repo,base:'main'},owner);
  assert.equal(started.error,undefined,started.error);
  return {f,owner,run:started.run};
}
async function complete(f,run){
  const next={...run,revision:run.revision+1,status:'READY_TO_DELIVER',updatedAt:new Date().toISOString(),
    milestones:run.milestones.map((m,i)=>({...m,status:'DONE',parts:[{
      missionId:'milestone-'+i,prNumber:i+7,headSha:sha('a'),mergeCommitSha:merged,
      final:true,at:new Date().toISOString()}]}))};
  await remoteWrite(db=>saveRun(db,run,next));
  f.api.state.push('main',head);
  f.api.state.green(head,'test');
  f.api.state.green(head,'security');
  return next;
}
test('tool de lectura: sin corrida y con hitos incompletos, sin marca escritora',async()=>{
  const {f,owner}=await setup();
  try{
    const other=await f.session('other','foreign-client');
    assert.deepEqual(await f.call('zana_project_delivery_status',{repo},other),
      {ready:false,code:'PROJECT_INCOMPLETE',pending:['core']});
    assert.equal(await remoteRead(db=>sessionIsWriter(db,other.sessionId)),false);
    assert.deepEqual(await f.call('zana_project_delivery_status',{repo:'o/no-run'},owner),
      {ready:false,code:'RUN_NOT_FOUND'});
  }finally{await f.cleanup();}
});
test('READY verifica cabeza, todos los merges, checks requeridos y no autoriza deploy',async()=>{
  const {f,owner,run}=await setup();
  try{
    await complete(f,run);
    const result=await f.call('zana_project_delivery_status',{repo},owner);
    assert.equal(result.ready,true,JSON.stringify(result));
    assert.equal(result.sha,head);assert.equal(result.base,'main');
    assert.equal(result.milestones[0].parts[0].mergeCommitSha,merged);
    assert.equal(result.checks.state,'SUCCESS');
    assert.equal('deploymentAuthorized' in result,false);
    assert.equal(f.api.state.merges.length,0);
  }finally{await f.cleanup();}
});
test('merge fuera de historia devuelve MILESTONE_NOT_INTEGRATED',async()=>{
  const {f,owner,run}=await setup();
  try{
    await complete(f,run);f.api.state.compareStatus='diverged';
    const result=await f.call('zana_project_delivery_status',{repo},owner);
    assert.equal(result.code,'MILESTONE_NOT_INTEGRATED');
    assert.equal(result.ready,false);
  }finally{await f.cleanup();}
});
test('check requerido ausente o fallido devuelve CI_NOT_GREEN',async()=>{
  const {f,owner,run}=await setup();
  try{
    await complete(f,run);
    f.api.state.checkRuns[head]=f.api.state.checkRuns[head].filter(x=>x.name==='test');
    let r=await f.call('zana_project_delivery_status',{repo},owner);
    assert.equal(r.code,'CI_NOT_GREEN');assert.deepEqual(r.checks.missing,['security']);
    f.api.state.checkRuns[head][0].conclusion='failure';
    r=await f.call('zana_project_delivery_status',{repo},owner);
    assert.equal(r.code,'CI_NOT_GREEN');assert.equal(r.checks.state,'FAILURE');
  }finally{await f.cleanup();}
});
test('GitHub caído se informa sin elevar prueba y otra sesión solo lee',async()=>{
  const {f,owner,run}=await setup();
  try{
    await complete(f,run);
    const reviewer=await f.session('reviewer','reviewer-client');
    f.api.state.failNext={status:503,message:'down'};
    const r=await f.call('zana_project_delivery_status',{repo},reviewer);
    assert.equal(r.code,'GITHUB_UNAVAILABLE');assert.equal(r.ready,false);
    assert.equal(await remoteRead(db=>sessionIsWriter(db,reviewer.sessionId)),false);
  }finally{await f.cleanup();}
});

test('revisora con ticket reclamado puede leer sin quedar escritora',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId}=await f.authorReady();
    const req=await f.call('zana_review_request',{missionId},author);
    assert.equal(req.error,undefined,req.error);
    const reviewer=await f.session('review-monitor','oauth-review');
    const claim=await f.call('zana_review_claim',{ticket:req.ticket},reviewer);
    assert.equal(claim.error,undefined,claim.error);
    const result=await f.call('zana_project_delivery_status',{repo},reviewer);
    assert.equal(result.code,'RUN_NOT_FOUND');
    assert.equal(await remoteRead(db=>sessionIsWriter(db,reviewer.sessionId)),false);
  }finally{await f.cleanup();}
});
