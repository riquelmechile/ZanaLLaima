import test from 'node:test';
import assert from 'node:assert/strict';
import {requestApprovalPanel,decideApprovalPanel,approvalPanelStatus} from '../src/approval-panel.mjs';
import {bootstrapAuthorized} from '../src/bootstrap-request.mjs';
import {createProjectWorkspace,updateProjectWorkspace,setProjectWorkspaceArchived} from '../src/project-workspace.mjs';
import {panelFixture,makePlan,client,T0} from './helpers/plan-fixture.mjs';

const request=(f,extra={})=>requestApprovalPanel(f.db,{...f.base,now:T0,...extra});
const decide=(f,p,extra={})=>decideApprovalPanel(f.db,{clientId:client,panelId:p.panel.panelId,decision:'allow',nonce:p.nonce,allowed:()=>true,now:T0+1,...extra});
function insertStarted(f,state='RESERVED',operationId='11111111-1111-4111-8111-111111111111'){
  const op={schema:'zana.bootstrap-op.v1',operationId,ownerClient:client,workspaceId:f.workspace.workspaceId,
    intent:{owner:f.base.owner,name:f.base.name,visibility:f.base.visibility,planDigest:f.workspace.plan.digest,digest:'a'.repeat(64)},
    state,approvalId:null,repository:null,createdAt:new Date(T0).toISOString(),updatedAt:new Date(T0).toISOString()};
  f.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('zana:bootstrap:'+operationId,JSON.stringify(op));return operationId;
}
const expectedPlan=f=>({idea:f.workspace.brief.idea,answers:f.workspace.brief.answers,
  selectedId:f.workspace.plan.selectedId,alternatives:f.workspace.plan.alternatives,milestones:f.workspace.plan.milestones});

test('flujo completo expone formas exactas y deja bootstrap autorizado sin nonce',()=>{
  const f=panelFixture();try{
    const p=request(f);
    assert.deepEqual(p.panel,{panelId:p.panel.panelId,status:'PENDING',expiresAt:p.panel.expiresAt,
      workspaceId:f.workspace.workspaceId,version:f.workspace.version,planDigest:f.workspace.plan.digest,
      repository:{fullName:'riquelmechile/panel-demo',visibility:'private'},plan:expectedPlan(f)});
    assert.equal(p.panel.panelId.length,43);assert.equal(JSON.stringify(p.panel).includes(p.nonce),false);
    const key='zana:panel:'+p.panel.panelId,raw=f.db.prepare('SELECT value FROM metadata WHERE key=?').get(key).value;
    assert.equal(raw.includes(p.nonce),false);assert.match(JSON.parse(raw).nonceHash,/^[0-9a-f]{64}$/);
    const done=decide(f,p);
    assert.deepEqual(Object.keys(done).sort(),['operationId','planApprovalId','planDigest','repoApprovalId','status']);
    assert.equal(done.status,'APPROVED');assert.equal(done.planDigest,f.workspace.plan.digest);
    assert.equal(bootstrapAuthorized(f.db,{clientId:client,operationId:done.operationId,now:T0+2}),true);
    const stored=JSON.parse(f.db.prepare('SELECT value FROM metadata WHERE key=?').get(key).value);
    assert.deepEqual(stored.result,{planApprovalId:done.planApprovalId,operationId:done.operationId,repoApprovalId:done.repoApprovalId});
  }finally{f.db.close();}
});

test('decide funciona dentro de una transacción externa',()=>{
  const f=panelFixture();try{const p=request(f);
    f.db.exec('BEGIN IMMEDIATE');const done=decide(f,p);f.db.exec('COMMIT');
    assert.equal(done.status,'APPROVED');assert.equal(approvalPanelStatus(f.db,{clientId:client,panelId:p.panel.panelId}).status,'APPROVED');
  }finally{f.db.close();}
});

test('fallo intermedio revierte solo el savepoint y conserva la transacción externa',()=>{
  const f=panelFixture();try{const p=request(f);
    f.db.exec("CREATE TRIGGER fail_bootstrap BEFORE INSERT ON metadata WHEN NEW.key LIKE 'zana:bootstrap:%' BEGIN SELECT RAISE(ABORT,'boom'); END");
    f.db.exec('BEGIN IMMEDIATE');assert.throws(()=>decide(f,p),/boom/);
    f.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('outer-survives','1');f.db.exec('COMMIT');
    assert.equal(f.db.prepare("SELECT count(*) n FROM metadata WHERE key LIKE 'zana:approval:%' OR key LIKE 'zana:bootstrap:%'").get().n,0);
    assert.equal(f.db.prepare("SELECT value FROM metadata WHERE key='outer-survives'").get().value,'1');
    assert.equal(approvalPanelStatus(f.db,{clientId:client,panelId:p.panel.panelId,now:T0+2}).status,'PENDING');
  }finally{f.db.close();}
});

test('bootstrap iniciado bloquea solicitud y decisión con operación y estado',()=>{
  for(const state of ['RESERVED','UNCERTAIN','DONE']){const f=panelFixture();try{
    const id=insertStarted(f,state);
    assert.throws(()=>request(f),new RegExp('BOOTSTRAP_ALREADY_STARTED:.*'+id+'.*'+state));
  }finally{f.db.close();}}
  const f=panelFixture();try{const p=request(f),id=insertStarted(f,'UNCERTAIN');
    assert.throws(()=>decide(f,p),new RegExp('BOOTSTRAP_ALREADY_STARTED:.*'+id+'.*UNCERTAIN'));
    assert.equal(f.db.prepare("SELECT count(*) n FROM metadata WHERE key LIKE 'zana:approval:%'").get().n,0);
    assert.equal(approvalPanelStatus(f.db,{clientId:client,panelId:p.panel.panelId}).status,'PENDING');
  }finally{f.db.close();}
});

test('seis nonces incorrectos bloquean el panel',()=>{
  const f=panelFixture();try{const p=request(f);
    for(let i=0;i<6;i++){const r=decide(f,p,{nonce:'malo-'+i});assert.equal(r.denied,true);assert.equal(r.attemptsLeft,5-i);}
    assert.equal(approvalPanelStatus(f.db,{clientId:client,panelId:p.panel.panelId,now:T0+2}).status,'LOCKED');
    assert.throws(()=>decide(f,p),/PANEL_NOT_PENDING/);
  }finally{f.db.close();}
});

test('caducidad persiste y otro cliente no lee ni decide',()=>{
  const f=panelFixture();try{const p=request(f);
    assert.equal(approvalPanelStatus(f.db,{clientId:'oauth-other',panelId:p.panel.panelId,now:T0}),null);
    assert.throws(()=>decideApprovalPanel(f.db,{clientId:'oauth-other',panelId:p.panel.panelId,decision:'deny',nonce:p.nonce,allowed:()=>true,now:T0}),/PANEL_NOT_FOUND/);
    assert.equal(decide(f,p,{now:T0+15*60_000}).status,'EXPIRED');
    assert.equal(approvalPanelStatus(f.db,{clientId:client,panelId:p.panel.panelId,now:T0+15*60_000}).status,'EXPIRED');
  }finally{f.db.close();}
});

test('cambio de plan deja SUPERSEDED sin efectos',()=>{
  const f=panelFixture();try{const p=request(f);
    updateProjectWorkspace(f.db,{clientId:client,workspaceId:f.workspace.workspaceId,expectedVersion:f.workspace.version,plan:makePlan(f.workspace.brief,'Otro modelo')});
    assert.equal(decide(f,p).status,'SUPERSEDED');
    assert.equal(f.db.prepare("SELECT count(*) n FROM metadata WHERE key LIKE 'zana:approval:%' OR key LIKE 'zana:bootstrap:%'").get().n,0);
  }finally{f.db.close();}
});

test('deny, allowlist y reemplazo pendiente son fail-closed',()=>{
  const f=panelFixture();try{
    assert.throws(()=>request(f,{allowed:()=>false}),/REPO_NOT_ALLOWED/);
    const a=request(f),b=request(f,{name:'panel-dos'});
    assert.equal(approvalPanelStatus(f.db,{clientId:client,panelId:a.panel.panelId,now:T0}).status,'REPLACED');
    assert.equal(decide(f,b,{decision:'deny'}).status,'DENIED');
  }finally{f.db.close();}
});

test('cuota y poda de paneles se aplican',()=>{
  const f=panelFixture();try{for(let i=0;i<20;i++)request(f,{name:'repo-'+i});
    assert.throws(()=>request(f,{name:'repo-20'}),/PANEL_RATE_EXCEEDED/);
  }finally{f.db.close();}
  const f2=panelFixture();try{const old=request(f2),key='zana:panel:'+old.panel.panelId;
    const raw=JSON.parse(f2.db.prepare('SELECT value FROM metadata WHERE key=?').get(key).value);
    raw.createdAt=new Date(T0-2*86400_000).toISOString();f2.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(raw),key);
    request(f2,{name:'despues-poda'});assert.equal(f2.db.prepare('SELECT value FROM metadata WHERE key=?').get(key),undefined);
  }finally{f2.db.close();}
});

test('validaciones de entrada cierran ramas de seguridad',()=>{
  const f=panelFixture();try{
    assert.throws(()=>request(f,{expectedVersion:99}),/STALE_REVISION/);
    const empty=createProjectWorkspace(f.db,{clientId:client,idea:'Otro proyecto sin plan'});
    assert.throws(()=>requestApprovalPanel(f.db,{...f.base,workspaceId:empty.workspaceId,expectedVersion:0,now:T0}),/PLAN_REQUIRED/);
    const p=request(f);assert.equal(approvalPanelStatus(f.db,{clientId:client,panelId:'missing',now:T0}),null);
    assert.throws(()=>decide(f,p,{decision:'maybe'}),/INVALID_DECISION/);
    assert.throws(()=>decide(f,p,{allowed:()=>false}),/REPO_NOT_ALLOWED/);
    setProjectWorkspaceArchived(f.db,{clientId:client,workspaceId:f.workspace.workspaceId,expectedVersion:f.workspace.version,archived:true});
    assert.equal(decide(f,p).status,'SUPERSEDED');
  }finally{f.db.close();}
});
