import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createProjectWorkspace,updateProjectWorkspace,setProjectWorkspaceArchived} from '../src/project-workspace.mjs';
import {draftProjectPlan} from '../src/project-discovery.mjs';
import {requestPlanApproval,planApprovalStatus,approvedPlanDigest,describePlanApproval,
  decidePlanApproval,APPROVAL_ID} from '../src/plan-approval.mjs';
import {remoteFixture} from './helpers/remote-fixture.mjs';

const client='oauth-operator-one',HOUR=3600_000,T0=Date.parse('2026-11-11T12:00:00Z');
const answers={goal:'Gestionar hitos',users:'Equipos',platform:'Web',features:'Planes',data:'Sin secretos'};
const alternatives=[
  {id:'node',technology:'Node',rationale:'Integración',benefits:'Ecosistema',tradeoffs:'Runtime',
    sources:[{title:'Node docs',url:'https://nodejs.org/docs/',checkedOn:'2026-11-10'}]},
  {id:'go',technology:'Go',rationale:'Concurrencia',benefits:'Binario',tradeoffs:'Otro stack',
    sources:[{title:'Go docs',url:'https://go.dev/doc/',checkedOn:'2026-11-10'}]}];
const draft=(brief,objective='Modelo')=>draftProjectPlan({brief,alternatives,selectedId:'node',
  milestones:[{id:'core',objective,acceptance:'Tests',dependsOn:[]}]});
function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const w0=createProjectWorkspace(db,{clientId:client,idea:'Crear un sitio de gestión de proyectos extensible'});
  const w1=updateProjectWorkspace(db,{clientId:client,workspaceId:w0.workspaceId,expectedVersion:0,answers});
  const w=updateProjectWorkspace(db,{clientId:client,workspaceId:w0.workspaceId,expectedVersion:1,plan:draft(w1.brief)});
  const at={clientId:client,workspaceId:w.workspaceId};
  return {db,w,at,request:(now=T0,extra={})=>requestPlanApproval(db,{...at,expectedVersion:w.version,now,...extra})};
}

test('pedir la aprobación no aprueba: queda pendiente y ligada al digest exacto',()=>{
  const {db,w,at,request}=fixture();
  try{
    assert.equal(planApprovalStatus(db,{...at,now:T0}).status,'NONE');
    const r=request();
    assert.match(r.approvalId,APPROVAL_ID);
    assert.deepEqual({status:r.status,planDigest:r.planDigest},{status:'PENDING',planDigest:w.plan.digest});
    assert.equal(approvedPlanDigest(db,at),null,'una solicitud nunca es una aprobación');
    assert.equal(request(T0+1000).approvalId,r.approvalId,'repetir la solicitud no crea otra');
    const s=planApprovalStatus(db,{...at,now:T0});
    assert.deepEqual({status:s.status,approvalId:s.approvalId,planDigest:s.planDigest},
      {status:'PENDING',approvalId:r.approvalId,planDigest:w.plan.digest});
    const view=describePlanApproval(db,{approvalId:r.approvalId,now:T0});
    assert.equal(view.status,'PENDING');
    assert.deepEqual(view.plan.milestones,[{id:'core',objective:'Modelo',acceptance:'Tests'}]);
    assert.equal(view.plan.selected.technology,'Node');
    assert.ok(!JSON.stringify(view).includes(client),'la página no expone el cliente OAuth');
  }finally{db.close();}
});

test('solo la decisión con contraseña correcta aprueba; el rechazo no la necesita',()=>{
  const {db,w,at,request}=fixture();
  try{
    const r=request();
    const bad=decidePlanApproval(db,{approvalId:r.approvalId,decision:'allow',passwordOk:false,now:T0});
    assert.deepEqual({status:bad.status,denied:bad.denied,attemptsLeft:bad.attemptsLeft},{status:'PENDING',denied:true,attemptsLeft:5});
    assert.equal(approvedPlanDigest(db,at),null);
    assert.throws(()=>decidePlanApproval(db,{approvalId:r.approvalId,decision:'yes',passwordOk:true,now:T0}),/INVALID_DECISION/);
    const ok=decidePlanApproval(db,{approvalId:r.approvalId,decision:'allow',passwordOk:true,now:T0});
    assert.deepEqual({status:ok.status,planDigest:ok.planDigest,workspaceId:ok.workspaceId},
      {status:'APPROVED',planDigest:w.plan.digest,workspaceId:w.workspaceId});
    assert.equal(approvedPlanDigest(db,at),w.plan.digest);
    assert.equal(planApprovalStatus(db,{...at,now:T0}).status,'APPROVED');
    assert.equal(request(T0+5000).status,'APPROVED','un plan ya aprobado no vuelve a pedir aprobación');
    assert.throws(()=>decidePlanApproval(db,{approvalId:r.approvalId,decision:'deny',passwordOk:false,now:T0}),/APPROVAL_NOT_PENDING/);
    assert.equal(approvedPlanDigest(db,{clientId:'oauth-other',workspaceId:w.workspaceId}),null,'otro cliente no ve la aprobación');
  }finally{db.close();}
  const second=fixture();
  try{
    const r=second.request();
    assert.equal(decidePlanApproval(second.db,{approvalId:r.approvalId,decision:'deny',passwordOk:false,now:T0}).status,'DENIED');
    assert.equal(planApprovalStatus(second.db,{...second.at,now:T0}).status,'DENIED');
    assert.equal(approvedPlanDigest(second.db,second.at),null);
    assert.notEqual(second.request(T0+1000).approvalId,r.approvalId,'tras un rechazo se puede volver a pedir');
  }finally{second.db.close();}
});

test('cambiar el plan invalida la aprobación y la solicitud pendiente',()=>{
  const {db,w,at,request}=fixture();
  try{
    const r=request();
    decidePlanApproval(db,{approvalId:r.approvalId,decision:'allow',passwordOk:true,now:T0});
    const w2=updateProjectWorkspace(db,{...at,expectedVersion:w.version,plan:draft(w.brief,'Otro modelo')});
    assert.notEqual(w2.plan.digest,w.plan.digest);
    assert.equal(approvedPlanDigest(db,at),null,'la aprobación era de otro digest');
    assert.equal(planApprovalStatus(db,{...at,now:T0}).status,'SUPERSEDED');
    assert.throws(()=>request(T0),/STALE_REVISION/,'hay que pedirla sobre la versión vigente');
    const r2=requestPlanApproval(db,{...at,expectedVersion:w2.version,now:T0});
    assert.equal(r2.planDigest,w2.plan.digest);
    // El plan cambia con la solicitud abierta: aprobarla no aprueba el plan nuevo.
    const w3=updateProjectWorkspace(db,{...at,expectedVersion:w2.version,plan:draft(w.brief,'Tercer modelo')});
    assert.equal(describePlanApproval(db,{approvalId:r2.approvalId,now:T0}).plan,null);
    assert.equal(decidePlanApproval(db,{approvalId:r2.approvalId,decision:'allow',passwordOk:true,now:T0}).status,'SUPERSEDED');
    assert.equal(approvedPlanDigest(db,at),null);
    // Volver al plan aprobado antes recupera su aprobación: el digest es el mismo.
    updateProjectWorkspace(db,{...at,expectedVersion:w3.version,plan:draft(w.brief)});
    assert.equal(approvedPlanDigest(db,at),w.plan.digest);
    const v=updateProjectWorkspace(db,{...at,expectedVersion:w3.version+1,answers:{goal:'Otra meta'}});
    assert.equal(approvedPlanDigest(db,at),null,'sin plan no hay aprobación');
    assert.throws(()=>requestPlanApproval(db,{...at,expectedVersion:v.version,now:T0}),/PLAN_REQUIRED/);
  }finally{db.close();}
});

test('caduca, se bloquea a los seis fallos y limita las solicitudes por día',()=>{
  const {db,w,at,request}=fixture();
  try{
    const r=request();
    assert.equal(planApprovalStatus(db,{...at,now:T0+HOUR}).status,'EXPIRED');
    assert.equal(describePlanApproval(db,{approvalId:r.approvalId,now:T0+HOUR}).status,'EXPIRED');
    assert.throws(()=>decidePlanApproval(db,{approvalId:r.approvalId,decision:'allow',passwordOk:true,now:T0+HOUR}),/APPROVAL_EXPIRED/);
    const r2=request(T0+HOUR);
    assert.notEqual(r2.approvalId,r.approvalId);
    for(let i=0;i<6;i++)decidePlanApproval(db,{approvalId:r2.approvalId,decision:'allow',passwordOk:false,now:T0+HOUR});
    assert.equal(planApprovalStatus(db,{...at,now:T0+HOUR}).status,'LOCKED');
    assert.throws(()=>decidePlanApproval(db,{approvalId:r2.approvalId,decision:'allow',passwordOk:true,now:T0+HOUR}),/APPROVAL_LOCKED/);
    assert.equal(approvedPlanDigest(db,at),null);
    for(let i=2;i<20;i++)request(T0+HOUR+i*HOUR); // cada una caduca antes de la siguiente
    assert.throws(()=>request(T0+23*HOUR),/APPROVAL_RATE_EXCEEDED/);
    const later=request(T0+50*HOUR);
    assert.equal(later.status,'PENDING','el límite es por 24 horas');
    const rows=db.prepare("SELECT COUNT(*) n FROM metadata WHERE key LIKE 'zana:approval:%'").get().n;
    assert.equal(rows,1,'las solicitudes viejas sin aprobar se podan');
    assert.throws(()=>describePlanApproval(db,{approvalId:r.approvalId,now:T0}),/APPROVAL_NOT_FOUND/);
    assert.throws(()=>describePlanApproval(db,{approvalId:'x',now:T0}),/APPROVAL_NOT_FOUND/);
    assert.throws(()=>requestPlanApproval(db,{clientId:'oauth-other',workspaceId:w.workspaceId,expectedVersion:w.version,now:T0}),/WORKSPACE_NOT_FOUND/);
    setProjectWorkspaceArchived(db,{...at,expectedVersion:w.version,archived:true});
    assert.throws(()=>requestPlanApproval(db,{...at,expectedVersion:w.version+1,now:T0+50*HOUR}),/WORKSPACE_ARCHIVED/);
    assert.equal(decidePlanApproval(db,{approvalId:later.approvalId,decision:'allow',passwordOk:true,now:T0+50*HOUR}).status,'SUPERSEDED',
      'un proyecto archivado no se aprueba');
  }finally{db.close();}
});

test('tools MCP: el modelo pide y consulta, pero ningún argumento suyo aprueba',async()=>{
  const f=await remoteFixture({envExtra:{ZANA_PUBLIC_HOST:'zanallaima.test'}});
  try{
    const s=await f.session('zana-chatgpt','oauth-one');
    const w0=await f.call('zana_workspace_create',{idea:'Plataforma privada para gestionar proyectos de desarrollo'},s);
    const w1=await f.call('zana_workspace_update',{workspaceId:w0.workspaceId,expectedVersion:0,answers},s);
    const plan=await f.call('zana_project_plan_draft',{brief:w1.brief,alternatives,selectedId:'node',
      milestones:[{id:'core',objective:'Diseñar',acceptance:'Tests',dependsOn:[]}]},s);
    await f.call('zana_workspace_update',{workspaceId:w0.workspaceId,expectedVersion:1,plan},s);
    // Por MCP el esquema estricto rechaza campos extra; aun sin él, un approved:true no aprueba.
    const r=await f.call('zana_plan_approval_request',{workspaceId:w0.workspaceId,expectedVersion:2,
      approved:true,status:'APPROVED',passwordOk:true},s);
    assert.equal(r.status,'PENDING');
    assert.equal(r.approvalUrl,'https://zanallaima.test/operator/approve?aid='+r.approvalId);
    assert.equal((await f.call('zana_plan_approval_status',{workspaceId:w0.workspaceId},s)).status,'PENDING');
    const other=await f.session('zana-chatgpt','oauth-other');
    assert.match((await f.call('zana_plan_approval_status',{workspaceId:w0.workspaceId},other)).error,/WORKSPACE_NOT_FOUND/);
    assert.equal((await f.runtime.planApproval.describe(r.approvalId)).status,'PENDING');
    assert.equal((await f.runtime.planApproval.decide({approvalId:r.approvalId,decision:'allow',passwordOk:false})).denied,true);
    const done=await f.runtime.planApproval.decide({approvalId:r.approvalId,decision:'allow',passwordOk:true});
    assert.equal(done.status,'APPROVED');
    const status=await f.call('zana_plan_approval_status',{workspaceId:w0.workspaceId},s);
    assert.deepEqual({status:status.status,planDigest:status.planDigest},{status:'APPROVED',planDigest:plan.digest});
    const rows=(await f.runtime.readAudit({limit:50})).filter(x=>x.tool==='operator_plan_approval');
    assert.deepEqual(rows.map(x=>x.outcome).sort(),['APPROVED','REFUSED']);
    assert.deepEqual(f.api.state.pulls,[],'aprobar el plan no crea nada en GitHub');
  }finally{await f.cleanup();}
});

// Ronda de corrección tras la revisión 4R.
test('el plan se guarda en su forma canónica: lo que se aprueba es lo que se ve',()=>{
  const {db,w,at}=fixture();
  try{
    const sloppy=JSON.parse(JSON.stringify(w.plan));
    sloppy.milestones[0].objective='   Modelo \n\n   ';
    sloppy.alternatives[0].sources[0].url='https://NODEJS.org:443/docs/';
    const stored=updateProjectWorkspace(db,{...at,expectedVersion:w.version,plan:sloppy});
    assert.equal(stored.plan.digest,w.plan.digest,'mismo contenido, mismo digest');
    assert.equal(stored.plan.milestones[0].objective,'Modelo','se guarda normalizado');
    assert.equal(stored.plan.alternatives[0].sources[0].url,'https://nodejs.org/docs/');
  }finally{db.close();}
});

test('la vista del operador trae todo lo que cubre el digest',()=>{
  const {db,request}=fixture();
  try{
    const view=describePlanApproval(db,{approvalId:request().approvalId,now:T0});
    assert.deepEqual(view.plan.answers,answers);
    assert.deepEqual(view.plan.alternatives.map(x=>x.id),['node','go']);
    assert.equal(view.plan.alternatives[1].tradeoffs,'Otro stack');
    assert.equal(view.plan.alternatives[0].sources[0].url,'https://nodejs.org/docs/');
    assert.deepEqual(view.plan.milestones,[{id:'core',objective:'Modelo',acceptance:'Tests',dependsOn:[]}]);
    assert.equal(view.plan.selectedId,'node');
  }finally{db.close();}
});

test('el estado no atribuye a un plan nuevo la decisión de otro; solo true aprueba',()=>{
  const {db,w,at,request}=fixture();
  try{
    const r=request();
    for(const fake of [1,'true',{},[],undefined])
      assert.equal(decidePlanApproval(db,{approvalId:r.approvalId,decision:'allow',passwordOk:fake,now:T0}).denied,true);
    assert.equal(approvedPlanDigest(db,at),null);
    const r2=request(T0+1);
    decidePlanApproval(db,{approvalId:r.approvalId,decision:'deny',passwordOk:false,now:T0});
    assert.equal(r2.approvalId,r.approvalId);
    assert.equal(planApprovalStatus(db,{...at,now:T0}).status,'DENIED');
    updateProjectWorkspace(db,{...at,expectedVersion:w.version,plan:draft(w.brief,'Otro modelo')});
    assert.equal(planApprovalStatus(db,{...at,now:T0}).status,'SUPERSEDED','nadie rechazó el plan nuevo');
    // Filas fabricadas o de otro esquema no aprueban ni rompen la lectura.
    db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('zana:approval:basura','{no json');
    db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('zana:approval:otra',JSON.stringify({schema:'x',ownerClient:client,
      workspaceId:w.workspaceId,status:'APPROVED',planDigest:w.plan.digest}));
    assert.equal(approvedPlanDigest(db,at),null);
  }finally{db.close();}
});

test('el operador puede revocar una aprobación; después hay que pedirla de nuevo',()=>{
  const {db,w,at,request}=fixture();
  try{
    const r=request();
    assert.throws(()=>decidePlanApproval(db,{approvalId:r.approvalId,decision:'revoke',passwordOk:false,now:T0}),/APPROVAL_NOT_APPROVED/);
    decidePlanApproval(db,{approvalId:r.approvalId,decision:'allow',passwordOk:true,now:T0});
    const s=planApprovalStatus(db,{...at,now:T0});
    assert.deepEqual({status:s.status,approvalId:s.approvalId},{status:'APPROVED',approvalId:r.approvalId});
    assert.equal(request(T0+1).approvalId,r.approvalId,'el enlace de una aprobación vigente sirve para revocarla');
    assert.equal(decidePlanApproval(db,{approvalId:r.approvalId,decision:'revoke',passwordOk:false,now:T0+2}).status,'REVOKED');
    assert.equal(approvedPlanDigest(db,at),null);
    assert.equal(planApprovalStatus(db,{...at,now:T0+2}).status,'REVOKED');
    const again=request(T0+3);
    assert.deepEqual({status:again.status,same:again.approvalId===r.approvalId,digest:again.planDigest},
      {status:'PENDING',same:false,digest:w.plan.digest});
  }finally{db.close();}
});

test('el origen público solo se arma con https',async()=>{
  const {remoteConfig}=await import('../src/remote-config.mjs');
  const origin=env=>remoteConfig({ZANA_GITHUB_REPOS:'o/r',...env}).publicOrigin;
  assert.equal(origin({ZANA_PUBLIC_HOST:'zana.test'}),'https://zana.test');
  assert.equal(origin({ZANA_PUBLIC_MCP_URL:'https://zana.test/mcp'}),'https://zana.test');
  assert.equal(origin({ZANA_PUBLIC_MCP_URL:'foo://zana.test/mcp'}),null);
  assert.equal(origin({ZANA_PUBLIC_MCP_URL:'http://zana.test/mcp'}),null);
  assert.equal(origin({}),null);
});
