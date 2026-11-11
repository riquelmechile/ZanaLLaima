import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {remoteFixture} from './helpers/remote-fixture.mjs';
import {EmbeddedOAuth} from '../src/oauth.mjs';
import {createHttpServer,httpSettings} from '../src/http.mjs';

const PASSWORD='p'.repeat(40),ORIGIN='https://zanallaima.test';
const answers={goal:'Gestionar hitos',users:'Equipos',platform:'Web',features:'Planes',data:'Sin secretos'};
const alternatives=['node','go'].map(id=>({id,technology:id==='node'?'Node <b>22</b>':'Go',rationale:'razón-'+id,benefits:'ventaja-'+id,tradeoffs:'costo-'+id,
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
    milestones:[{id:'core',objective:'Diseñar el <script>modelo</script>',acceptance:'Tests',dependsOn:[]},
      {id:'web',objective:'Publicar la web',acceptance:'Navegable',dependsOn:['core']}]},s);
  await f.call('zana_workspace_update',{workspaceId:w0.workspaceId,expectedVersion:1,plan},s);
  const request=async()=>f.call('zana_plan_approval_request',{workspaceId:w0.workspaceId,expectedVersion:2},s);
  const status=async()=>(await f.call('zana_plan_approval_status',{workspaceId:w0.workspaceId},s)).status;
  const post=(aid,fields,headers={origin:ORIGIN})=>fetch(base+'/operator/approve?aid='+aid,{method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams(fields).toString()});
  return {f,base,plan,request,status,post,workspaceId:w0.workspaceId,
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

test('la página limita los intentos por dirección, sin gastar el limitador en solicitudes inventadas',async()=>{
  const t=await setup();
  try{
    for(let i=0;i<35;i++)assert.equal((await t.post('B'.repeat(43),{decision:'deny'})).status,404);
    const r=await t.request();
    let last=0;
    for(let i=0;i<31;i++)last=(await t.post(r.approvalId,{decision:'allow',password:'x'.repeat(40)})).status;
    assert.equal(last,429);
    assert.equal((await t.post(r.approvalId,{decision:'deny'})).status,429);
    assert.equal((await fetch(t.base+'/.well-known/oauth-authorization-server')).status,200);
  }finally{await t.close();}
});

// Ronda de corrección tras la revisión 4R.
test('la página muestra todo lo que cubre el digest, no un resumen',async()=>{
  const t=await setup();
  try{
    const html=await (await fetch(t.base+'/operator/approve?aid='+(await t.request()).approvalId)).text();
    for(const visible of ['Sin secretos','Gestionar hitos','razón-go','ventaja-go','costo-go','costo-node',
      'https://example.org/go','2026-11-10','Publicar la web','Depende de:</em> core'])
      assert.ok(html.includes(visible),'falta en la página: '+visible);
  }finally{await t.close();}
});

test('la página acepta el envío real del navegador, solo formularios, y no cae con una URL malformada',async()=>{
  const t=await setup();
  try{
    const r=await t.request();
    const u=new URL(t.base);
    const malformed=await new Promise((ok,fail)=>{
      const q=httpRequest({host:u.hostname,port:u.port,path:'//[',method:'GET'},res=>{res.resume();ok(res.statusCode);});
      q.on('error',fail);q.end();
    });
    assert.equal(malformed,404);
    const json=await fetch(t.base+'/operator/approve?aid='+r.approvalId,{method:'POST',
      headers:{'content-type':'application/json',origin:ORIGIN},body:JSON.stringify({decision:'deny'})});
    assert.equal(json.status,400);
    assert.equal(await t.status(),'PENDING');
    assert.equal((await t.post(r.approvalId,{decision:'deny'},{origin:'null','sec-fetch-site':'cross-site'})).status,403);
    assert.equal((await t.post(r.approvalId,{decision:'deny'},{origin:'null','sec-fetch-site':'same-origin'})).status,200);
    assert.equal(await t.status(),'DENIED');
  }finally{await t.close();}
});

test('el operador revoca una aprobación desde la misma página y queda auditado con su origen',async()=>{
  const t=await setup();
  try{
    const r=await t.request();
    assert.equal((await t.post(r.approvalId,{decision:'revoke'})).status,409,'no hay nada que revocar todavía');
    assert.equal((await t.post(r.approvalId,{decision:'allow',password:PASSWORD})).status,200);
    assert.match(await (await fetch(t.base+'/operator/approve?aid='+r.approvalId)).text(),/value="revoke"/);
    const revoked=await t.post(r.approvalId,{decision:'revoke'});
    assert.equal(revoked.status,200);
    assert.match(await revoked.text(),/Aprobación revocada/);
    assert.equal(await t.status(),'REVOKED');
    const rows=(await t.f.runtime.readAudit({limit:50})).filter(x=>x.tool==='operator_plan_approval');
    assert.deepEqual(rows.map(x=>x.outcome).sort(),['APPROVED','REVOKED']);
    assert.ok(rows.every(x=>x.detail.from==='127.0.0.1'&&x.detail.workspaceId===t.workspaceId));
  }finally{await t.close();}
});

// Segunda ronda de corrección (reverificación 4R).
test('una aprobación cuyo plan ya no es el vigente se puede revocar desde la página',async()=>{
  const t=await setup();
  try{
    const r=await t.request();
    assert.equal((await t.post(r.approvalId,{decision:'allow',password:PASSWORD})).status,200);
    const s=await t.f.session('zana-chatgpt','oauth-one');
    const archived=await t.f.call('zana_workspace_set_archived',{workspaceId:t.workspaceId,expectedVersion:2,archived:true},s);
    assert.ok(archived.archivedAt);
    assert.equal(await t.status(),'SUPERSEDED');
    const page=await (await fetch(t.base+'/operator/approve?aid='+r.approvalId)).text();
    assert.match(page,/sigue guardada/);
    assert.match(page,/value="revoke"/);
    assert.equal((await t.post(r.approvalId,{decision:'revoke'})).status,200);
    await t.f.call('zana_workspace_set_archived',{workspaceId:t.workspaceId,expectedVersion:3,archived:false},s);
    assert.equal(await t.status(),'REVOKED','restaurar el proyecto ya no revive la aprobación');
    assert.doesNotMatch(await (await fetch(t.base+'/operator/approve?aid='+r.approvalId)).text(),/value="revoke"/);
  }finally{await t.close();}
});

// Bootstrap: autorización de crear el repositorio.
test('la página pide autorizar la creación del repositorio y lo audita aparte',async()=>{
  const t=await setup();
  try{
    const plan=await t.request();
    assert.equal((await t.post(plan.approvalId,{decision:'allow',password:PASSWORD})).status,200);
    const s=await t.f.session('zana-chatgpt','oauth-one');
    const r=await t.f.call('zana_bootstrap_request',{workspaceId:t.workspaceId,expectedVersion:2,owner:'o',name:'r<b>',visibility:'public'},s);
    assert.match(r.error,/INVALID_REPOSITORY/);
    const op=await t.f.call('zana_bootstrap_request',{workspaceId:t.workspaceId,expectedVersion:2,owner:'o',name:'r',visibility:'public'},s);
    const aid=op.authorization.approvalId;
    const html=await (await fetch(t.base+'/operator/approve?aid='+aid)).text();
    for(const visible of ['<code>o/r</code> (PÚBLICO)',op.intentDigest,t.plan.digest,'Autorizar la creación','type="password"'])
      assert.ok(html.includes(visible),'falta en la página: '+visible);
    assert.ok(!html.includes('Aprobar este plan'));
    assert.equal((await t.post(aid,{decision:'allow',password:'x'.repeat(40)})).status,403);
    const ok=await t.post(aid,{decision:'allow',password:PASSWORD});
    assert.equal(ok.status,200);
    assert.match(await ok.text(),/Creación autorizada/);
    assert.equal((await t.f.call('zana_bootstrap_status',{operationId:op.operationId},s)).authorization.status,'APPROVED');
    const closed=await (await fetch(t.base+'/operator/approve?aid='+aid)).text();
    assert.match(closed,/ya fue autorizada/);
    assert.match(closed,/value="revoke"/);
    assert.match(await (await t.post(aid,{decision:'revoke'})).text(),/Autorización revocada/);
    assert.equal((await t.f.call('zana_bootstrap_status',{operationId:op.operationId},s)).authorization.status,'REVOKED');
    assert.equal(await t.status(),'APPROVED','el plan sigue aprobado');
    const audit=(await t.f.runtime.readAudit({limit:50})).filter(x=>x.tool==='operator_repository_approval');
    assert.deepEqual(audit.map(x=>x.outcome).sort(),['APPROVED','REFUSED','REVOKED']);
  }finally{await t.close();}
});

// Ronda de corrección tras la revisión 4R de la página de bootstrap.
test('la página de repo no promete uso único, marca privado y usa sus propios textos de cierre',async()=>{
  const t=await setup();
  try{
    const plan=await t.request();
    await t.post(plan.approvalId,{decision:'allow',password:PASSWORD});
    const s=await t.f.session('zana-chatgpt','oauth-one');
    const op=await t.f.call('zana_bootstrap_request',{workspaceId:t.workspaceId,expectedVersion:2,owner:'o',name:'r'},s);
    const aid=op.authorization.approvalId;
    const html=await (await fetch(t.base+'/operator/approve?aid='+aid)).text();
    assert.ok(html.includes('<code>o/r</code> (privado)'));
    assert.doesNotMatch(html,/una vez/,'el uso único lo hará cumplir la ejecución; hoy no se promete');
    assert.equal((await t.post(aid,{decision:'allow',password:PASSWORD})).status,200);
    // El operador revoca la aprobación del plan: la autorización del repo queda dormida.
    await t.post(plan.approvalId,{decision:'revoke'});
    const dormant=await (await fetch(t.base+'/operator/approve?aid='+aid)).text();
    assert.match(dormant,/El plan aprobado cambió o su aprobación se retiró/);
    assert.match(dormant,/value="revoke"/);
    assert.doesNotMatch(dormant,/type="password"/);
    // Una solicitud pendiente cuyo plan dejó de estar aprobado responde con el texto de repo.
    const plan2=await t.request();
    await t.post(plan2.approvalId,{decision:'allow',password:PASSWORD});
    const op2=await t.f.call('zana_bootstrap_request',{workspaceId:t.workspaceId,expectedVersion:2,owner:'o',name:'r'},s);
    assert.equal(op2.authorization.status,'PENDING');
    await t.post(plan2.approvalId,{decision:'revoke'});
    const late=await t.post(op2.authorization.approvalId,{decision:'allow',password:PASSWORD});
    assert.equal(late.status,409);
    assert.match(await late.text(),/El plan aprobado cambió o su aprobación se retiró/);
    const audit=(await t.f.runtime.readAudit({limit:80})).filter(x=>x.tool==='operator_repository_approval'&&x.outcome==='APPROVED');
    assert.deepEqual(audit.map(x=>[x.detail.subject.repo,x.detail.subject.visibility]),[['o/r','private']]);
  }finally{await t.close();}
});
