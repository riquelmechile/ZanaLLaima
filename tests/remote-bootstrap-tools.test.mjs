import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture} from './helpers/remote-fixture.mjs';
import {BOOTSTRAP_TOKEN,AUTHOR_TOKEN} from './helpers/fake-github.mjs';
import {answers,alternatives} from './helpers/plan-fixture.mjs';

// Borrador con plan aprobado y creación del repositorio pedida (y autorizada si se indica).
async function ready({token=true,authorized=true,name='gestor'}={}){
  const f=await remoteFixture({envExtra:{ZANA_PUBLIC_HOST:'zanallaima.test',ZANA_GITHUB_REPOS:'O/*',
    ...(token?{ZANA_BOOTSTRAP_GITHUB_TOKEN:BOOTSTRAP_TOKEN}:{})}});
  const s=await f.session('zana-chatgpt','oauth-one');
  const w0=await f.call('zana_workspace_create',{idea:'Plataforma privada para gestionar proyectos de desarrollo'},s);
  const w1=await f.call('zana_workspace_update',{workspaceId:w0.workspaceId,expectedVersion:0,answers},s);
  const plan=await f.call('zana_project_plan_draft',{brief:w1.brief,alternatives,selectedId:'node',
    milestones:[{id:'core',objective:'Diseñar',acceptance:'Tests',dependsOn:[]}]},s);
  await f.call('zana_workspace_update',{workspaceId:w0.workspaceId,expectedVersion:1,plan},s);
  const p=await f.call('zana_plan_approval_request',{workspaceId:w0.workspaceId,expectedVersion:2},s);
  await f.runtime.planApproval.decide({approvalId:p.approvalId,decision:'allow',passwordOk:true});
  const ask=()=>f.call('zana_bootstrap_request',{workspaceId:w0.workspaceId,expectedVersion:2,owner:'O',name,visibility:'private'},s);
  const authorize=async()=>{const r=await ask();await f.runtime.planApproval.decide({approvalId:r.authorization.approvalId,decision:'allow',passwordOk:true});return r;};
  const op=authorized?await authorize():await ask();
  const creates=()=>f.api.state.requests.filter(x=>x.method==='POST'&&x.path==='/user/repos');
  return {f,s,op,ask,authorize,creates,args:{operationId:op.operationId}};
}

test('zana_bootstrap_execute crea el repositorio con el token de bootstrap, una sola vez',async()=>{
  const t=await ready();
  try{
    const done=await t.f.call('zana_bootstrap_execute',t.args,t.s);
    assert.deepEqual({state:done.state,reused:done.reused,auth:done.authorization.status,name:done.created.fullName,priv:done.created.private},
      {state:'DONE',reused:false,auth:'CONSUMED',name:'O/gestor',priv:true});
    const [{description,...body}]=t.creates().map(x=>JSON.parse(x.body));
    assert.deepEqual([t.creates()[0].token===BOOTSTRAP_TOKEN,body],[true,{name:'gestor',private:true,auto_init:true}]);
    assert.ok(description.startsWith('Creado por ZanaLLaima (operación '+t.op.operationId+', intento '));
    assert.ok(t.f.api.state.requests.every(x=>x.path!=='/user/repos'||x.token!==AUTHOR_TOKEN),'el token de misiones no crea repositorios');
    assert.equal((await t.f.call('zana_bootstrap_execute',t.args,t.s)).reused,true);
    assert.equal(t.creates().length,1);
    assert.equal((await t.f.call('zana_bootstrap_status',t.args,t.s)).created.fullName,'O/gestor');
    const other=await t.f.session('zana-chatgpt','oauth-other');
    assert.match((await t.f.call('zana_bootstrap_execute',t.args,other)).error,/BOOTSTRAP_NOT_FOUND/);
    assert.match((await t.f.call('zana_bootstrap_reconcile',t.args,t.s)).error,/NOTHING_TO_RECONCILE/);
    const health=await t.f.runtime.health();
    assert.equal(health.bootstrapToken,'configured');
  }finally{await t.f.cleanup();}
});

test('sin token de bootstrap o sin autorización del operador no se crea nada',async()=>{
  const noToken=await ready({token:false});
  try{
    assert.match((await noToken.f.call('zana_bootstrap_execute',noToken.args,noToken.s)).error,/BOOTSTRAP_TOKEN_MISSING/);
    assert.equal((await noToken.f.call('zana_bootstrap_status',noToken.args,noToken.s)).authorization.status,'APPROVED','no se gastó la autorización');
    assert.equal((await noToken.f.runtime.health()).bootstrapToken,'missing');
    assert.equal((await noToken.f.runtime.health()).status,'ok','el token de bootstrap es opcional');
  }finally{await noToken.f.cleanup();}
  const pending=await ready({authorized:false});
  try{
    assert.match((await pending.f.call('zana_bootstrap_execute',pending.args,pending.s)).error,/AUTHORIZATION_REQUIRED/);
    assert.equal(pending.creates().length,0);
  }finally{await pending.f.cleanup();}
});

test('rechazo claro, resultado incierto y reconciliación por las tools, sin filtrar el token',async()=>{
  const t=await ready();
  try{
    t.f.api.state.failCreate={status:422,message:'Repository creation failed.',errors:[{code:'custom',field:'name',message:'name is reserved '+BOOTSTRAP_TOKEN}]};
    const rejected=await t.f.call('zana_bootstrap_execute',t.args,t.s);
    assert.match(rejected.error,/CREATE_REJECTED: GitHub HTTP 422/);
    assert.ok(!JSON.stringify(rejected).includes(BOOTSTRAP_TOKEN),'el token nunca sale en un resultado');
    const st=await t.f.call('zana_bootstrap_status',t.args,t.s);
    assert.deepEqual([st.state,st.authorization.status],['AWAITING_AUTHORIZATION','CONSUMED']);
    assert.ok(st.lastError&&!st.lastError.includes(BOOTSTRAP_TOKEN));
    assert.match(st.lastError,/name is reserved/,'la causa real viene en errors[].message');
    // Nueva autorización; ahora GitHub falla sin responder claro, pero el repositorio sí quedó creado.
    await t.authorize();
    t.f.api.state.failCreate={status:502,message:'bad gateway',createAnyway:body=>({id:9001,full_name:'O/'+body.name,private:true,description:body.description,
      html_url:'https://github.test/O/'+body.name,default_branch:'main',created_at:new Date().toISOString(),owner:{login:'O'}})};
    assert.match((await t.f.call('zana_bootstrap_execute',t.args,t.s)).error,/OUTCOME_UNKNOWN/);
    assert.match((await t.f.call('zana_bootstrap_execute',t.args,t.s)).error,/RECONCILIATION_REQUIRED/);
    assert.equal(t.creates().length,2,'el intento incierto no se repite');
    const adopted=await t.f.call('zana_bootstrap_reconcile',t.args,t.s);
    assert.deepEqual([adopted.state,adopted.created.id],['DONE',9001]);
    const made=(await t.f.runtime.readAudit({limit:80})).filter(x=>x.tool==='bootstrap_repository');
    assert.deepEqual(made.map(x=>[x.outcome,x.detail.fullName,x.detail.id,x.detail.operationId]),[['ADOPTED','O/gestor',9001,t.op.operationId]],'la auditoría nombra lo que se creó');
    const audit=(await t.f.runtime.readAudit({limit:80})).filter(x=>x.tool.startsWith('zana_bootstrap_'));
    assert.ok(audit.some(x=>x.tool==='zana_bootstrap_execute')&&audit.some(x=>x.tool==='zana_bootstrap_reconcile'));
    assert.ok(!JSON.stringify(audit).includes(BOOTSTRAP_TOKEN));
  }finally{await t.f.cleanup();}
});

// Ronda de corrección tras la revisión 4R.
test('el token de bootstrap no puede ser el de misiones, y pedir de nuevo un repo ya creado no abre otra operación',async()=>{
  const shared=await remoteFixture({envExtra:{ZANA_GITHUB_REPOS:'O/*',ZANA_BOOTSTRAP_GITHUB_TOKEN:AUTHOR_TOKEN}});
  try{
    const s=await shared.session('zana-chatgpt','oauth-one');
    assert.match((await shared.call('zana_bootstrap_execute',{operationId:'11111111-1111-4111-8111-111111111111'},s)).error,/BOOTSTRAP_TOKEN_SHARED/);
    const health=await shared.runtime.health();
    assert.ok(health.problems.some(x=>/ZANA_BOOTSTRAP_GITHUB_TOKEN/.test(x)),'el /health avisa la mala configuración');
  }finally{await shared.cleanup();}
  const t=await ready();
  try{
    const done=await t.f.call('zana_bootstrap_execute',t.args,t.s);
    assert.equal(done.state,'DONE');
    const created=(await t.f.runtime.readAudit({limit:80})).filter(x=>x.tool==='bootstrap_repository');
    assert.deepEqual(created.map(x=>[x.outcome,x.detail.fullName,x.detail.private]),[['CREATED','O/gestor',true]]);
    const again=await t.ask();
    assert.deepEqual([again.operationId,again.state,again.created.fullName,again.authorization.approvalUrl],[t.op.operationId,'DONE','O/gestor',null],
      'devuelve la operación hecha, sin pedir otra autorización');
  }finally{await t.f.cleanup();}
});
