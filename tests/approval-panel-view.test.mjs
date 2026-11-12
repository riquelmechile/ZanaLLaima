import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {PANEL_URI,PANEL_MIME,panelHtml} from '../src/approval-panel-view.mjs';

class Element{
  constructor(tag='div'){this.tagName=tag;this.children=[];this.listeners={};this.hidden=true;this.disabled=false;this._text='';}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(x=>x.textContent).join('');}
  appendChild(node){this.children.push(node);return node;}
  addEventListener(type,fn){this.listeners[type]=fn;}
  click(){return this.listeners.click?.({preventDefault(){}});}
}
function boot(options={}){
  const html=panelHtml(),ids={};
  for(const id of ['app','status','plan','actions','approve','deny'])ids[id]=new Element();
  const document={getElementById:id=>ids[id]??null,createElement:tag=>new Element(tag)};
  const messages=[],origins=[],parent={postMessage:(message,origin)=>{origins.push(origin);
    if(options.throwTools&&message.method==='tools/call')throw new Error('POST_FAILED: transporte roto');
    messages.push(message);}};
  let listener;
  const window={parent,addEventListener:(type,fn)=>{if(type==='message')listener=fn;}};
  const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  vm.runInNewContext(script,{window,document,console,Promise});
  const receive=(data,source=parent,origin='https://host.example')=>listener({data,source,origin});
  return {html,ids,messages,origins,parent,receive};
}
const flush=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
const plain=value=>JSON.parse(JSON.stringify(value));
async function initialize(app){
  const request=app.messages.find(x=>x.method==='ui/initialize');
  assert.ok(request,'la vista inicia el protocolo MCP Apps');
  assert.deepEqual(plain(request.params.appCapabilities.availableDisplayModes),['inline']);
  app.receive({jsonrpc:'2.0',id:request.id,result:{protocolVersion:'2026-01-26',hostCapabilities:{serverTools:{},openLinks:{}}}});
  await flush();
  assert.ok(app.messages.some(x=>x.method==='ui/notifications/initialized'));
}
const panel={panelId:'panel-1',status:'PENDING',expiresAt:'2026-11-12T02:00:00Z',workspaceId:'ws-1',version:3,
  planDigest:'abc',repository:{fullName:'zana/demo',visibility:'private'},plan:{idea:'Crear demo',
    answers:{objetivo:'Probar',usuarios:'Equipos'},selectedId:'node',alternatives:[
      {id:'node',technology:'Node',rationale:'Integración',benefits:'Ecosistema',tradeoffs:'Runtime',
        sources:[{title:'Node docs',url:'docs.example.invalid',checkedOn:'2026-11-11'}]}],
    milestones:[{id:'m1',objective:'Panel',acceptance:'Tests',dependsOn:[]}]}};
const toolResult=(nonce='secret-nonce')=>({jsonrpc:'2.0',method:'ui/notifications/tool-result',
  params:{structuredContent:{panel},_meta:nonce?{'zana-llaima/panel':{panelId:'panel-1',nonce}}:{}}});

test('exporta recurso HTML autocontenido y seguro',()=>{
  const html=panelHtml();
  assert.equal(PANEL_URI,'ui://zanallaima/approval-panel-v1.html');
  assert.equal(PANEL_MIME,'text/html;profile=mcp-app');
  assert.match(html,/^<!doctype html>/i);
  assert.doesNotMatch(html,/(?:src|href)=["']https?:|@import|url\(/i);
  assert.doesNotMatch(html,/innerHTML/);
});

test('handshake y aprobación siguen decide, execute y contexto sin filtrar nonce',async()=>{
  const app=boot();await initialize(app);app.receive(toolResult());await flush();
  assert.equal(app.ids.actions.hidden,false);assert.match(app.ids.plan.textContent,/Crear demo/);
  app.ids.approve.click();await flush();
  const decide=app.messages.find(x=>x.method==='tools/call');
  assert.deepEqual(plain(decide.params),{name:'zana_panel_decide',arguments:{panelId:'panel-1',nonce:'secret-nonce',decision:'allow'}});
  app.receive({jsonrpc:'2.0',id:decide.id,result:{structuredContent:{status:'APPROVED',operationId:'op-1'}}});await flush();
  const execute=app.messages.find(x=>x.method==='tools/call'&&x.params.name==='zana_bootstrap_execute');
  assert.deepEqual(plain(execute.params.arguments),{operationId:'op-1'});
  app.receive({jsonrpc:'2.0',id:execute.id,result:{structuredContent:{state:'DONE',created:{fullName:'zana/demo',htmlUrl:'repo.example.invalid/zana/demo'}}}});await flush();
  const update=app.messages.find(x=>x.method==='ui/update-model-context');
  assert.match(update.params.content[0].text,/operationId=op-1, estado=DONE/);
  for(const message of app.messages)if(message!==decide)assert.equal(JSON.stringify(message).includes('secret-nonce'),false);
});

test('sin nonce no hay botones y mensajes ajenos o prematuros se ignoran',async()=>{
  const app=boot();app.receive(toolResult(),{});app.receive(toolResult());assert.equal(app.ids.actions.hidden,true);
  await initialize(app);app.receive(toolResult(''));await flush();
  assert.equal(app.ids.actions.hidden,true);assert.match(app.ids.status.textContent,/no puede aprobar/);
});

test('error de tool se muestra y rechazo informa al modelo',async()=>{
  const app=boot();await initialize(app);app.receive(toolResult());await flush();
  app.ids.deny.click();await flush();
  const decide=app.messages.find(x=>x.method==='tools/call');
  app.receive({jsonrpc:'2.0',id:decide.id,result:{isError:true,content:[{type:'text',text:'RECHAZO: fallo seguro'}]}});await flush();
  assert.match(app.ids.status.textContent,/fallo seguro/);
  const app2=boot();await initialize(app2);app2.receive(toolResult());await flush();app2.ids.deny.click();await flush();
  const deny=app2.messages.find(x=>x.method==='tools/call');
  app2.receive({jsonrpc:'2.0',id:deny.id,result:{structuredContent:{status:'DENIED'}}});await flush();
  assert.ok(app2.messages.some(x=>x.method==='ui/update-model-context'&&/rechazó/.test(x.params.content[0].text)));
});

async function approveFlow(app){await initialize(app);app.receive(toolResult());await flush();app.ids.approve.click();await flush();
  return app.messages.find(x=>x.method==='tools/call');}
test('R1 requests del host no consumen respuestas pendientes',async()=>{
  const app=boot(),decide=await approveFlow(app);
  app.receive({jsonrpc:'2.0',id:decide.id,method:'ping'});await flush();
  app.receive({jsonrpc:'2.0',id:decide.id,result:{structuredContent:{status:'APPROVED',operationId:'op-1'}}});await flush();
  assert.ok(app.messages.some(x=>x.params?.name==='zana_bootstrap_execute'));
  assert.ok(app.messages.some(x=>x.id===decide.id&&x.result&&Object.keys(x.result).length===0));
});
test('R2 error tras aprobar informa operationId y solo código',async()=>{
  const app=boot(),decide=await approveFlow(app);
  app.receive({jsonrpc:'2.0',id:decide.id,result:{structuredContent:{status:'APPROVED',operationId:'op-1'}}});await flush();
  const ex=app.messages.find(x=>x.params?.name==='zana_bootstrap_execute');
  app.receive({jsonrpc:'2.0',id:ex.id,result:{isError:true,content:[{type:'text',text:'OUTCOME_UNKNOWN: reconciliar secreto'}]}});await flush();
  const ctx=app.messages.find(x=>x.method==='ui/update-model-context');
  assert.match(ctx.params.content[0].text,/operationId=op-1.*OUTCOME_UNKNOWN/);
  assert.doesNotMatch(ctx.params.content[0].text,/reconciliar secreto|nonce|arguments/);
});
test('R3 tool-result tardío no reemplaza panel decidido',async()=>{
  const app=boot(),decide=await approveFlow(app);
  app.receive({jsonrpc:'2.0',id:decide.id,result:{structuredContent:{status:'APPROVED',operationId:'op-1'}}});await flush();
  const ex=app.messages.find(x=>x.params?.name==='zana_bootstrap_execute');
  app.receive({jsonrpc:'2.0',id:ex.id,result:{structuredContent:{state:'DONE',created:{fullName:'zana/demo',htmlUrl:'https://github.com/zana/demo'}}}});await flush();
  app.receive(toolResult('otro-nonce'));await flush();assert.match(app.ids.status.textContent,/DONE/);
});
test('R4 rechaza open-link que no coincida exactamente con GitHub fullName',async()=>{
  const app=boot(),decide=await approveFlow(app);
  app.receive({jsonrpc:'2.0',id:decide.id,result:{structuredContent:{status:'APPROVED',operationId:'op-1'}}});await flush();
  const ex=app.messages.find(x=>x.params?.name==='zana_bootstrap_execute');
  app.receive({jsonrpc:'2.0',id:ex.id,result:{structuredContent:{state:'DONE',created:{fullName:'zana/demo',htmlUrl:'javascript:alert(1)'}}}});await flush();
  const link=app.ids.plan.children.find(x=>x.tagName==='button');if(link)link.click();
  assert.equal(app.messages.some(x=>x.method==='ui/open-link'),false);
});
test('R5 clic prematuro no bloquea la vista',async()=>{
  const app=boot();await initialize(app);app.ids.approve.click();await flush();
  app.receive(toolResult());await flush();assert.equal(app.ids.approve.disabled,false);assert.equal(app.ids.actions.hidden,false);
});
test('CSS oculta siempre elementos hidden',()=>assert.match(panelHtml(),/\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*\}/));

test('origin null conserva targetOrigin seguro y post fallido rehabilita botones',async()=>{
  const app=boot();const init=app.messages.find(x=>x.method==='ui/initialize');
  app.receive({jsonrpc:'2.0',id:init.id,result:{protocolVersion:'2026-01-26'}},app.parent,'null');await flush();
  app.receive(toolResult());await flush();app.ids.approve.click();await flush();
  const call=app.messages.find(x=>x.method==='tools/call');
  assert.equal(app.origins[app.messages.indexOf(call)],'*');
  const broken=boot({throwTools:true});await initialize(broken);broken.receive(toolResult());await flush();
  broken.ids.approve.click();await flush();
  assert.equal(broken.ids.approve.disabled,false);assert.match(broken.ids.status.textContent,/POST_FAILED/);
});

test('doble fallo al avisar al modelo conserva estado DONE',async()=>{
  const app=boot(),decide=await approveFlow(app);
  app.receive({jsonrpc:'2.0',id:decide.id,result:{structuredContent:{status:'APPROVED',operationId:'op-1'}}});await flush();
  const ex=app.messages.find(x=>x.params?.name==='zana_bootstrap_execute');
  app.receive({jsonrpc:'2.0',id:ex.id,result:{structuredContent:{state:'DONE',created:{fullName:'zana/demo'}}}});await flush();
  const update=app.messages.find(x=>x.method==='ui/update-model-context');
  app.receive({jsonrpc:'2.0',id:update.id,error:{message:'rechazo uno'}});await flush();
  const fallback=app.messages.find(x=>x.method==='ui/message');
  app.receive({jsonrpc:'2.0',id:fallback.id,error:{message:'rechazo dos'}});await flush();
  assert.match(app.ids.status.textContent,/DONE/);
});
