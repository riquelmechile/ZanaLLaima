import test from 'node:test';
import assert from 'node:assert/strict';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import {remoteFixture} from './helpers/remote-fixture.mjs';
import {BOOTSTRAP_TOKEN} from './helpers/fake-github.mjs';
import {answers,alternatives} from './helpers/plan-fixture.mjs';
import {PANEL_URI,PANEL_MIME} from '../src/approval-panel-view.mjs';

async function workspace(){
  const f=await remoteFixture({envExtra:{ZANA_GITHUB_REPOS:'O/*',ZANA_BOOTSTRAP_GITHUB_TOKEN:BOOTSTRAP_TOKEN}});
  const session=await f.session('zana-chatgpt','oauth-panel');
  const w=await f.call('zana_workspace_create',{idea:'Aplicación de control seguro para revisión de proyectos'},session);
  const v=await f.call('zana_workspace_update',{workspaceId:w.workspaceId,expectedVersion:0,answers},session);
  const plan=await f.call('zana_project_plan_draft',{brief:v.brief,alternatives,selectedId:'node',
    milestones:[{id:'core',objective:'Diseñar',acceptance:'Tests',dependsOn:[]}]},session);
  await f.call('zana_workspace_update',{workspaceId:w.workspaceId,expectedVersion:1,plan},session);
  return {f,session,args:{workspaceId:w.workspaceId,expectedVersion:2,owner:'O',name:'panel-secure',visibility:'private'}};
}
async function rawClient(runtime,session,ui,mime=PANEL_MIME){
  const [client,transport]=InMemoryTransport.createLinkedPair();
  const server=runtime.createServer(async()=>session);
  await server.connect(transport);
  const pending=new Map();let id=0;
  client.onmessage=message=>{if(message.id!==undefined){const accept=pending.get(message.id);if(accept){pending.delete(message.id);accept(message);}}};
  await client.start();
  const request=async(method,params={})=>{
    const n=++id;
    const promise=new Promise(resolve=>pending.set(n,resolve));
    await client.send({jsonrpc:'2.0',id:n,method,params});
    return promise;
  };
  await request('initialize',{protocolVersion:'2025-11-25',
    capabilities:ui?{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:[mime]}}}:{},
    clientInfo:{name:'raw-panel-test',version:'1.0'}});
  await client.send({jsonrpc:'2.0',method:'notifications/initialized'});
  return {request,close:async()=>{await client.close();await server.close();}};
}
const call=(c,name,args)=>c.request('tools/call',{name,arguments:args});
const result=r=>r.result??{};

test('MCP Apps: herramientas con visibilidad correcta y fallback sin extensión',async()=>{
  const t=await workspace();let app,noUi;
  try{
    noUi=await rawClient(t.f.runtime,t.session,false);
    const without=(await noUi.request('tools/list')).result.tools;
    assert.equal(without.some(x=>x.name==='zana_panel_decide'),false);
    assert.ok(without.some(x=>x.name==='zana_bootstrap_setup'),'setup debe anunciarse sin UI');
    const unavailable=await call(noUi,'zana_project_approval_panel',t.args);
    assert.match(JSON.stringify(unavailable),/UI_UNAVAILABLE/);
    const forbidden=await call(noUi,'zana_panel_decide',{panelId:'x',nonce:'secret',decision:'allow'});
    assert.ok(forbidden.error||forbidden.result?.isError);
    app=await rawClient(t.f.runtime,t.session,true);
    const withUi=(await app.request('tools/list')).result.tools;
    const decide=withUi.find(x=>x.name==='zana_panel_decide');
    assert.deepEqual(decide._meta.ui.visibility,['app']);
    assert.equal(decide._meta['openai/widgetAccessible'],true);
    assert.equal(withUi.find(x=>x.name==='zana_project_approval_panel')._meta.ui.resourceUri,PANEL_URI);
    assert.equal(withUi.find(x=>x.name==='zana_bootstrap_execute')._meta?.ui?.visibility,undefined);
    const setup=withUi.find(x=>x.name==='zana_bootstrap_setup');
    assert.ok(setup,'setup debe aparecer en tools/list');
    assert.equal(setup._meta?.ui?.visibility,undefined);
  }finally{if(app)await app.close();if(noUi)await noUi.close();await t.f.cleanup();}
});

test('MCP Apps: nonce exclusivamente en _meta y nunca en auditoría; aprobación y bootstrap',async()=>{
  const t=await workspace();let app;
  try{
    app=await rawClient(t.f.runtime,t.session,true);
    const opened=result(await call(app,'zana_project_approval_panel',t.args));
    assert.equal(opened.isError,undefined,JSON.stringify(opened));
    const panel=opened.structuredContent.panel,nonce=opened._meta?.['zana-llaima/panel']?.nonce;
    assert.ok(panel?.panelId&&nonce);
    assert.equal(opened._meta['zana-llaima/panel'].panelId,panel.panelId);
    assert.ok(!JSON.stringify(opened.content).includes(nonce));
    assert.ok(!JSON.stringify(opened.structuredContent).includes(nonce));
    const audit1=await t.f.runtime.readAudit({limit:100});
    assert.ok(!JSON.stringify(audit1).includes(nonce));
    const decision=result(await call(app,'zana_panel_decide',{panelId:panel.panelId,nonce,decision:'allow'}));
    assert.equal(decision.structuredContent.status,'APPROVED',JSON.stringify(decision));
    const operationId=decision.structuredContent.operationId;
    const done=result(await call(app,'zana_bootstrap_execute',{operationId}));
    assert.equal(done.structuredContent.state,'DONE',JSON.stringify(done));
    const audit=await t.f.runtime.readAudit({limit:100});
    assert.ok(audit.some(a=>a.tool==='operator_panel_approval'&&a.category==='operator'&&a.detail?.operationId===operationId));
    assert.ok(!JSON.stringify(audit).includes(nonce));
    const read=result(await app.request('resources/read',{uri:PANEL_URI}));
    const html=read.contents[0];
    assert.equal(html.mimeType,PANEL_MIME);
    assert.match(html.text,/<!doctype html>/i);
    assert.deepEqual(html._meta.ui.csp,{connectDomains:[],resourceDomains:[]});
  }finally{if(app)await app.close();await t.f.cleanup();}
});

test('dispatch rechaza abrir o decidir sin soporte de panel; no genera nonce',async()=>{
  const t=await workspace();
  try{
    const open=await t.f.runtime.dispatch('zana_project_approval_panel',t.args,t.session);
    assert.match(open.content[0].text,/UI_UNAVAILABLE/);
    const decide=await t.f.runtime.dispatch('zana_panel_decide',{panelId:'random',nonce:'sentinel',decision:'allow'},t.session);
    assert.match(decide.content[0].text,/UI_UNAVAILABLE/);
    assert.ok(!JSON.stringify(await t.f.runtime.readAudit({limit:100})).includes('sentinel'));
  }finally{await t.f.cleanup();}
});

test('denegar en el panel queda auditado sin nonce y no autoriza bootstrap',async()=>{
  const t=await workspace();let app;
  try{
    app=await rawClient(t.f.runtime,t.session,true);
    const opened=result(await call(app,'zana_project_approval_panel',t.args));
    const {panelId,nonce}=opened._meta['zana-llaima/panel'];
    const denied=result(await call(app,'zana_panel_decide',{panelId,nonce,decision:'deny'}));
    assert.equal(denied.structuredContent.status,'DENIED');
    assert.equal(denied.structuredContent.operationId,undefined);
    const second=result(await call(app,'zana_panel_decide',{panelId,nonce,decision:'allow'}));
    assert.equal(second.isError,true,'el nonce consumido no permite aprobar después');
    const audit=await t.f.runtime.readAudit({limit:100});
    assert.ok(audit.some(a=>a.tool==='operator_panel_approval'&&a.outcome==='DENIED'&&a.category==='operator'));
    assert.ok(!JSON.stringify(audit).includes(nonce));
    assert.equal(t.f.api.state.requests.some(x=>x.method==='POST'&&x.path==='/user/repos'),false);
  }finally{if(app)await app.close();await t.f.cleanup();}
});

test('replay allow es idempotente y no duplica auditoría de operador',async()=>{
  const t=await workspace();let app;try{app=await rawClient(t.f.runtime,t.session,true);
    const opened=result(await call(app,'zana_project_approval_panel',t.args));
    assert.ok(opened.structuredContent?.panel,'panel ausente');
    const {panelId,nonce}=opened._meta['zana-llaima/panel'];
    const first=result(await call(app,'zana_panel_decide',{panelId,nonce,decision:'allow'}));
    assert.equal(first.structuredContent.status,'APPROVED');
    const replay=result(await call(app,'zana_panel_decide',{panelId,nonce,decision:'allow'}));
    assert.equal(replay.structuredContent.replayed,true,JSON.stringify(replay));
    assert.equal(replay.structuredContent.operationId,first.structuredContent.operationId);
    const audit=await t.f.runtime.readAudit({limit:100});
    assert.equal(audit.filter(x=>x.tool==='operator_panel_approval'&&x.outcome==='APPROVED').length,1);
  }finally{if(app)await app.close();await t.f.cleanup();}
});

test('nonce errado queda REFUSED sin filtrar secreto',async()=>{
  const t=await workspace();let app;try{app=await rawClient(t.f.runtime,t.session,true);
    const opened=result(await call(app,'zana_project_approval_panel',t.args));
    assert.ok(opened.structuredContent?.panel,'panel ausente');
    const panelId=opened.structuredContent.panel.panelId,secret='nonce-equivocado';
    const denied=result(await call(app,'zana_panel_decide',{panelId,nonce:secret,decision:'allow'}));
    assert.equal(denied.structuredContent.denied,true);
    const audit=await t.f.runtime.readAudit({limit:100});
    assert.ok(audit.some(x=>x.tool==='zana_panel_decide'&&x.outcome==='REFUSED'),JSON.stringify(audit));
    assert.equal(JSON.stringify(audit).includes(secret),false);
  }finally{if(app)await app.close();await t.f.cleanup();}
});

test('visibilidad privada, mime incorrecto y fallback sin filas de panel',async()=>{
  const t=await workspace();let wrong,noUi;try{
    wrong=await rawClient(t.f.runtime,t.session,true,'text/html');
    const unavailable=await call(wrong,'zana_project_approval_panel',t.args);
    assert.ok(unavailable.error||unavailable.result?.isError,'mime incorrecto aceptado');
    noUi=await rawClient(t.f.runtime,t.session,false);
    const denied=await call(noUi,'zana_project_approval_panel',t.args);
    assert.ok(denied.error||denied.result?.isError,'cliente sin UI aceptado');
    const {DatabaseSync}=await import('node:sqlite');
    const {databasePath}=await import('../src/store.mjs');
    const db=new DatabaseSync(databasePath());
    try{assert.equal(db.prepare("SELECT count(*) n FROM metadata WHERE key LIKE 'zana:panel:%'").get().n,0);}
    finally{db.close();}
    const app=await rawClient(t.f.runtime,t.session,true);
    try{const tools=(await app.request('tools/list')).result.tools;
      assert.equal(tools.find(x=>x.name==='zana_panel_decide')._meta['openai/visibility'],'private');
    }finally{await app.close();}
  }finally{if(wrong)await wrong.close();if(noUi)await noUi.close();await t.f.cleanup();}
});
