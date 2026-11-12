import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture} from './helpers/remote-fixture.mjs';
import {REVIEW_EVENT} from '../src/mcp-events.mjs';

const SECRET='whsec_'+Buffer.alloc(32,9).toString('base64'),URL1='https://hooks.chatgpt.test.openai.com/cb/1';
// Anfitrión de mentira: devuelve el desafío y guarda cada aviso recibido.
async function setup(){
  const posts=[];
  const eventPost=async(url,headers,body)=>{
    const parsed=JSON.parse(body);posts.push({url,headers,body:parsed});
    return {status:200,body:JSON.stringify(parsed.type==='verification'?{challenge:parsed.challenge}:{})};
  };
  const f=await remoteFixture({runtimeOptions:{eventPost}});
  const input={name:REVIEW_EVENT,arguments:{host:'zana-chatgpt'},delivery:{mode:'webhook',url:URL1,secret:SECRET}};
  const events=()=>posts.filter(x=>x.body.name===REVIEW_EVENT);
  return {f,posts,input,events};
}

test('pedir una revisión avisa al monitor suscrito y la ejecución despertada reclama sin el código',async()=>{
  const t=await setup();
  try{
    const ready=await t.f.authorReady(),author={session:ready.author};
    const identity={clientId:author.session.clientId,host:'zana-chatgpt'};
    assert.deepEqual((await t.f.runtime.events.list(identity)).events.map(e=>e.name),[REVIEW_EVENT]);
    const sub=await t.f.runtime.events.subscribe(identity,t.input);
    assert.match(sub.id,/^sub_/);
    const r=await t.f.call('zana_review_request',{missionId:ready.missionId},author.session);
    assert.match(r.ticket,/^ZR-/);
    assert.equal(r.wake.eventsQueued,1);
    await t.f.runtime.events.flush();
    const sent=t.events();
    assert.equal(sent.length,1);
    const ticketId=sent[0].body.data.ticketId;
    assert.match(ticketId,/^[0-9a-f-]{36}$/);
    assert.ok(!JSON.stringify(sent[0]).includes(r.ticket),'el código ZR- nunca sale del servidor');
    // La sesión autora no puede reclamar, ni con el id ni sin argumentos.
    assert.match((await t.f.call('zana_review_claim',{ticket:ticketId},author.session)).error,/AUTHOR_SESSION/);
    assert.match((await t.f.call('zana_review_claim',{},author.session)).error,/NO_PENDING_REVIEW|AUTHOR_SESSION/);
    // Otro cliente OAuth no reclama por id: para él ese ticket no existe.
    const stranger=await t.f.session('zana-chatgpt','zc_other');
    assert.match((await t.f.call('zana_review_claim',{ticket:ticketId},stranger)).error,/TICKET_NOT_FOUND/);
    assert.match((await t.f.call('zana_review_claim',{},stranger)).error,/NO_PENDING_REVIEW/);
    // La ejecución despertada: sesión nueva del mismo cliente, sin el código.
    const woken=await t.f.session('zana-chatgpt',author.session.clientId);
    const claimed=await t.f.call('zana_review_claim',{},woken);
    assert.deepEqual([claimed.state,claimed.ticketId,claimed.sha],['CLAIMED',ticketId,r.sha]);
    assert.equal(claimed.ticket,ticketId,'las tools siguientes usan el id en lugar del código');
    const page=await t.f.call('zana_review_diff',{ticket:ticketId,page:0},woken);
    assert.ok(!page.error,'la sesión revisora lee el diff con el id');
    assert.match((await t.f.call('zana_review_diff',{ticket:ticketId,page:0},stranger)).error,/NOT_REVIEWER/);
    assert.match((await t.f.call('zana_review_claim',{},await t.f.session('zana-chatgpt',author.session.clientId))).error,/NO_PENDING_REVIEW/);
    const health=await t.f.runtime.health();
    assert.deepEqual(health.events,{subscriptions:1,pending:0,accepted:1,failed:0});
  }finally{await t.f.cleanup();}
});

test('sin monitor suscrito el ticket se emite igual; suscribirse después avisa los tickets abiertos',async()=>{
  const t=await setup();
  try{
    const ready=await t.f.authorReady(),author={session:ready.author};
    const r=await t.f.call('zana_review_request',{missionId:ready.missionId},author.session);
    assert.equal(r.wake.eventsQueued,0);
    assert.match(r.instructions,/conversación NUEVA/);
    const identity={clientId:author.session.clientId,host:'zana-chatgpt'};
    await t.f.runtime.events.subscribe(identity,t.input);
    await t.f.runtime.events.flush();
    assert.equal(t.events().length,1,'el ticket que ya estaba abierto se avisa al suscribirse');
    await t.f.runtime.events.unsubscribe(identity,t.input);
    assert.equal((await t.f.runtime.health()).events.subscriptions,0);
    // El código sigue funcionando para la conversación revisora manual.
    const manual=await t.f.session('zana-chatgpt','zc_reviewer');
    assert.equal((await t.f.call('zana_review_claim',{ticket:r.ticket},manual)).state,'CLAIMED');
  }finally{await t.f.cleanup();}
});
