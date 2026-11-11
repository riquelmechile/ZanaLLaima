import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {REVIEW_EVENT,publicIp,validCallback,webhookHeaders,listEvents,subscribeEvent,unsubscribeEvent,
  queueEvent,flushEvents,eventStatus,dropClientEvents} from '../src/mcp-events.mjs';

const SECRET='whsec_'+Buffer.alloc(32,7).toString('base64');
const URL1='https://hooks.chatgpt.test.openai.com/cb/1',T0=Date.parse('2026-11-11T12:00:00Z');
const me={clientId:'zc_one',host:'zana-chatgpt'},other={clientId:'zc_two',host:'zana-chatgpt'};
const TICKET='11111111-1111-4111-8111-111111111111';
function setup(){
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const posts=[];let answer=null;
  // El callback de mentira devuelve el desafío, como hace un anfitrión real.
  const post=async(url,headers,body)=>{
    posts.push({url,headers,body:JSON.parse(body),raw:body});
    if(answer)return answer(JSON.parse(body));
    const parsed=JSON.parse(body);
    return {status:200,body:JSON.stringify(parsed.type==='verification'?{challenge:parsed.challenge}:{})};
  };
  const rw=async fn=>fn(db);
  const input=(extra={})=>({name:REVIEW_EVENT,arguments:{host:'zana-chatgpt'},delivery:{mode:'webhook',url:URL1,secret:SECRET},...extra});
  const subscribe=(identity=me,extra={},now=T0)=>subscribeEvent({rw,post,identity,input:input(extra),now:()=>now});
  return {db,rw,post,posts,input,subscribe,setAnswer:f=>{answer=f;},flush:(now=T0)=>flushEvents({rw,post,now:()=>now})};
}

test('solo acepta callbacks HTTPS públicos y firma como Standard Webhooks',()=>{
  for(const bad of ['http://hooks.example.org/x','https://127.0.0.1/x','https://localhost/x','https://a.internal/x','https://a.local/x',
    'https://user:pw@hooks.example.org/x','https://hooks.example.org:8443/x','https://hooks.example.org/x#f','ftp://hooks.example.org/x','nada','https://sinpunto/x'])
    assert.throws(()=>validCallback(bad),/callback/i,bad);
  assert.equal(validCallback(URL1).hostname,'hooks.chatgpt.test.openai.com');
  for(const ip of ['10.0.0.1','127.0.0.1','169.254.169.254','192.168.1.1','172.16.0.1','100.64.0.1','::1','fe80::1','fc00::1','0.0.0.0','no-es-ip'])
    assert.equal(publicIp(ip),false,ip);
  assert.equal(publicIp('8.8.8.8'),true);
  assert.equal(publicIp('2606:4700::1111'),true);
  const h=webhookHeaders(SECRET,'evt_1','sub_1','{"a":1}',1700000000);
  const expected=createHmac('sha256',Buffer.alloc(32,7)).update('evt_1.1700000000.{"a":1}').digest('base64');
  assert.deepEqual([h['webhook-id'],h['webhook-timestamp'],h['webhook-signature'],h['X-MCP-Subscription-Id']],['evt_1','1700000000','v1,'+expected,'sub_1']);
  assert.throws(()=>webhookHeaders('whsec_corto','e','s','{}'),/signing secret/);
});

test('suscribirse exige el desafío firmado, el host propio y queda ligado al cliente OAuth',async()=>{
  const t=setup();
  try{
    assert.deepEqual(listEvents(me).events.map(e=>[e.name,e.delivery]),[[REVIEW_EVENT,['webhook']]]);
    await assert.rejects(t.subscribe(me,{name:'otro.evento'}),/Unknown event/);
    await assert.rejects(t.subscribe(me,{arguments:{host:'otro-host'}}),/filter/);
    await assert.rejects(t.subscribe(me,{delivery:{mode:'webhook',url:'http://x.example.org/',secret:SECRET}}),/callback/i);
    await assert.rejects(t.subscribe(me,{delivery:{mode:'webhook',url:URL1,secret:'whsec_x'}}),/signing secret/);
    await assert.rejects(t.subscribe(me,{ttlMs:1000}),/TTL/);
    await assert.rejects(t.subscribe(me,{cursor:'abc'}),/replay/);
    assert.equal(t.posts.length,0,'nada sale del servidor antes de validar');
    t.setAnswer(()=>({status:200,body:JSON.stringify({challenge:'otro'})}));
    await assert.rejects(t.subscribe(),/challenge_failed/);
    t.setAnswer(()=>({status:500,body:''}));
    await assert.rejects(t.subscribe(),/verification HTTP error/);
    assert.equal(eventStatus(t.db,{now:T0}).subscriptions,0,'un callback sin verificar no se guarda');
    t.setAnswer(null);
    const before=t.posts.length,sub=await t.subscribe();
    assert.match(sub.id,/^sub_[0-9a-f]{32}$/);
    assert.deepEqual([sub.cursor,sub.truncated,sub.refreshBefore],[null,false,new Date(T0+7*86400_000*0.75).toISOString()]);
    const v=t.posts[before];
    assert.equal(v.body.type,'verification');
    assert.equal(v.headers['X-MCP-Subscription-Id'],sub.id);
    assert.equal((await t.subscribe()).id,sub.id);
    assert.equal(t.posts.length,before+1,'renovar con el mismo secreto no vuelve a verificar');
    assert.deepEqual(eventStatus(t.db,{now:T0}),{subscriptions:1,pending:0,accepted:0,failed:0});
    assert.equal(eventStatus(t.db,{now:T0+8*86400_000}).subscriptions,0,'vence a los 7 días si no se renueva');
    assert.ok(!JSON.stringify(eventStatus(t.db,{now:T0})).includes('whsec_'));
    unsubscribeEvent(t.db,{identity:other,input:t.input()});
    assert.equal(eventStatus(t.db,{now:T0}).subscriptions,1,'otro cliente no puede borrar la suscripción');
    unsubscribeEvent(t.db,{identity:me,input:t.input()});
    assert.equal(eventStatus(t.db,{now:T0}).subscriptions,0);
  }finally{t.db.close();}
});

test('el aviso lleva solo el puntero, va firmado y llega una vez por suscripción del cliente',async()=>{
  const t=setup();
  try{
    assert.equal(queueEvent(t.db,{clientId:me.clientId,ticketId:TICKET,now:T0}),0,'sin suscripción no hay aviso');
    const sub=await t.subscribe();
    await t.subscribe(other,{delivery:{mode:'webhook',url:'https://hooks.chatgpt.test.openai.com/cb/2',secret:SECRET}});
    assert.equal(queueEvent(t.db,{clientId:me.clientId,ticketId:TICKET,now:T0}),1);
    assert.equal(queueEvent(t.db,{clientId:me.clientId,ticketId:TICKET,now:T0}),0,'no se duplica');
    assert.throws(()=>queueEvent(t.db,{clientId:me.clientId,ticketId:'ZR-AAAA-BBBB-CCCC-DDDD',now:T0}),/INVALID_EVENT_POINTER/);
    const before=t.posts.length;
    assert.equal(await t.flush(),1);
    const sent=t.posts[before];
    assert.equal(sent.url,URL1,'solo al callback del cliente dueño del ticket');
    assert.deepEqual([sent.body.name,sent.body.data,sent.body.cursor],[REVIEW_EVENT,{ticketId:TICKET},null]);
    assert.deepEqual(Object.keys(sent.body).sort(),['cursor','data','eventId','name','timestamp']);
    const [id,ts,sig]=[sent.headers['webhook-id'],sent.headers['webhook-timestamp'],sent.headers['webhook-signature']];
    assert.equal(sig,'v1,'+createHmac('sha256',Buffer.alloc(32,7)).update(id+'.'+ts+'.'+sent.raw).digest('base64'));
    assert.equal(sent.headers['X-MCP-Subscription-Id'],sub.id);
    assert.equal(await t.flush(),0);
    assert.deepEqual(eventStatus(t.db,{now:T0}),{subscriptions:2,pending:0,accepted:1,failed:0});
  }finally{t.db.close();}
});

test('reintenta con espera, se rinde a los cinco intentos y nunca envía dos veces el mismo intento',async()=>{
  const u=setup();
  try{
    await u.subscribe();
    queueEvent(u.db,{clientId:me.clientId,ticketId:TICKET,now:T0});
    u.setAnswer(()=>({status:503,body:''}));
    const before=u.posts.length;
    await Promise.all([u.flush(),u.flush()]);
    assert.equal(u.posts.length,before+1,'dos vaciados a la vez hacen un solo envío');
    assert.equal(await u.flush(T0+1000),0,'respeta la espera antes de reintentar');
    let now=T0;
    for(let i=0;i<6;i++){now+=600_000;await u.flush(now);}
    assert.equal(u.posts.length,before+5,'cinco intentos como máximo');
    assert.deepEqual(eventStatus(u.db,{now}),{subscriptions:1,pending:0,accepted:0,failed:1});
    // 410 del anfitrión: se cierra de inmediato. Suscripción vencida o cliente revocado: no se envía.
    queueEvent(u.db,{clientId:me.clientId,ticketId:'22222222-2222-4222-8222-222222222222',now});
    u.setAnswer(()=>({status:410,body:''}));
    await u.flush(now);
    assert.equal(eventStatus(u.db,{now}).failed,2);
    queueEvent(u.db,{clientId:me.clientId,ticketId:'33333333-3333-4333-8333-333333333333',now});
    assert.equal(dropClientEvents(u.db,{clientId:me.clientId,now}),1);
    const sentBefore=u.posts.length;
    await u.flush(now);
    assert.equal(u.posts.length,sentBefore,'revocado el cliente, no sale ningún aviso');
    assert.deepEqual(eventStatus(u.db,{now}),{subscriptions:0,pending:0,accepted:0,failed:3});
  }finally{u.db.close();}
});
