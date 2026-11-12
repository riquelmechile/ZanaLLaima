import test from 'node:test';
import assert from 'node:assert/strict';
import {requestApprovalPanel,decideApprovalPanel,approvalPanelStatus} from '../src/approval-panel.mjs';
import {bootstrapAuthorized} from '../src/bootstrap-request.mjs';
import {updateProjectWorkspace} from '../src/project-workspace.mjs';
import {panelFixture,makePlan,client,T0} from './helpers/plan-fixture.mjs';

const request=(f,extra={})=>requestApprovalPanel(f.db,{...f.base,now:T0,...extra});
const decide=(f,p,extra={})=>decideApprovalPanel(f.db,{clientId:client,panelId:p.panel.panelId,decision:'allow',nonce:p.nonce,allowed:()=>true,now:T0+1,...extra});

test('flujo completo deja bootstrap autorizado sin exponer nonce',()=>{
  const f=panelFixture();try{
    const p=request(f);assert.equal(p.panel.status,'PENDING');assert.equal(p.panel.panelId.length,43);
    assert.equal('nonce' in p.panel,false);assert.equal(JSON.stringify(p.panel).includes(p.nonce),false);
    const raw=f.db.prepare('SELECT value FROM metadata WHERE key=?').get('zana:panel:'+p.panel.panelId).value;
    assert.equal(raw.includes(p.nonce),false);assert.match(JSON.parse(raw).nonceHash,/^[0-9a-f]{64}$/);
    const done=decide(f,p);assert.equal(done.status,'APPROVED');assert.equal(done.result.bootstrapAuthorized,true);
    assert.equal(bootstrapAuthorized(f.db,{clientId:client,operationId:done.result.operationId,now:T0+2}),true);
  }finally{f.db.close();}
});

test('seis nonces incorrectos bloquean el panel',()=>{
  const f=panelFixture();try{const p=request(f);
    for(let i=0;i<6;i++){const r=decide(f,p,{nonce:'malo-'+i});assert.equal(r.denied,true);assert.equal(r.attemptsLeft,5-i);}
    assert.equal(approvalPanelStatus(f.db,{clientId:client,panelId:p.panel.panelId,now:T0+2}).status,'LOCKED');
    assert.throws(()=>decide(f,p),/PANEL_NOT_PENDING/);
  }finally{f.db.close();}
});

test('caducidad se persiste y otro cliente no puede decidir',()=>{
  const f=panelFixture();try{const p=request(f);
    assert.throws(()=>decideApprovalPanel(f.db,{clientId:'oauth-other',panelId:p.panel.panelId,decision:'deny',nonce:p.nonce,allowed:()=>true,now:T0}),/PANEL_NOT_FOUND/);
    assert.equal(decide(f,p,{now:T0+15*60_000}).status,'EXPIRED');
    assert.equal(approvalPanelStatus(f.db,{clientId:client,panelId:p.panel.panelId,now:T0+15*60_000}).status,'EXPIRED');
  }finally{f.db.close();}
});

test('cambio de plan deja SUPERSEDED sin efectos',()=>{
  const f=panelFixture();try{const p=request(f);
    const w=updateProjectWorkspace(f.db,{clientId:client,workspaceId:f.workspace.workspaceId,expectedVersion:f.workspace.version,plan:makePlan(f.workspace.brief,'Otro modelo')});
    const r=decide(f,p);assert.equal(r.status,'SUPERSEDED');
    assert.equal(f.db.prepare("SELECT count(*) n FROM metadata WHERE key LIKE 'zana:approval:%' OR key LIKE 'zana:bootstrap:%'").get().n,0);
    assert.equal(w.version,f.workspace.version+1);
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

test('cuota de veinte paneles por cliente en 24 horas',()=>{
  const f=panelFixture();try{
    for(let i=0;i<20;i++)request(f,{name:'repo-'+i});
    assert.throws(()=>request(f,{name:'repo-20'}),/PANEL_RATE_EXCEEDED/);
  }finally{f.db.close();}
});

test('fallo intermedio revierte aprobaciones y bootstrap',()=>{
  const f=panelFixture();try{const p=request(f);
    f.db.exec("CREATE TRIGGER fail_bootstrap BEFORE INSERT ON metadata WHEN NEW.key LIKE 'zana:bootstrap:%' BEGIN SELECT RAISE(ABORT,'boom'); END");
    assert.throws(()=>decide(f,p),/boom/);
    assert.equal(f.db.prepare("SELECT count(*) n FROM metadata WHERE key LIKE 'zana:approval:%' OR key LIKE 'zana:bootstrap:%'").get().n,0);
    assert.equal(approvalPanelStatus(f.db,{clientId:client,panelId:p.panel.panelId,now:T0+2}).status,'PENDING');
  }finally{f.db.close();}
});

test('un panel usado no se reutiliza y status nunca devuelve nonce',()=>{
  const f=panelFixture();try{const p=request(f);decide(f,p);
    assert.throws(()=>decide(f,p),/PANEL_NOT_PENDING/);
    const status=approvalPanelStatus(f.db,{clientId:client,panelId:p.panel.panelId,now:T0+2});
    assert.equal(status.status,'APPROVED');assert.equal('nonce' in status,false);assert.equal(JSON.stringify(status).includes(p.nonce),false);
  }finally{f.db.close();}
});
