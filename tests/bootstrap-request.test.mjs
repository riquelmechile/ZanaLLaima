import test from 'node:test';
import assert from 'node:assert/strict';
import {updateProjectWorkspace} from '../src/project-workspace.mjs';
import {approvedPlanDigest,planApprovalStatus,requestPlanApproval,describePlanApproval,decidePlanApproval} from '../src/plan-approval.mjs';
import {requestBootstrap,bootstrapStatus,bootstrapAuthorized} from '../src/bootstrap-request.mjs';
import {planFixture,draft,T0,HOUR,answers,alternatives} from './helpers/plan-fixture.mjs';
import {remoteFixture} from './helpers/remote-fixture.mjs';

const allowed=repo=>repo.toLowerCase().startsWith('acme/');
const ask=(f,extra={})=>requestBootstrap(f.db,{...f.at,expectedVersion:f.w.version,owner:'acme',name:'gestor',visibility:'private',allowed,now:T0,...extra});
const decide=(f,approvalId,decision='allow',now=T0)=>decidePlanApproval(f.db,{approvalId,decision,passwordOk:decision==='allow',now});

test('crear el repositorio exige plan aprobado y deja una autorización pendiente propia',()=>{
  const none=planFixture();
  try{assert.throws(()=>ask(none),/PLAN_NOT_APPROVED/);}finally{none.db.close();}
  const f=planFixture({approved:true});
  try{
    assert.throws(()=>ask(f,{owner:'otra'}),/REPO_NOT_ALLOWED/);
    assert.throws(()=>ask(f,{name:'../x'}),/INVALID_REPOSITORY/);
    assert.throws(()=>ask(f,{visibility:'internal'}),/INVALID_VISIBILITY/);
    assert.throws(()=>ask(f,{expectedVersion:0}),/STALE_REVISION/);
    assert.throws(()=>ask(f,{clientId:'oauth-other'}),/WORKSPACE_NOT_FOUND/);
    const r=ask(f);
    assert.deepEqual({state:r.state,repository:r.repository,visibility:r.visibility,planDigest:r.planDigest,auth:r.authorization.status},
      {state:'AWAITING_AUTHORIZATION',repository:'acme/gestor',visibility:'private',planDigest:f.w.plan.digest,auth:'PENDING'});
    assert.equal(bootstrapAuthorized(f.db,{clientId:f.client,operationId:r.operationId,now:T0}),false,'pedir no autoriza');
    const again=ask(f,{now:T0+1000});
    assert.deepEqual([again.operationId,again.authorization.approvalId],[r.operationId,r.authorization.approvalId],'repetir no crea otra operación');
    assert.notEqual(ask(f,{name:'otro',now:T0+2000}).operationId,r.operationId);
    const view=describePlanApproval(f.db,{approvalId:r.authorization.approvalId,now:T0});
    assert.deepEqual({effect:view.effect,status:view.status,repository:view.repository,plan:view.plan},
      {effect:'CREATE_REPOSITORY',status:'PENDING',repository:{fullName:'acme/gestor',visibility:'private',intentDigest:r.intentDigest},plan:null});
    assert.equal(view.idea,f.w.brief.idea);
    assert.equal(bootstrapStatus(f.db,{clientId:f.client,operationId:r.operationId,now:T0}).authorization.status,'PENDING');
    assert.throws(()=>bootstrapStatus(f.db,{clientId:'oauth-other',operationId:r.operationId,now:T0}),/BOOTSTRAP_NOT_FOUND/);
  }finally{f.db.close();}
});

test('solo el operador autoriza crear el repositorio, y eso no toca la aprobación del plan',()=>{
  const f=planFixture({approved:true});
  try{
    const r=ask(f),aid=r.authorization.approvalId,op={clientId:f.client,operationId:r.operationId};
    assert.equal(decidePlanApproval(f.db,{approvalId:aid,decision:'allow',passwordOk:false,now:T0}).denied,true);
    assert.equal(bootstrapAuthorized(f.db,{...op,now:T0}),false);
    assert.equal(decide(f,aid).status,'APPROVED');
    assert.equal(bootstrapAuthorized(f.db,{...op,now:T0}),true);
    assert.equal(bootstrapAuthorized(f.db,{clientId:'oauth-other',operationId:r.operationId,now:T0}),false);
    assert.equal(approvedPlanDigest(f.db,f.at),f.w.plan.digest,'la aprobación del plan sigue intacta');
    const plan=planApprovalStatus(f.db,{...f.at,now:T0});
    assert.deepEqual({status:plan.status,approvalId:plan.approvalId},{status:'APPROVED',approvalId:f.planApprovalId});
    assert.equal(requestPlanApproval(f.db,{...f.at,expectedVersion:f.w.version,now:T0}).approvalId,f.planApprovalId);
    assert.equal(bootstrapStatus(f.db,{...op,now:T0}).authorization.status,'APPROVED');
    assert.equal(bootstrapAuthorized(f.db,{...op,now:T0+24*HOUR}),false,'la autorización de crear vence a las 24 horas');
    assert.equal(bootstrapStatus(f.db,{...op,now:T0+24*HOUR}).authorization.status,'EXPIRED');
    const renewed=ask(f,{now:T0+24*HOUR});
    assert.equal(renewed.operationId,r.operationId);
    assert.notEqual(renewed.authorization.approvalId,aid,'vencida, se pide de nuevo sobre la misma operación');
  }finally{f.db.close();}
});

test('la autorización de crear cae si se revoca, se rechaza o cambia el plan aprobado',()=>{
  const revoked=planFixture({approved:true});
  try{
    const r=ask(revoked),op={clientId:revoked.client,operationId:r.operationId,now:T0};
    decide(revoked,r.authorization.approvalId);
    assert.equal(decide(revoked,r.authorization.approvalId,'revoke').status,'REVOKED');
    assert.equal(bootstrapAuthorized(revoked.db,op),false);
    assert.equal(approvedPlanDigest(revoked.db,revoked.at),revoked.w.plan.digest,'revocar el repo no revoca el plan');
  }finally{revoked.db.close();}
  const planGone=planFixture({approved:true});
  try{
    const r=ask(planGone),op={clientId:planGone.client,operationId:r.operationId,now:T0};
    decide(planGone,r.authorization.approvalId);
    decide(planGone,planGone.planApprovalId,'revoke');
    assert.equal(bootstrapAuthorized(planGone.db,op),false,'sin plan aprobado no hay permiso de crear');
    assert.equal(bootstrapStatus(planGone.db,op).authorization.status,'SUPERSEDED');
    assert.throws(()=>ask(planGone),/PLAN_NOT_APPROVED/);
  }finally{planGone.db.close();}
  const changed=planFixture({approved:true});
  try{
    const r=ask(changed),aid=r.authorization.approvalId;
    updateProjectWorkspace(changed.db,{...changed.at,expectedVersion:changed.w.version,plan:draft(changed.w.brief,'Otro modelo')});
    assert.equal(decide(changed,aid).status,'SUPERSEDED','autorizar un repo para un plan que ya cambió no vale');
    assert.equal(bootstrapAuthorized(changed.db,{clientId:changed.client,operationId:r.operationId,now:T0}),false);
  }finally{changed.db.close();}
  const denied=planFixture({approved:true});
  try{
    const r=ask(denied);
    assert.equal(decide(denied,r.authorization.approvalId,'deny').status,'DENIED');
    assert.equal(bootstrapStatus(denied.db,{clientId:denied.client,operationId:r.operationId,now:T0}).authorization.status,'DENIED');
    assert.equal(approvedPlanDigest(denied.db,denied.at),denied.w.plan.digest);
  }finally{denied.db.close();}
});

test('tools MCP: se pide y se consulta, sin crear nada en GitHub',async()=>{
  const f=await remoteFixture({envExtra:{ZANA_PUBLIC_HOST:'zanallaima.test',ZANA_GITHUB_REPOS:'O/*'}});
  try{
    const s=await f.session('zana-chatgpt','oauth-one');
    const w0=await f.call('zana_workspace_create',{idea:'Plataforma privada para gestionar proyectos de desarrollo'},s);
    const w1=await f.call('zana_workspace_update',{workspaceId:w0.workspaceId,expectedVersion:0,answers},s);
    const plan=await f.call('zana_project_plan_draft',{brief:w1.brief,alternatives,selectedId:'node',
      milestones:[{id:'core',objective:'Diseñar',acceptance:'Tests',dependsOn:[]}]},s);
    await f.call('zana_workspace_update',{workspaceId:w0.workspaceId,expectedVersion:1,plan},s);
    const args={workspaceId:w0.workspaceId,expectedVersion:2,owner:'O',name:'gestor',visibility:'private'};
    assert.match((await f.call('zana_bootstrap_request',args,s)).error,/PLAN_NOT_APPROVED/);
    const p=await f.call('zana_plan_approval_request',{workspaceId:w0.workspaceId,expectedVersion:2},s);
    await f.runtime.planApproval.decide({approvalId:p.approvalId,decision:'allow',passwordOk:true});
    assert.match((await f.call('zana_bootstrap_request',{...args,owner:'ajeno'},s)).error,/REPO_NOT_ALLOWED/);
    const r=await f.call('zana_bootstrap_request',args,s);
    assert.equal(r.state,'AWAITING_AUTHORIZATION');
    assert.equal(r.authorization.approvalUrl,'https://zanallaima.test/operator/approve?aid='+r.authorization.approvalId);
    await f.runtime.planApproval.decide({approvalId:r.authorization.approvalId,decision:'allow',passwordOk:true});
    const st=await f.call('zana_bootstrap_status',{operationId:r.operationId},s);
    assert.deepEqual({state:st.state,auth:st.authorization.status,repository:st.repository},
      {state:'AWAITING_AUTHORIZATION',auth:'APPROVED',repository:'O/gestor'});
    const other=await f.session('zana-chatgpt','oauth-other');
    assert.match((await f.call('zana_bootstrap_status',{operationId:r.operationId},other)).error,/BOOTSTRAP_NOT_FOUND/);
    assert.deepEqual(f.api.state.pulls,[],'autorizar no crea nada en GitHub');
  }finally{await f.cleanup();}
});

// Ronda de corrección tras la revisión 4R.
test('revocar el plan mata la autorización del repo aunque el plan se apruebe de nuevo',()=>{
  const f=planFixture({approved:true});
  try{
    const r=ask(f),op={clientId:f.client,operationId:r.operationId,now:T0};
    decide(f,r.authorization.approvalId);
    decide(f,f.planApprovalId,'revoke');
    const again=requestPlanApproval(f.db,{...f.at,expectedVersion:f.w.version,now:T0});
    decide(f,again.approvalId);
    assert.equal(approvedPlanDigest(f.db,f.at),f.w.plan.digest,'el plan vuelve a estar aprobado, con otra aprobación');
    assert.equal(bootstrapAuthorized(f.db,op),false,'la autorización colgaba de la aprobación revocada');
    assert.equal(bootstrapStatus(f.db,op).authorization.status,'SUPERSEDED');
    const fresh=ask(f);
    assert.deepEqual([fresh.operationId,fresh.authorization.status],[r.operationId,'PENDING'],'hay que autorizar otra vez');
  }finally{f.db.close();}
});

test('la autorización informa su vencimiento real, queda auditable y no vale para un intento fabricado',()=>{
  const f=planFixture({approved:true});
  try{
    const r=ask(f),op={clientId:f.client,operationId:r.operationId};
    const done=decide(f,r.authorization.approvalId,'allow',T0+30*60_000);
    assert.deepEqual(done.subject,{operationId:r.operationId,intentDigest:r.intentDigest,repo:'acme/gestor',visibility:'private'},
      'la decisión lleva el repositorio para la auditoría');
    const st=bootstrapStatus(f.db,{...op,now:T0+10*HOUR});
    assert.deepEqual([st.authorization.status,st.authorization.expiresAt],['APPROVED','2026-11-12T12:30:00.000Z']);
    assert.equal(ask(f,{now:T0+10*HOUR}).authorization.expiresAt,'2026-11-12T12:30:00.000Z');
    // Volver a pedir mantiene viva la operación: no se poda con una autorización vigente.
    assert.equal(ask(f,{name:'otro',now:T0+49*HOUR}).state,'AWAITING_AUTHORIZATION');
    assert.equal(bootstrapStatus(f.db,{...op,now:T0+49*HOUR}).operationId,r.operationId);
    // Una operación fabricada no hereda la aprobación del plan ni la de otro intento.
    const key='zana:bootstrap:'+r.operationId,row=JSON.parse(f.db.prepare('SELECT value FROM metadata WHERE key=?').get(key).value);
    const put=v=>f.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(v),key);
    put({...row,approvalId:f.planApprovalId});
    assert.equal(bootstrapAuthorized(f.db,{...op,now:T0+HOUR}),false,'la aprobación del plan no autoriza el repo');
    put({...row,intent:{...row.intent,visibility:'public'}});
    assert.equal(bootstrapAuthorized(f.db,{...op,now:T0+HOUR}),false,'un intento alterado no vale');
    put(row);
    assert.equal(bootstrapAuthorized(f.db,{...op,now:T0+HOUR}),true);
  }finally{f.db.close();}
});
