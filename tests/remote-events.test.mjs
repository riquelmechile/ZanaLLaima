import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {remoteFixture} from './helpers/remote-fixture.mjs';
import {remoteWrite,remoteRead} from '../src/store.mjs';
import {queueEvent,REVIEW_EVENT,REVIEW_DONE_EVENT} from '../src/mcp-events.mjs';

const SECRET='whsec_'+Buffer.alloc(32,9).toString('base64'),URL1='https://hooks.chatgpt.test.openai.com/cb/1';
const put=(db,key,value)=>db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(key,JSON.stringify(value));
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
    assert.deepEqual((await t.f.runtime.events.list(identity)).events.map(e=>e.name),[REVIEW_EVENT,REVIEW_DONE_EVENT]);
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


test('adopción: solo mismo cliente OAuth, sin revisión activa, y es idempotente',async()=>{
  const t=await setup();
  try{
    const ready=await t.f.authorReady(),missionId=ready.missionId;
    const other=await t.f.session('zana-chatgpt','zc_other');
    assert.match((await t.f.call('zana_mission_adopt',{missionId},other)).error,/ADOPT_OTHER_CLIENT/);
    const next=await t.f.session('zana-chatgpt',ready.author.clientId);
    const first=await t.f.call('zana_mission_adopt',{missionId},next);
    assert.deepEqual(first,{missionId,adopted:true,alreadyAdopted:false});
    assert.equal((await t.f.call('zana_mission_adopt',{missionId},next)).alreadyAdopted,true);
    const request=await t.f.call('zana_review_request',{missionId},ready.author);
    assert.ok(request.ticket);
    const during=await t.f.session('zana-chatgpt',ready.author.clientId);
    assert.match((await t.f.call('zana_mission_adopt',{missionId},during)).error,/ADOPT_REVIEW_IN_PROGRESS/);
    const reviewer=await t.f.session('zana-chatgpt',ready.author.clientId);
    assert.equal((await t.f.call('zana_review_claim',{ticket:request.ticket},reviewer)).state,'CLAIMED');
    assert.match((await t.f.call('zana_mission_adopt',{missionId},reviewer)).error,/REVIEWER_READ_ONLY/);
  }finally{await t.f.cleanup();}
});

test('adopción rechaza una unidad viva de otra sesión',async()=>{
  const t=await setup();
  try{
    const ready=await t.f.authorReady({green:false,pull:false,complete:false});
    const next=await t.f.session('zana-chatgpt',ready.author.clientId);
    assert.match((await t.f.call('zana_mission_adopt',{missionId:ready.missionId},next)).error,/ADOPT_MISSION_BUSY/);
  }finally{await t.f.cleanup();}
});

test('adopt expira de forma perezosa un ticket OPEN vencido',async()=>{
  const t=await setup();
  try{
    const ready=await t.f.authorReady(),missionId=ready.missionId;
    const req=await t.f.call('zana_review_request',{missionId},ready.author);
    assert.ok(req.ticket);
    await remoteWrite(db=>db.prepare('UPDATE review_tickets SET expires_at=? WHERE mission_id=?')
      .run(new Date(Date.now()-60_000).toISOString(),missionId));
    const session=await t.f.session('zana-chatgpt',ready.author.clientId);
    const result=await t.f.call('zana_mission_adopt',{missionId},session);
    assert.equal(result.adopted,true,JSON.stringify(result));
  }finally{await t.f.cleanup();}
});

test('review.ready conserva el id legado para deduplicar una entrega ACCEPTED',async()=>{
  const t=await setup();
  try{
    const clientId='zc_legacy',ticketId='11111111-1111-4111-8111-111111111111',subId='sub_legacy';
    const legacyId='evt_'+createHash('sha256').update(subId+':'+ticketId).digest('hex').slice(0,32);
    const added=await remoteWrite(db=>{
      put(db,'zana:evsub:'+subId,{schema:'zana.evsub.v1',id:subId,ownerClient:clientId,host:'zana-chatgpt',
        url:URL1,secret:SECRET,expiresAt:new Date(Date.now()+86_400_000).toISOString(),verifiedAt:new Date().toISOString()});
      put(db,'zana:evout:'+legacyId,{schema:'zana.evout.v1',id:legacyId,subId,ticketId,state:'ACCEPTED',attempts:1,
        nextAt:Date.now(),lastStatus:200,terminalAt:Date.now()});
      return queueEvent(db,{clientId,ticketId});
    });
    assert.equal(added,0,'se reencoló un aviso ya entregado porque cambió su id');
  }finally{await t.f.cleanup();}
});

test('solo una de dos sesiones simultáneas adopta la misión',async()=>{
  const t=await setup();
  try{
    const ready=await t.f.authorReady(),missionId=ready.missionId;
    const [a,b]=await Promise.all([t.f.session('zana-chatgpt',ready.author.clientId),t.f.session('zana-chatgpt',ready.author.clientId)]);
    const results=await Promise.all([
      t.f.call('zana_mission_adopt',{missionId},a),t.f.call('zana_mission_adopt',{missionId},b)
    ]);
    assert.equal(results.filter(result=>result.adopted).length,1,JSON.stringify(results));
    assert.equal(results.filter(result=>/ADOPT_MISSION_BUSY/.test(result.error??'')).length,1,JSON.stringify(results));
  }finally{await t.f.cleanup();}
});

test('repetir adopt en la misma sesión no emite STATE_CHANGED',async()=>{
  const t=await setup();
  try{
    const ready=await t.f.authorReady(),missionId=ready.missionId;
    const session=await t.f.session('zana-chatgpt',ready.author.clientId);
    assert.equal((await t.f.call('zana_mission_adopt',{missionId},session)).adopted,true);
    const count=()=>remoteRead(db=>db.prepare("SELECT COUNT(*) count FROM state_events WHERE category='STATE_CHANGED'").get().count);
    const before=await count();
    assert.equal((await t.f.call('zana_mission_adopt',{missionId},session)).alreadyAdopted,true);
    assert.equal(await count(),before);
  }finally{await t.f.cleanup();}
});

test('una adopción posterior invalida la generación anterior aunque registre actividad',async()=>{
  const t=await setup();
  try{
    const ready=await t.f.authorReady(),missionId=ready.missionId;
    const a=await t.f.session('zana-chatgpt',ready.author.clientId);
    const b=await t.f.session('zana-chatgpt',ready.author.clientId);
    assert.equal((await t.f.call('zana_mission_adopt',{missionId},a)).adopted,true);
    const old=new Date(Date.now()-24*60*60_000).toISOString();
    await remoteWrite(db=>db.prepare('UPDATE remote_activity SET created_at=? WHERE mission_id=? AND session_id=?').run(old,missionId,a.sessionId));
    assert.equal((await t.f.call('zana_mission_adopt',{missionId},b)).adopted,true);
    const batch=await t.f.call('zana_start_batch',{},a);
    assert.ok(batch.packets?.length,JSON.stringify(batch));
    const result=await t.f.call('zana_mission_adopt',{missionId},a);
    assert.match(result.error,/ADOPT_MISSION_BUSY.*hasta .*Z$/,JSON.stringify(result));
  }finally{await t.f.cleanup();}
});

test('la adopción vigente se decide por seq aunque el reloj retroceda',async()=>{
  const t=await setup();
  try{
    const ready=await t.f.authorReady(),missionId=ready.missionId;
    const a=await t.f.session('zana-chatgpt',ready.author.clientId);
    const b=await t.f.session('zana-chatgpt',ready.author.clientId);
    assert.equal((await t.f.call('zana_mission_adopt',{missionId},a)).adopted,true);
    const expired=new Date(Date.now()-24*60*60_000).toISOString();
    await remoteWrite(db=>db.prepare("UPDATE remote_activity SET created_at=? WHERE mission_id=? AND session_id=? AND kind='MISSION_ADOPT'")
      .run(expired,missionId,a.sessionId));
    assert.equal((await t.f.call('zana_mission_adopt',{missionId},b)).adopted,true);
    const laterClock=new Date().toISOString(),earlierClock=new Date(Date.now()-60_000).toISOString();
    await remoteWrite(db=>{
      db.prepare("UPDATE remote_activity SET created_at=? WHERE mission_id=? AND session_id=? AND kind='MISSION_ADOPT'")
        .run(laterClock,missionId,a.sessionId);
      db.prepare("UPDATE remote_activity SET created_at=? WHERE mission_id=? AND session_id=? AND kind='MISSION_ADOPT'")
        .run(earlierClock,missionId,b.sessionId);
    });
    const result=await t.f.call('zana_mission_adopt',{missionId},b);
    assert.equal(result.alreadyAdopted,true,JSON.stringify(result));
  }finally{await t.f.cleanup();}
});

test('una adopción posterior al cierre sigue vigente aunque su reloj quede bajo finalized_at',async()=>{
  const t=await setup();
  try{
    const ready=await t.f.authorReady(),missionId=ready.missionId;
    const request=await t.f.call('zana_review_request',{missionId},ready.author);
    assert.ok(request.ticket);
    const future=new Date(Date.now()+60_000).toISOString();
    await remoteWrite(db=>db.prepare("UPDATE review_tickets SET state='FINALIZED',finalized_at=?,updated_at=? WHERE mission_id=?")
      .run(future,future,missionId));
    const a=await t.f.session('zana-chatgpt',ready.author.clientId);
    const b=await t.f.session('zana-chatgpt',ready.author.clientId);
    assert.equal((await t.f.call('zana_mission_adopt',{missionId},a)).adopted,true);
    const result=await t.f.call('zana_mission_adopt',{missionId},b);
    assert.match(result.error,/ADOPT_MISSION_BUSY/,JSON.stringify(result));
  }finally{await t.f.cleanup();}
});

test('la sesión de una generación invalidada puede adoptar de nuevo tras vencer la vigente',async()=>{
  const t=await setup();
  try{
    const ready=await t.f.authorReady(),missionId=ready.missionId;
    const a=await t.f.session('zana-chatgpt',ready.author.clientId);
    const b=await t.f.session('zana-chatgpt',ready.author.clientId);
    assert.equal((await t.f.call('zana_mission_adopt',{missionId},a)).adopted,true);
    const old=new Date(Date.now()-24*60*60_000).toISOString();
    await remoteWrite(db=>db.prepare('UPDATE remote_activity SET created_at=? WHERE mission_id=? AND session_id=?').run(old,missionId,a.sessionId));
    assert.equal((await t.f.call('zana_mission_adopt',{missionId},b)).adopted,true);
    const batch=await t.f.call('zana_start_batch',{},a);
    assert.ok(batch.packets?.length,JSON.stringify(batch));
    await remoteWrite(db=>db.prepare('UPDATE remote_activity SET created_at=? WHERE mission_id=? AND session_id=?').run(old,missionId,b.sessionId));
    const result=await t.f.call('zana_mission_adopt',{missionId},a);
    assert.deepEqual(result,{missionId,adopted:true,alreadyAdopted:false});
  }finally{await t.f.cleanup();}
});

test('finalize revierte un encolado parcial sin perder la finalización',async()=>{
  const t=await setup();
  try{
    const ready=await t.f.authorReady(),missionId=ready.missionId;
    const req=await t.f.call('zana_review_request',{missionId},ready.author);
    const reviewer=await t.f.session('zana-chatgpt',ready.author.clientId);
    assert.equal((await t.f.call('zana_review_claim',{ticket:req.ticket},reviewer)).state,'CLAIMED');
    const page=await t.f.call('zana_review_diff',{ticket:req.ticket,page:0},reviewer);
    for(let i=1;i<page.manifest.totalPages;i++)await t.f.call('zana_review_diff',{ticket:req.ticket,page:i},reviewer);
    for(const lens of ['risk','readability','reliability','resilience'])
      assert.equal((await t.f.call('zana_review_lens_submit',{ticket:req.ticket,lens,findings:[],evidence:['Diff completo']},reviewer)).error,undefined);
    const ticketId=await remoteRead(db=>db.prepare('SELECT ticket_id FROM review_tickets WHERE mission_id=?').get(missionId).ticket_id);
    await remoteWrite(db=>{
      const now=Date.now(),expiresAt=new Date(now+86_400_000).toISOString();
      for(let i=0;i<2;i++){
        const id='sub_done_'+i;
        put(db,'zana:evsub:'+id,{schema:'zana.evsub.v1',id,ownerClient:ready.author.clientId,host:'zana-chatgpt',
          name:REVIEW_DONE_EVENT,url:'https://hooks.chatgpt.test.openai.com/cb/'+i,secret:SECRET,expiresAt,verifiedAt:new Date().toISOString()});
      }
      for(let i=0;i<199;i++){
        const id='evt_'+String(i).padStart(32,'0');
        put(db,'zana:evout:'+id,{schema:'zana.evout.v1',id,subId:'missing',ticketId:randomUUID(),name:REVIEW_DONE_EVENT,
          data:{ticketId:randomUUID(),verdict:'APPROVE'},state:'PENDING',attempts:0,nextAt:now,lastStatus:null,terminalAt:null});
      }
    });
    const done=await t.f.call('zana_review_finalize',{ticket:req.ticket,execution:'SEQUENTIAL_SAME_CONVERSATION'},reviewer);
    assert.equal(done.state,'FINALIZED',JSON.stringify(done));
    const queued=await remoteRead(db=>db.prepare("SELECT COUNT(*) count FROM metadata WHERE key LIKE 'zana:evout:%' AND value LIKE ?")
      .get('%'+ticketId+'%').count);
    assert.equal(queued,0,'quedó la primera escritura parcial de events.queue');
  }finally{await t.f.cleanup();}
});


test('finalize publica review.done una vez, con el veredicto y solo al monitor done',async()=>{
  const t=await setup();
  try{
    const ready=await t.f.authorReady();
    const identity={clientId:ready.author.clientId,host:'zana-chatgpt'};
    await t.f.runtime.events.subscribe(identity,{...t.input,name:REVIEW_DONE_EVENT});
    const requested=await t.f.call('zana_review_request',{missionId:ready.missionId},ready.author);
    const reviewer=await t.f.session('zana-chatgpt',ready.author.clientId);
    assert.equal((await t.f.call('zana_review_claim',{ticket:requested.ticket},reviewer)).state,'CLAIMED');
    const page=await t.f.call('zana_review_diff',{ticket:requested.ticket,page:0},reviewer);
    for(let i=1;i<page.manifest.totalPages;i++)await t.f.call('zana_review_diff',{ticket:requested.ticket,page:i},reviewer);
    for(const lens of ['risk','readability','reliability','resilience']){
      const result=await t.f.call('zana_review_lens_submit',{ticket:requested.ticket,lens,findings:[],evidence:['Se revisó el diff completo']},reviewer);
      assert.equal(result.error,undefined,result.error);
    }
    const done=await t.f.call('zana_review_finalize',{ticket:requested.ticket,execution:'SEQUENTIAL_SAME_CONVERSATION'},reviewer);
    assert.equal(done.state,'FINALIZED');
    await t.f.runtime.events.flush();
    const deliveries=t.posts.filter(p=>p.body.name===REVIEW_DONE_EVENT);
    assert.equal(deliveries.length,1);
    assert.match(deliveries[0].body.data.ticketId,/^[0-9a-f-]{36}$/);
    assert.equal(deliveries[0].body.data.verdict,'APPROVE');
    assert.equal((await t.f.call('zana_review_finalize',{ticket:requested.ticket,execution:'SEQUENTIAL_SAME_CONVERSATION'},reviewer)).state,'FINALIZED');
    await t.f.runtime.events.flush();
    assert.equal(t.posts.filter(p=>p.body.name===REVIEW_DONE_EVENT).length,1);
    const resumed=await t.f.session('zana-chatgpt',ready.author.clientId);
    assert.equal((await t.f.call('zana_mission_adopt',{missionId:ready.missionId},resumed)).adopted,true);
    const merged=await t.f.call('zana_merge',{missionId:ready.missionId},resumed);
    assert.ok(!merged.error||!/NOT_AUTHOR/.test(merged.error),JSON.stringify(merged));
  }finally{await t.f.cleanup();}
});


test('REQUEST_CHANGES despierta al orquestador, STALE_SHA no emite done',async()=>{
  for(const stale of [false,true]){
    const t=await setup();
    try{
      const ready=await t.f.authorReady(),identity={clientId:ready.author.clientId,host:'zana-chatgpt'};
      await t.f.runtime.events.subscribe(identity,{...t.input,name:REVIEW_DONE_EVENT});
      const req=await t.f.call('zana_review_request',{missionId:ready.missionId},ready.author);
      const reviewer=await t.f.session('zana-chatgpt',ready.author.clientId);
      assert.equal((await t.f.call('zana_review_claim',{ticket:req.ticket},reviewer)).state,'CLAIMED');
      const page=await t.f.call('zana_review_diff',{ticket:req.ticket,page:0},reviewer);
      for(let i=1;i<page.manifest.totalPages;i++)await t.f.call('zana_review_diff',{ticket:req.ticket,page:i},reviewer);
      for(const lens of ['risk','readability','reliability','resilience']){
        const findings=lens==='risk'?[{severity:'BLOCKER',location:'src/sum.mjs:3',evidence:'Error reproducible',origin:'INTRODUCED',title:'Resultado incorrecto'}]:[];
        const r=await t.f.call('zana_review_lens_submit',{ticket:req.ticket,lens,findings,evidence:['Diff completo']},reviewer);
        assert.equal(r.error,undefined,r.error);
      }
      if(stale)t.f.api.state.push(ready.branch,'b'.repeat(40));
      const done=await t.f.call('zana_review_finalize',{ticket:req.ticket,execution:'SEQUENTIAL_SAME_CONVERSATION'},reviewer);
      assert.equal(done.state,stale?'STALE_SHA':'FINALIZED');
      await t.f.runtime.events.flush();
      const delivered=t.posts.filter(p=>p.body.name===REVIEW_DONE_EVENT);
      assert.equal(delivered.length,stale?0:1);
      if(!stale)assert.equal(delivered[0].body.data.verdict,'REQUEST_CHANGES');
    }finally{await t.f.cleanup();}
  }
});
