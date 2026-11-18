import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture,sha} from './helpers/remote-fixture.mjs';
import {makePlan} from './helpers/plan-fixture.mjs';
import {remoteRead,remoteWrite} from '../src/store.mjs';
import {saveRun,loadRun} from '../src/project-run-store.mjs';
import {GitHubApi,GitHubApiError} from '../src/github-api.mjs';
import {fakeGitHubApi,AUTHOR_TOKEN} from './helpers/fake-github.mjs';
import {sessionIsWriter} from '../src/remote-state.mjs';

const repo='o/r',head=sha('f'),merged=sha('9');
// Modela compare base...head por dirección: invertir los SHA cambia el status.
function directionalCompare(state,statuses){
  state.onCompareFiles=()=>{
    const path=state.requests.at(-1)?.path??'';
    const pair=path.split('/compare/')[1]??'';
    state.compareStatus=Object.hasOwn(statuses,pair)?statuses[pair]:'diverged';
  };
}

async function setup(envExtra={}){
  const f=await remoteFixture({envExtra:{ZANA_REQUIRED_CHECKS:'test,security',...envExtra}});
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
    assert.deepEqual(await f.call('zana_project_delivery_status',{repo},owner),
      {ready:false,code:'PROJECT_INCOMPLETE',pending:['core']});
    assert.match((await f.call('zana_project_delivery_status',{repo},other)).error??'',/RUN_OTHER_CLIENT/);
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
test('GitHub caído se informa sin elevar prueba; revisora sigue sin ser escritora',async()=>{
  const {f,owner,run}=await setup();
  try{
    await complete(f,run);
    const reviewer=await f.session('reviewer','reviewer-client');
    f.api.state.failNext={status:503,message:'down'};
    const r=await f.call('zana_project_delivery_status',{repo},owner);
    assert.equal(r.code,'GITHUB_UNAVAILABLE');assert.equal(r.ready,false);
    assert.match((await f.call('zana_project_delivery_status',{repo},reviewer)).error??'',/RUN_OTHER_CLIENT/);
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

async function foreignReadRejected(f,run,session){
  const before=await remoteRead(db=>JSON.stringify(loadRun(db,run.projectId)));
  const response=await f.call('zana_project_delivery_status',{repo},session);
  assert.match(response.error??'',/RUN_OTHER_CLIENT/,JSON.stringify(response));
  assert.equal(await remoteRead(db=>JSON.stringify(loadRun(db,run.projectId))),before);
  assert.equal(await remoteRead(db=>sessionIsWriter(db,session.sessionId)),false);
}

test('delivery_status: dueño permitido; otro OAuth y revisora rechazados sin mutación',async()=>{
  const {f,owner,run}=await setup();
  try{
    await complete(f,run);
    assert.equal((await f.call('zana_project_delivery_status',{repo},owner)).ready,true);
    await foreignReadRejected(f,run,await f.session('other','foreign-client'));
    await foreignReadRejected(f,run,await f.session('review-monitor','oauth-review'));
  }finally{await f.cleanup();}
});

test('compare direccional: behind y diverged jamás integran el merge',async()=>{
  for(const status of ['behind','diverged']){
    const {f,owner,run}=await setup();
    try{
      await complete(f,run);
      directionalCompare(f.api.state,{[merged+'...'+head]:status,[head+'...'+merged]:'ahead'});
      const r=await f.call('zana_project_delivery_status',{repo},owner);
      assert.equal(r.code,'MILESTONE_NOT_INTEGRATED',status);
      assert.equal(r.milestoneId,'core');
      assert.equal(r.mergeCommitSha,merged);
    }finally{await f.cleanup();}
  }
});

test('segundo hito no integrado: identifica el hito concreto, no el primero',async()=>{
  const {f,owner,run}=await setup();
  try{
    const ready=await complete(f,run);
    const secondSha=sha('8');
    const next={...ready,revision:ready.revision+1,milestones:[...ready.milestones,
      {...ready.milestones[0],id:'docs',parts:[{...ready.milestones[0].parts[0],
        missionId:'milestone-second',prNumber:8,mergeCommitSha:secondSha}]}]};
    await remoteWrite(db=>saveRun(db,ready,next));
    directionalCompare(f.api.state,{[merged+'...'+head]:'ahead',[secondSha+'...'+head]:'behind'});
    const r=await f.call('zana_project_delivery_status',{repo},owner);
    assert.equal(r.code,'MILESTONE_NOT_INTEGRATED');
    assert.equal(r.milestoneId,'docs');assert.equal(r.prNumber,8);
    assert.equal(r.mergeCommitSha,secondSha);
  }finally{await f.cleanup();}
});

test('si la base avanza durante compare, BASE_MOVED muestra ambos SHA',async()=>{
  const {f,owner,run}=await setup();
  try{
    await complete(f,run);
    const newHead=sha('e');
    f.api.state.onCompareFiles=()=>f.api.state.push('main',newHead);
    const r=await f.call('zana_project_delivery_status',{repo},owner);
    assert.deepEqual(r,{ready:false,code:'BASE_MOVED',sha:head,currentSha:newHead});
  }finally{await f.cleanup();}
});

test('si cambia revisión mientras se verifica pero sigue READY, RUN_CHANGED',async()=>{
  const {f,owner,run}=await setup();
  try{
    const ready=await complete(f,run);
    let called=false;
    f.api.state.onCompareFiles=async()=>{
      if(called)return;called=true;
      await remoteWrite(db=>saveRun(db,ready,{...ready,revision:ready.revision+1}));
    };
    const r=await f.call('zana_project_delivery_status',{repo},owner);
    assert.deepEqual(r,{ready:false,code:'RUN_CHANGED',revision:ready.revision+1});
  }finally{await f.cleanup();}
});

test('override de checks por repositorio bloquea entrega aunque default esté verde',async()=>{
  const {f,owner,run}=await setup({ZANA_REPO_CHECKS_JSON:JSON.stringify({
    'o/r':{workflow:'zana-checks.yml',requiredChecks:['required-by-repo']}})});
  try{
    await complete(f,run);
    const r=await f.call('zana_project_delivery_status',{repo},owner);
    assert.equal(r.code,'CI_NOT_GREEN');
    assert.deepEqual(r.checks.missing,['required-by-repo']);
  }finally{await f.cleanup();}
});

test('compare 404 se distingue de GITHUB_UNAVAILABLE con datos del hito',async()=>{
  const {f,owner,run}=await setup();
  try{
    await complete(f,run);
    f.api.state.compareFilesError={status:404,message:'Commit not found'};
    const r=await f.call('zana_project_delivery_status',{repo},owner);
    assert.deepEqual(r,{ready:false,code:'MILESTONE_COMMIT_MISSING',
      milestoneId:'core',prNumber:7,mergeCommitSha:merged});
  }finally{await f.cleanup();}
});

test('containsCommit compara en el sentido correcto y conserva el 404 tipado',async()=>{
  const f=await fakeGitHubApi();
  try{
    const api=new GitHubApi({baseUrl:f.url,token:AUTHOR_TOKEN});
    const statuses=['ahead','identical','behind','diverged'];
    for(let i=0;i<statuses.length;i++){
      const from=sha(String(i+1)),to=head,status=statuses[i];
      directionalCompare(f.state,{[from+'...'+to]:status,[to+'...'+from]:'ahead'});
      assert.equal(await api.containsCommit(repo,from,to),i<2,status);
      assert.ok(f.state.requests.at(-1).path.endsWith('/compare/'+from+'...'+to));
    }
    assert.equal(await api.containsCommit(repo,head,head),true);
    f.state.compareFilesError={status:404,message:'not found'};
    await assert.rejects(api.containsCommit(repo,merged,head),e=>
      e instanceof GitHubApiError&&e.status===404);
  }finally{await f.close();}
});

test('si la corrida deja READY durante compare, conserva PROJECT_INCOMPLETE',async()=>{
  const {f,owner,run}=await setup();
  try{
    const ready=await complete(f,run);
    f.api.state.onCompareFiles=async()=>remoteWrite(db=>saveRun(db,ready,{
      ...ready,revision:ready.revision+1,status:'ACTIVE',
      milestones:ready.milestones.map(m=>({...m,status:'PENDING',parts:[]}))}));
    const r=await f.call('zana_project_delivery_status',{repo},owner);
    assert.deepEqual(r,{ready:false,code:'PROJECT_INCOMPLETE',pending:['core']});
  }finally{await f.cleanup();}
});

test('compare 503 sigue informando GITHUB_UNAVAILABLE',async()=>{
  const {f,owner,run}=await setup();
  try{
    await complete(f,run);
    f.api.state.compareFilesError={status:503,message:'temporarily unavailable'};
    const r=await f.call('zana_project_delivery_status',{repo},owner);
    assert.deepEqual(r,{ready:false,code:'GITHUB_UNAVAILABLE'});
  }finally{await f.cleanup();}
});
