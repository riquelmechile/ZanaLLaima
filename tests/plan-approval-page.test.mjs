import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {remoteFixture} from './helpers/remote-fixture.mjs';
import {EmbeddedOAuth} from '../src/oauth.mjs';
import {createHttpServer,httpSettings} from '../src/http.mjs';

const PASSWORD='p'.repeat(40),ORIGIN='https://zanallaima.test';
const answers={goal:'Gestionar hitos',users:'Equipos',platform:'Web',features:'Planes',data:'Sin secretos'};
const alternatives=['node','go'].map(id=>({id,technology:id==='node'?'Node <b>22</b>':'Go',rationale:'r',benefits:'b',tradeoffs:'t',
  sources:[{title:'Docs',url:'https://example.org/'+id,checkedOn:'2026-11-10'}]}));
async function setup(){
  const f=await remoteFixture({envExtra:{ZANA_PUBLIC_HOST:'zanallaima.test'}});
  const settings={...httpSettings({ZANA_PUBLIC_HOST:'zanallaima.test',ZANA_OAUTH_DB:join(f.dir,'oauth.sqlite')}),password:PASSWORD};
  const oauth=new EmbeddedOAuth({path:settings.oauthDb,resource:ORIGIN+'/mcp',
    redirectUris:['https://chatgpt.com/connector_platform_oauth_redirect'],password:PASSWORD});
  const http=createHttpServer({runtime:f.runtime,oauth,settings,log:{error(){}}});
  await new Promise(ok=>http.listen(0,'127.0.0.1',ok));
  const base='http://127.0.0.1:'+http.address().port;
  const s=await f.session('zana-chatgpt','oauth-one');
  const w0=await f.call('zana_workspace_create',{idea:'Plataforma privada para gestionar proyectos de desarrollo'},s);
  const w1=await f.call('zana_workspace_update',{workspaceId:w0.workspaceId,expectedVersion:0,answers},s);
  const plan=await f.call('zana_project_plan_draft',{brief:w1.brief,alternatives,selectedId:'node',
    milestones:[{id:'core',objective:'Diseñar el <script>modelo</script>',acceptance:'Tests',dependsOn:[]}]},s);
  await f.call('zana_workspace_update',{workspaceId:w0.workspaceId,expectedVersion:1,plan},s);
  const request=async()=>f.call('zana_plan_approval_request',{workspaceId:w0.workspaceId,expectedVersion:2},s);
  const status=async()=>(await f.call('zana_plan_approval_status',{workspaceId:w0.workspaceId},s)).status;
  const post=(aid,fields,headers={origin:ORIGIN})=>fetch(base+'/operator/approve?aid='+aid,{method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams(fields).toString()});
  return {f,base,plan,request,status,post,
    close:async()=>{http.closeAllConnections();await new Promise(ok=>http.close(ok));oauth.close();await f.cleanup();}};
}

test('la página muestra el plan escapado y solo aprueba con la contraseña del operador',async()=>{
  const t=await setup();
  try{
    const r=await t.request();
    const page=await fetch(t.base+'/operator/approve?aid='+r.approvalId);
    assert.equal(page.status,200);
    assert.match(page.headers.get('content-security-policy'),/default-src 'none'.*form-action 'self'.*frame-ancestors 'none'/);
    assert.equal(page.headers.get('cache-control'),'no-store');
    const html=await page.text();
    assert.ok(html.includes(t.plan.digest),'muestra el digest exacto que se aprueba');
    assert.ok(html.includes('zanallaima.test'),'muestra el dominio del servidor');
    assert.ok(html.includes('&lt;script&gt;modelo&lt;/script&gt;')&&!html.includes('<script>'),'el contenido del modelo va escapado');
    assert.ok(html.includes('Node &lt;b&gt;22&lt;/b&gt;'));
    // Sin Origin del propio servidor no se procesa nada.
    assert.equal((await t.post(r.approvalId,{decision:'allow',password:PASSWORD},{origin:'https://evil.example'})).status,403);
    assert.equal((await t.post(r.approvalId,{decision:'allow',password:PASSWORD},{})).status,403);
    assert.equal(await t.status(),'PENDING');
    const wrong=await t.post(r.approvalId,{decision:'allow',password:'x'.repeat(40)});
    assert.equal(wrong.status,403);
    assert.match(await wrong.text(),/Contraseña incorrecta/);
    assert.equal((await t.post(r.approvalId,{decision:'allow'})).status,403,'sin contraseña no aprueba');
    assert.equal((await t.post(r.approvalId,{decision:'otra',password:PASSWORD})).status,400);
    assert.equal(await t.status(),'PENDING');
    const ok=await t.post(r.approvalId,{decision:'allow',password:PASSWORD});
    assert.equal(ok.status,200);
    assert.match(await ok.text(),/Plan aprobado/);
    assert.equal(await t.status(),'APPROVED');
    assert.equal((await t.post(r.approvalId,{decision:'allow',password:PASSWORD})).status,409,'no se decide dos veces');
    assert.match(await (await fetch(t.base+'/operator/approve?aid='+r.approvalId)).text(),/ya fue aprobad/i);
  }finally{await t.close();}
});

test('la página rechaza ids inválidos, métodos ajenos, bloquea tras seis fallos y permite rechazar sin contraseña',async()=>{
  const t=await setup();
  try{
    assert.equal((await fetch(t.base+'/operator/approve?aid=nope')).status,404);
    assert.equal((await fetch(t.base+'/operator/approve?aid='+'A'.repeat(43))).status,404);
    assert.equal((await t.post('A'.repeat(43),{decision:'allow',password:PASSWORD})).status,404);
    const r=await t.request();
    assert.equal((await fetch(t.base+'/operator/approve?aid='+r.approvalId,{method:'DELETE'})).status,405);
    for(let i=0;i<6;i++)assert.equal((await t.post(r.approvalId,{decision:'allow',password:'x'.repeat(40)})).status,403);
    const locked=await t.post(r.approvalId,{decision:'allow',password:PASSWORD});
    assert.equal(locked.status,409);
    assert.equal(await t.status(),'LOCKED');
    const r2=await t.request();
    assert.notEqual(r2.approvalId,r.approvalId);
    const denied=await t.post(r2.approvalId,{decision:'deny'});
    assert.equal(denied.status,200);
    assert.match(await denied.text(),/Plan rechazado/);
    assert.equal(await t.status(),'DENIED');
    // El resto de rutas sigue igual.
    assert.equal((await fetch(t.base+'/operator/otra')).status,404);
    assert.equal((await fetch(t.base+'/.well-known/oauth-authorization-server')).status,200);
  }finally{await t.close();}
});

test('la página limita los intentos por dirección',async()=>{
  const t=await setup();
  try{
    const r=await t.request();
    let last=0;
    for(let i=0;i<31;i++)last=(await t.post('B'.repeat(43),{decision:'deny'})).status;
    assert.equal(last,429);
    assert.equal((await t.post(r.approvalId,{decision:'allow',password:PASSWORD})).status,429);
    assert.equal(await t.status(),'PENDING');
  }finally{await t.close();}
});
