import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {remoteFixture,sleep} from './helpers/remote-fixture.mjs';
import {remoteRead,remoteWrite,readState,transact,backupState,restoreBackup} from '../src/store.mjs';
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


test('F1: dos barridos y vencimiento perezoso no duplican reembolsos con reviewCount >=2',async()=>{
  const f=await remoteFixture();
  try{
    const ready=await f.authorReady();
    await newTicket(f,ready);
    const id=await newTicket(f,ready);
    assert.equal((await state()).reviewCount,2);
    await remoteWrite(db=>db.prepare('UPDATE review_tickets SET expires_at=? WHERE ticket_id=?').run(old,id));
    await Promise.all([f.runtime.review.expire(),f.runtime.review.expire(),f.runtime.review.expire()]);
    assert.equal((await state()).reviewCount,1);
    assert.equal((await state()).expiredRefunds,1);
    const next=await newTicket(f,ready);
    await remoteWrite(db=>db.prepare('UPDATE review_tickets SET expires_at=? WHERE ticket_id=?').run(old,next));
    await newTicket(f,ready); // vencimiento perezoso y nuevo ticket en la misma transaccion
    await f.runtime.review.expire();
    assert.equal((await state()).reviewCount,2);
    assert.equal((await state()).expiredRefunds,2);
  }finally{await f.cleanup();}
});

test('F1: zana_mission_adopt conserva el reembolso del vencimiento perezoso',async()=>{
  const f=await remoteFixture();
  try{
    const ready=await f.authorReady(),id=await newTicket(f,ready);
    await remoteWrite(db=>db.prepare('UPDATE review_tickets SET expires_at=? WHERE ticket_id=?').run(old,id));
    const adopter=await f.session('zana-chatgpt',ready.author.clientId);
    const result=await f.call('zana_mission_adopt',{missionId:ready.missionId},adopter);
    assert.equal(result.error,undefined,result.error);
    assert.equal((await state()).reviewCount,0);
    assert.equal((await state()).expiredRefunds,1);
  }finally{await f.cleanup();}
});

test('F1/R11: restaurar en ambos sentidos fusiona reembolsos y mantiene el cupo devuelto',async()=>{
  const f=await remoteFixture();
  const prev=process.env.ZANA_RESTORE_OFFLINE;
  process.env.ZANA_RESTORE_OFFLINE='1';
  try{
    const ready=await f.authorReady(),id=await newTicket(f,ready);
    const before=join(f.dir,'before.sqlite'),after=join(f.dir,'after.sqlite');
    await backupState(before);
    await expireTicket(f,id);
    await backupState(after);
    await restoreBackup(before,process.env.ZANA_STATE_FILE,{offline:true});
    assert.equal((await state()).reviewCount,0);
    assert.equal((await state()).expiredRefunds,1);
    await restoreBackup(after,process.env.ZANA_STATE_FILE,{offline:true});
    assert.equal((await state()).reviewCount,0);
    assert.equal((await state()).expiredRefunds,1);
  }finally{
    if(prev===undefined)delete process.env.ZANA_RESTORE_OFFLINE;
    else process.env.ZANA_RESTORE_OFFLINE=prev;
    await f.cleanup();
  }
});

test('F1: CANCELLED, contador 0 y metadata corrupta no otorgan cupo',async()=>{
  for(const variant of ['CANCELLED','ZERO','CORRUPT']){
    const f=await remoteFixture();
    try{
      const ready=await f.authorReady(),id=await newTicket(f,ready);
      await remoteWrite(db=>{
        if(variant==='CANCELLED')db.prepare("UPDATE active_mission SET lifecycle='CANCELLED'").run();
        if(variant==='ZERO')db.prepare('UPDATE active_mission SET review_count=0').run();
        if(variant==='CORRUPT')db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)')
          .run('zana:expired-refunds:'+ready.missionId,'corrupt');
      });
      await expireTicket(f,id);
      const outcome=await remoteRead(db=>({mission:db.prepare('SELECT review_count FROM active_mission').get(),
        refunds:db.prepare('SELECT value FROM metadata WHERE key=?').get('zana:expired-refunds:'+ready.missionId)}));
      assert.equal(outcome.mission.review_count,variant==='ZERO'?0:1,variant);
      assert.equal(outcome.refunds?.value,variant==='CORRUPT'?'corrupt':undefined,variant);
    }finally{await f.cleanup();}
  }
});

test('F1: error del barrido queda registrado, no tumba HTTP y close cancela timer',async()=>{
  const f=await remoteFixture();
  let server,calls=0;
  const errors=[];
  try{
    const settings=httpSettings({ZANA_PUBLIC_HOST:'zana.test',ZANA_OAUTH_DB:join(f.dir,'oauth.sqlite'),ZANA_HTTP_PORT:'0'});
    server=createHttpServer({runtime:{...f.runtime,planApproval:null,
      review:{expire:async()=>{calls++;throw Error('test sweep failure');}}},
      oauth:{},settings,reviewSweepMs:12,log:{error:(...a)=>errors.push(a)}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    await sleep(55);
    assert.ok(calls>0);
    assert.ok(errors.some(x=>String(x[0]).includes('Review sweep failed')));
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    const stopped=calls;
    await sleep(45);
    assert.equal(calls,stopped,'clearInterval al cerrar servidor');
  }finally{
    if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    await f.cleanup();
  }
});
