import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {remoteFixture,sleep} from './helpers/remote-fixture.mjs';
import {remoteRead,remoteWrite,readState,transact} from '../src/store.mjs';
import {createHttpServer,httpSettings} from '../src/http.mjs';
import {REVIEW_DONE_EVENT} from '../src/mcp-events.mjs';

const old='2000-01-01T00:00:00.000Z';
const SECRET='whsec_'+Buffer.alloc(32,7).toString('base64');
const rows=()=>remoteRead(db=>db.prepare('SELECT * FROM review_tickets ORDER BY rowid').all());
const state=()=>readState();
async function expireTicket(f,id,kind='OPEN'){
  await remoteWrite(db=>db.prepare(kind==='OPEN'
    ?'UPDATE review_tickets SET expires_at=? WHERE ticket_id=?'
    :'UPDATE review_tickets SET claimed_at=? WHERE ticket_id=?').run(old,id));
  await f.runtime.review.expire();
}
async function newTicket(f,ready){
  const r=await f.call('zana_review_request',{missionId:ready.missionId},ready.author);
  assert.equal(r.error,undefined,r.error);
  return (await rows()).at(-1).ticket_id;
}

test('F1 OPEN: reembolsa una vez, emite EXPIRED solo al cliente autor y permite ticket nuevo',async()=>{
  const posts=[];
  const f=await remoteFixture({runtimeOptions:{eventPost:async(url,headers,body)=>{
    const msg=JSON.parse(body);posts.push({url,msg});
    return {status:200,body:JSON.stringify(msg.type==='verification'?{challenge:msg.challenge}:{})};
  }}});
  try{
    const ready=await f.authorReady(),a=ready.author.clientId;
    for(const [client,url] of [[a,'https://hooks.chatgpt.test.openai.com/f1-author'],
      ['zc_other','https://hooks.chatgpt.test.openai.com/f1-other']]){
      await f.runtime.events.subscribe({clientId:client,host:'zana-chatgpt'},
        {name:REVIEW_DONE_EVENT,arguments:{host:'zana-chatgpt'},
          delivery:{mode:'webhook',url,secret:SECRET}});
    }
    const id=await newTicket(f,ready);
    assert.equal((await state()).reviewCount,1);
    await expireTicket(f,id);
    assert.equal((await rows())[0].state,'EXPIRED');
    assert.equal((await state()).reviewCount,0);
    assert.equal((await state()).expiredRefunds,1);
    await f.runtime.events.flush();
    const done=posts.filter(x=>x.msg.name===REVIEW_DONE_EVENT);
    assert.equal(done.length,1);
    assert.match(done[0].url,/f1-author$/);
    assert.deepEqual(done[0].msg.data,{ticketId:id,verdict:'EXPIRED'});
    await f.runtime.review.expire();
    assert.equal((await state()).reviewCount,0);
    assert.equal((await state()).expiredRefunds,1);
    assert.equal(posts.filter(x=>x.msg.name===REVIEW_DONE_EVENT).length,1);
    await newTicket(f,ready);
    assert.equal((await state()).reviewCount,1);
  }finally{await f.cleanup();}
});

test('F1 CLAIMED sin veredicto: ABANDONED devuelve ronda, pero ticket con veredicto no devuelve ni avisa',async()=>{
  const f=await remoteFixture();
  try{
    const ready=await f.authorReady();
    const r=await f.call('zana_review_request',{missionId:ready.missionId},ready.author);
    const id=(await rows())[0].ticket_id;
    const reviewer=await f.session();
    assert.equal((await f.call('zana_review_claim',{ticket:r.ticket},reviewer)).state,'CLAIMED');
    await expireTicket(f,id,'CLAIMED');
    assert.equal((await rows())[0].state,'ABANDONED');
    assert.equal((await state()).reviewCount,0);
    const id2=await newTicket(f,ready);
    await remoteWrite(db=>db.prepare("UPDATE review_tickets SET state='FINALIZING',verdict='APPROVE',claimed_at=? WHERE ticket_id=?").run(old,id2));
    await f.runtime.review.expire();
    assert.equal((await rows()).at(-1).state,'ABANDONED');
    assert.equal((await state()).reviewCount,1);
    assert.equal((await state()).expiredRefunds,1);
  }finally{await f.cleanup();}
});

test('F1: límite durable de cinco reembolsos y sexto ticket expirado no devuelve más',async()=>{
  const f=await remoteFixture();
  try{
    const ready=await f.authorReady();
    for(let n=1;n<=6;n++){
      const id=await newTicket(f,ready);
      await expireTicket(f,id);
      assert.equal((await state()).expiredRefunds,Math.min(5,n));
      assert.equal((await state()).reviewCount,n<=5?0:1);
    }
    await f.runtime.review.expire();
    assert.equal((await state()).reviewCount,1);
  }finally{await f.cleanup();}
});

test('F1: barrido periódico sin consultas vence CLAIMED y reduce /health staleTickets',async()=>{
  const f=await remoteFixture();
  let http;
  try{
    const ready=await f.authorReady();
    const r=await f.call('zana_review_request',{missionId:ready.missionId},ready.author);
    const reviewer=await f.session();
    assert.equal((await f.call('zana_review_claim',{ticket:r.ticket},reviewer)).state,'CLAIMED');
    const id=(await rows())[0].ticket_id;
    await remoteWrite(db=>db.prepare('UPDATE review_tickets SET claimed_at=? WHERE ticket_id=?').run(old,id));
    assert.equal((await f.runtime.health()).staleTickets,1);
    const settings=httpSettings({ZANA_PUBLIC_HOST:'zana.test',ZANA_OAUTH_DB:join(f.dir,'oauth.sqlite'),ZANA_HTTP_PORT:'0'});
    http=createHttpServer({runtime:{...f.runtime,planApproval:null},oauth:{},settings,reviewSweepMs:20});
    await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
    for(let i=0;i<30&&(await rows())[0].state!=='ABANDONED';i++)await sleep(20);
    assert.equal((await rows())[0].state,'ABANDONED');
    assert.equal((await f.runtime.health()).staleTickets,0);
    assert.equal((await state()).reviewCount,0);
  }finally{
    if(http){http.closeAllConnections();await new Promise(resolve=>http.close(resolve));}
    await f.cleanup();
  }
});

test('F1: solicitud posterior a vencimiento perezoso admite ronda aun en límite',async()=>{
  const f=await remoteFixture();
  try{
    const ready=await f.authorReady();
    const id=await newTicket(f,ready);
    await transact(m=>{m.reviewCount=m.budget.maxReviewRounds;m.revision++;return m;});
    await remoteWrite(db=>db.prepare('UPDATE review_tickets SET expires_at=? WHERE ticket_id=?').run(old,id));
    const next=await f.call('zana_review_request',{missionId:ready.missionId},ready.author);
    assert.equal(next.error,undefined,next.error);
    assert.equal((await state()).reviewCount,5);
    assert.equal((await state()).expiredRefunds,1);
    assert.deepEqual((await rows()).map(x=>x.state),['EXPIRED','OPEN']);
  }finally{await f.cleanup();}
});
