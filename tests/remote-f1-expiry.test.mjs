import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {remoteFixture,sleep} from './helpers/remote-fixture.mjs';
import {remoteRead,remoteWrite,readState,transact,backupState,restoreBackup} from '../src/store.mjs';
import {createHttpServer,httpSettings} from '../src/http.mjs';
import {REVIEW_DONE_EVENT} from '../src/mcp-events.mjs';
import {effectiveReviewRounds} from '../src/remote-review.mjs';
import {makePlan} from './helpers/plan-fixture.mjs';
import {loadRun} from '../src/project-run-store.mjs';
const old='2000-01-01T00:00:00.000Z';
const SECRET='whsec_'+Buffer.alloc(32,7).toString('base64');
const rows=()=>remoteRead(db=>db.prepare('SELECT * FROM review_tickets ORDER BY rowid').all());
const state=()=>readState();
const used=async()=>effectiveReviewRounds((await state()).reviewCount,await rows());
const donePosts=()=>{const posts=[];return {posts,options:{runtimeOptions:{eventPost:async(url,headers,body)=>{
  const msg=JSON.parse(body);posts.push({url,msg});
  return {status:200,body:JSON.stringify(msg.type==='verification'?{challenge:msg.challenge}:{})};
}}}};};
async function subscribeDone(f,clientId){
  await f.runtime.events.subscribe({clientId,host:'zana-chatgpt'},
    {name:REVIEW_DONE_EVENT,arguments:{host:'zana-chatgpt'},
      delivery:{mode:'webhook',url:'https://hooks.chatgpt.test.openai.com/f1-monitor',secret:SECRET}});
}
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
    assert.equal((await state()).reviewCount,1);
    assert.equal(await used(),0);
    await f.runtime.events.flush();
    const done=posts.filter(x=>x.msg.name===REVIEW_DONE_EVENT);
    assert.equal(done.length,1);
    assert.match(done[0].url,/f1-author$/);
    assert.deepEqual(done[0].msg.data,{ticketId:id,verdict:'EXPIRED'});
    await f.runtime.review.expire();
    assert.equal((await state()).reviewCount,1);
    assert.equal(await used(),0);
    assert.equal(posts.filter(x=>x.msg.name===REVIEW_DONE_EVENT).length,1);
    await newTicket(f,ready);
    assert.equal((await state()).reviewCount,2);
  }finally{await f.cleanup();}
});
test('F1 CLAIMED sin veredicto: ABANDONED devuelve ronda y avisa, con veredicto no avisa',async()=>{
  const {posts,options}=donePosts(),f=await remoteFixture(options);
  try{
    const ready=await f.authorReady();
    await subscribeDone(f,ready.author.clientId);
    const r=await f.call('zana_review_request',{missionId:ready.missionId},ready.author);
    const id=(await rows())[0].ticket_id;
    const reviewer=await f.session();
    assert.equal((await f.call('zana_review_claim',{ticket:r.ticket},reviewer)).state,'CLAIMED');
    await expireTicket(f,id,'CLAIMED');
    assert.equal((await rows())[0].state,'ABANDONED');
    await f.runtime.events.flush();
    assert.deepEqual(posts.filter(x=>x.msg.name===REVIEW_DONE_EVENT).map(x=>x.msg.data),[{ticketId:id,verdict:'EXPIRED'}]);
    assert.equal((await state()).reviewCount,1);
    assert.equal(await used(),0);
    const id2=await newTicket(f,ready);
    await remoteWrite(db=>db.prepare("UPDATE review_tickets SET state='FINALIZING',verdict='APPROVE',claimed_at=? WHERE ticket_id=?").run(old,id2));
    await f.runtime.review.expire();
    assert.equal((await rows()).at(-1).state,'ABANDONED');
    assert.equal((await state()).reviewCount,2);
    assert.equal(await used(),1);
    await f.runtime.events.flush();
    assert.equal(posts.filter(x=>x.msg.name===REVIEW_DONE_EVENT).length,1);
  }finally{await f.cleanup();}
});
test('F1: máximo cinco tickets terminales descontados sin modificar reviewCount',async()=>{
  const f=await remoteFixture();
  try{
    const ready=await f.authorReady();
    for(let n=1;n<=10;n++){
      const id=await newTicket(f,ready);
      await expireTicket(f,id);
      assert.equal((await state()).reviewCount,n);
      assert.equal(await used(),Math.max(0,n-5));
    }
    await f.runtime.review.expire();
    assert.equal((await state()).reviewCount,10);
    assert.match((await f.call('zana_review_request',{missionId:ready.missionId},ready.author)).error,/REVIEW_ROUNDS_EXHAUSTED/);
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
    assert.equal((await state()).reviewCount,1);
    assert.equal(await used(),0);
  }finally{
    if(http){http.closeAllConnections();await new Promise(resolve=>http.close(resolve));}
    await f.cleanup();
  }
});
test('F2: solicitud perezosa consume ronda efectiva y entrega EXPIRED en webhook',async()=>{
  const {posts,options}=donePosts(),f=await remoteFixture(options);
  try{
    const ready=await f.authorReady();
    await subscribeDone(f,ready.author.clientId);
    const id=await newTicket(f,ready);
    await transact(m=>{m.reviewCount=m.budget.maxReviewRounds;m.revision++;return m;});
    await remoteWrite(db=>db.prepare('UPDATE review_tickets SET expires_at=? WHERE ticket_id=?').run(old,id));
    const next=await f.call('zana_review_request',{missionId:ready.missionId},ready.author);
    assert.equal(next.error,undefined,next.error);
    assert.equal((await state()).reviewCount,6);
    assert.equal(await used(),5);
    assert.deepEqual((await rows()).map(x=>x.state),['EXPIRED','OPEN']);
    await f.runtime.events.flush();
    assert.equal(posts.filter(p=>p.msg.name===REVIEW_DONE_EVENT).length,1);
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
    assert.equal((await state()).reviewCount,2);
    assert.equal(await used(),0);
    const next=await newTicket(f,ready);
    await remoteWrite(db=>db.prepare('UPDATE review_tickets SET expires_at=? WHERE ticket_id=?').run(old,next));
    await newTicket(f,ready); // vencimiento perezoso y nuevo ticket en la misma transaccion
    await f.runtime.review.expire();
    assert.equal((await state()).reviewCount,4);
    assert.equal(await used(),1);
  }finally{await f.cleanup();}
});
test('F2: zana_mission_adopt entrega EXPIRED por expiración perezosa',async()=>{
  const {posts,options}=donePosts(),f=await remoteFixture(options);
  try{
    const ready=await f.authorReady(),id=await newTicket(f,ready);
    await subscribeDone(f,ready.author.clientId);
    await remoteWrite(db=>db.prepare('UPDATE review_tickets SET expires_at=? WHERE ticket_id=?').run(old,id));
    const adopter=await f.session('zana-chatgpt',ready.author.clientId);
    const result=await f.call('zana_mission_adopt',{missionId:ready.missionId},adopter);
    assert.equal(result.error,undefined,result.error);
    assert.equal((await state()).reviewCount,1);
    assert.equal(await used(),0);
    await f.runtime.events.flush();
    assert.equal(posts.filter(p=>p.msg.name===REVIEW_DONE_EVENT).length,1);
  }finally{await f.cleanup();}
});
test('F1/R11: restaurar tickets OPEN/EXPIRED cambia crédito sin alterar el contador bruto',async()=>{
  const f=await remoteFixture();
  const prev=process.env.ZANA_RESTORE_OFFLINE;
  process.env.ZANA_RESTORE_OFFLINE='1';
  try{
    const ready=await f.authorReady(),id=await newTicket(f,ready);
    const before=join(f.dir,'before.sqlite'),after=join(f.dir,'after.sqlite');
    await backupState(before);
    await restoreBackup(before,process.env.ZANA_STATE_FILE,{offline:true});
    assert.equal((await state()).reviewCount,1);
    assert.equal(await used(),1,'backup con ticket OPEN no inventa crédito');
    await expireTicket(f,id);
    await backupState(after);
    await restoreBackup(before,process.env.ZANA_STATE_FILE,{offline:true});
    assert.equal(await used(),0,'el ledger remoto preserva tickets EXPIRED legítimos de la DB viva');
    await restoreBackup(after,process.env.ZANA_STATE_FILE,{offline:true});
    assert.equal((await state()).reviewCount,1);
    assert.equal(await used(),0);
  }finally{
    if(prev===undefined)delete process.env.ZANA_RESTORE_OFFLINE;
    else process.env.ZANA_RESTORE_OFFLINE=prev;
    await f.cleanup();
  }
});
test('F1: función pura excluye veredictos y marcadores de publicación, tope cinco',()=>{
  const terminal={state:'EXPIRED',verdict:null,github_review_id:null,status_posted:0};
  assert.equal(effectiveReviewRounds(6,Array(6).fill(terminal)),1);
  assert.equal(effectiveReviewRounds(4,Array(2).fill({...terminal,state:'ABANDONED'})),2);
  assert.equal(effectiveReviewRounds(5,[terminal,
    {...terminal,verdict:'APPROVE'},{...terminal,github_review_id:44},
    {...terminal,status_posted:1},{...terminal,state:'OPEN'}]),4);
});
test('F1: misión CANCELLED no recibe evento de vencimiento',async()=>{
  const {posts,options}=donePosts(),f=await remoteFixture(options);
  try{
    const ready=await f.authorReady(),id=await newTicket(f,ready);
    await subscribeDone(f,ready.author.clientId);
    await remoteWrite(db=>db.prepare("UPDATE active_mission SET lifecycle='CANCELLED'").run());
    await expireTicket(f,id);
    assert.equal((await rows())[0].state,'EXPIRED');
    assert.equal((await state()).reviewCount,1);
    await f.runtime.events.flush();assert.equal(posts.filter(p=>p.msg.name===REVIEW_DONE_EVENT).length,0);
    assert.equal(await remoteRead(db=>db.prepare("SELECT COUNT(*) n FROM metadata WHERE key LIKE 'zana:expired-refunds:%'").get().n),0);
  }finally{await f.cleanup();}
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
test('F1: veredicto, github_review_id o status_posted no descuentan en SQLite',async()=>{
  for(const flag of ["verdict='APPROVE'","github_review_id=1","status_posted=1"]){
    const f=await remoteFixture();
    try{
      const ready=await f.authorReady(),id=await newTicket(f,ready);
      await remoteWrite(db=>db.prepare("UPDATE review_tickets SET state='EXPIRED',"+flag+" WHERE ticket_id=?").run(id));
      await transact(m=>{m.reviewCount=m.budget.maxReviewRounds;m.revision++;return m;});
      assert.equal(await used(),5,flag);
      assert.match((await f.call('zana_review_request',{missionId:ready.missionId},ready.author)).error,/REVIEW_ROUNDS_EXHAUSTED/);
    }finally{await f.cleanup();}
  }
});
test('F1: fallo al encolar deja código auditable y ticket EXPIRED',async()=>{
  const f=await remoteFixture(),log=console.error,errors=[];
  const queue=f.runtime.events.queue;
  try{
    const ready=await f.authorReady(),id=await newTicket(f,ready);
    f.runtime.events.queue=(db,args)=>{if(args.name===REVIEW_DONE_EVENT)throw Error('QUEUE_TEST');return queue(db,args);};
    console.error=(...args)=>errors.push(args.join(' '));
    await expireTicket(f,id);
    assert.equal((await rows())[0].state,'EXPIRED');
    assert.equal((await state()).reviewCount,1);
    assert.ok(errors.some(x=>x.includes('REVIEW_EXPIRED_EVENT_QUEUE_FAILED')));
  }finally{console.error=log;f.runtime.events.queue=queue;await f.cleanup();}
});
test('F1: cancelar hito usa rondas efectivas y distingue sin vencimiento',async()=>{
  for(const expired of [false,true]){
    const f=await remoteFixture();
    try{
      const owner=await f.session();
      let w=await f.call('zana_workspace_create',{idea:'Crear un sistema de hitos extensible'},owner);
      w=await f.call('zana_workspace_update',{workspaceId:w.workspaceId,expectedVersion:0,
        answers:{goal:'Hitos',users:'Equipos',platform:'Web',features:'Planes',data:'Sin secretos'}},owner);
      w=await f.call('zana_workspace_update',{workspaceId:w.workspaceId,expectedVersion:1,plan:makePlan(w.brief)},owner);
      const a=await f.call('zana_plan_approval_request',{workspaceId:w.workspaceId,expectedVersion:w.version},owner);
      f.runtime.planApproval.decide({approvalId:a.approvalId,decision:'allow',passwordOk:true});
      const started=await f.call('zana_project_run_start',{workspaceId:w.workspaceId,repo:'o/r',base:'main'},owner);
      assert.equal(started.created,true,started.error);
      const m=await f.call('zana_mission_init',{spec:f.spec,github:{repo:'o/r',base:'main'},
        milestone:{id:'core',final:false}},owner);
      assert.equal(m.error,undefined,m.error);
      const pkt=(await f.call('zana_start_batch',{},owner)).packets[0];
      f.api.state.push(m.github.branch,'a'.repeat(40));f.api.state.green('a'.repeat(40));
      f.api.state.openPull(m.github.branch);
      assert.equal((await f.call('zana_complete_unit',{unitId:pkt.unitId,token:pkt.token,
        leaseGeneration:pkt.leaseGeneration,outcome:{success:true,summary:'listo',evidence:['CI']}},owner)).error,undefined);
      const ticket=await f.call('zana_review_request',{missionId:m.id},owner);
      assert.equal(ticket.error,undefined,ticket.error);
      await transact(s=>{s.reviewCount=s.budget.maxReviewRounds;s.revision++;return s;});
      if(expired)await expireTicket(f,(await rows()).at(-1).ticket_id);
      const result=await f.call('zana_mission_cancel',{},owner);
      assert.equal(result.run.released,true,result.error);
      const reason=await remoteRead(db=>loadRun(db,started.projectId).milestones[0].attempts.at(-1).reason);
      assert.equal(reason.includes('REVIEW_ROUNDS_EXHAUSTED'),!expired,reason);
    }finally{await f.cleanup();}
  }
});


test('F2: llamada perezosa encola EXPIRED una sola vez solo para el OAuth autor',async()=>{
  const posts=[];
  const f=await remoteFixture({runtimeOptions:{eventPost:async(url,headers,body)=>{
    const msg=JSON.parse(body);posts.push({url,msg});
    return {status:200,body:JSON.stringify(msg.type==='verification'?{challenge:msg.challenge}:{})};
  }}});
  try{
    const ready=await f.authorReady();
    for(const [clientId,url] of [[ready.author.clientId,'author'],['zc_reviewer','reviewer'],['zc_other','other']]){
      await f.runtime.events.subscribe({clientId,host:'zana-chatgpt'},
        {name:REVIEW_DONE_EVENT,arguments:{host:'zana-chatgpt'},
          delivery:{mode:'webhook',url:'https://hooks.chatgpt.test.openai.com/'+url,secret:SECRET}});
    }
    const ticket=await f.call('zana_review_request',{missionId:ready.missionId},ready.author);
    const id=(await rows()).at(-1).ticket_id;
    await remoteWrite(db=>db.prepare('UPDATE review_tickets SET expires_at=? WHERE ticket_id=?').run(old,id));
    const reviewer=await f.session('zana-chatgpt','zc_reviewer');
    assert.match((await f.call('zana_review_claim',{ticket:ticket.ticket},reviewer)).error,/TICKET_EXPIRED/);
    await f.runtime.events.flush();
    const notifications=posts.filter(p=>p.msg.name===REVIEW_DONE_EVENT);
    assert.deepEqual(notifications.map(p=>p.url),['https://hooks.chatgpt.test.openai.com/author']);
    assert.deepEqual(notifications[0].msg.data,{ticketId:id,verdict:'EXPIRED'});
    await f.runtime.review.expire();
    await f.runtime.events.flush();
    assert.equal(posts.filter(p=>p.msg.name===REVIEW_DONE_EVENT).length,1);
  }finally{await f.cleanup();}
});
test('F2: expiración perezosa omite tickets publicados o misión inactiva',async()=>{
  for(const flag of ["verdict='APPROVE'","github_review_id=42","status_posted=1","lifecycle"]){
    const {posts,options}=donePosts(),f=await remoteFixture(options);
    try{
      const ready=await f.authorReady();
      await subscribeDone(f,ready.author.clientId);
      const req=await f.call('zana_review_request',{missionId:ready.missionId},ready.author);
      const id=(await rows()).at(-1).ticket_id;
      await remoteWrite(db=>{
        db.prepare('UPDATE review_tickets SET expires_at=? WHERE ticket_id=?').run(old,id);
        if(flag==='lifecycle')db.prepare("UPDATE active_mission SET lifecycle='CANCELLED' WHERE slot=1").run();
        else db.prepare('UPDATE review_tickets SET '+flag+' WHERE ticket_id=?').run(id);
      });
      assert.match((await f.call('zana_review_claim',{ticket:req.ticket},await f.session())).error,/TICKET_EXPIRED/,flag);
      await f.runtime.events.flush();
      assert.equal(posts.filter(p=>p.msg.name===REVIEW_DONE_EVENT).length,0,flag);
    }finally{await f.cleanup();}
  }
});


test('F2: roundsUsedIn descuenta solo tickets de la misión consultada',async()=>{
  const f=await remoteFixture();
  try{
    const ready=await f.authorReady();
    await newTicket(f,ready);
    await newTicket(f,ready);
    const tickets=await rows();
    assert.equal(tickets.length,2);
    await remoteWrite(db=>{
      db.prepare("UPDATE review_tickets SET mission_id=?,state='EXPIRED' WHERE ticket_id=?")
        .run('00000000-0000-4000-8000-000000000099',tickets[0].ticket_id);
      db.prepare("UPDATE review_tickets SET state='EXPIRED' WHERE ticket_id=?").run(tickets[1].ticket_id);
    });
    const mission=await state();
    assert.equal(mission.reviewCount,2);
    assert.equal(await remoteRead(db=>f.runtime.review.roundsUsedIn(db,mission)),1);
  }finally{await f.cleanup();}
});

test('F2: un evento perezoso sale por microtask sin flush manual ni temporizador de barrido',async()=>{
  const {posts,options}=donePosts(),f=await remoteFixture(options);
  try{
    const ready=await f.authorReady(),id=await newTicket(f,ready);
    await subscribeDone(f,ready.author.clientId);
    await remoteWrite(db=>db.prepare('UPDATE review_tickets SET expires_at=? WHERE ticket_id=?').run(old,id));
    const next=await f.call('zana_review_request',{missionId:ready.missionId},ready.author);
    assert.equal(next.error,undefined,next.error);
    for(let n=0;n<20&&!posts.some(p=>p.msg.name===REVIEW_DONE_EVENT);n++)await sleep(20);
    assert.deepEqual(posts.filter(p=>p.msg.name===REVIEW_DONE_EVENT).map(p=>p.msg.data),
      [{ticketId:id,verdict:'EXPIRED'}]);
  }finally{await f.cleanup();}
});

test('F1: SAVEPOINT revierte fila parcial del outbox aunque la cola relance error',async()=>{
  const {posts,options}=donePosts(),f=await remoteFixture(options),original=f.runtime.events.queue;
  try{
    const ready=await f.authorReady(),id=await newTicket(f,ready);
    await subscribeDone(f,ready.author.clientId);
    await remoteWrite(db=>db.prepare('UPDATE review_tickets SET expires_at=? WHERE ticket_id=?').run(old,id));
    f.runtime.events.queue=(db,args)=>{
      const queued=original(db,args);
      if(args.name===REVIEW_DONE_EVENT){assert.equal(queued,1);throw Error('QUEUE_AFTER_WRITE');}
      return queued;
    };
    const result=await f.runtime.review.expire();
    assert.equal(result.expired,1);
    assert.equal((await rows())[0].state,'EXPIRED');
    f.runtime.events.queue=original;
    await f.runtime.events.flush();
    assert.equal(await remoteRead(db=>db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key LIKE 'zana:evout:%'").get().n),0);
    assert.equal(posts.filter(p=>p.msg.name===REVIEW_DONE_EVENT).length,0);
  }finally{f.runtime.events.queue=original;await f.cleanup();}
});

test('F2: zana_review_request vence CLAIMED perezoso y avisa EXPIRED una vez',async()=>{
  const {posts,options}=donePosts(),f=await remoteFixture(options);
  try{
    const ready=await f.authorReady();
    await subscribeDone(f,ready.author.clientId);
    const ticket=await f.call('zana_review_request',{missionId:ready.missionId},ready.author);
    assert.equal(ticket.error,undefined,ticket.error);
    const id=(await rows())[0].ticket_id;
    assert.equal((await f.call('zana_review_claim',{ticket:ticket.ticket},await f.session())).state,'CLAIMED');
    await remoteWrite(db=>db.prepare('UPDATE review_tickets SET claimed_at=? WHERE ticket_id=?').run(old,id));
    const next=await f.call('zana_review_request',{missionId:ready.missionId},ready.author);
    assert.equal(next.error,undefined,next.error);
    assert.deepEqual((await rows()).map(t=>t.state),['ABANDONED','OPEN']);
    await f.runtime.events.flush();
    assert.deepEqual(posts.filter(p=>p.msg.name===REVIEW_DONE_EVENT).map(p=>p.msg.data),
      [{ticketId:id,verdict:'EXPIRED'}]);
    await f.runtime.review.expire();
    await f.runtime.events.flush();
    assert.equal(posts.filter(p=>p.msg.name===REVIEW_DONE_EVENT).length,1);
  }finally{await f.cleanup();}
});

test('F1: ausencia de transacción relanza error original antes de ROLLBACK TO savepoint',async()=>{
  const f=await remoteFixture(),original=f.runtime.events.queue;
  try{
    const ready=await f.authorReady(),id=await newTicket(f,ready);
    await remoteWrite(db=>db.prepare('UPDATE review_tickets SET expires_at=? WHERE ticket_id=?').run(old,id));
    f.runtime.events.queue=(db,args)=>{
      if(args.name!==REVIEW_DONE_EVENT)return original(db,args);
      db.exec('ROLLBACK');throw Error('QUEUE_TX_ABORTED');
    };
    await assert.rejects(f.runtime.review.expire(),/QUEUE_TX_ABORTED/);
  }finally{f.runtime.events.queue=original;await f.cleanup();}
});

test('F1: zana_correction_start usa rondas efectivas y acredita EXPIRED sin veredicto',async()=>{
  const f=await remoteFixture();
  try{
    const ready=await f.authorReady();
    const expiredId=await newTicket(f,ready);
    await expireTicket(f,expiredId);
    const reviewed=await newTicket(f,ready);
    await remoteWrite(db=>db.prepare("UPDATE review_tickets SET state='FINALIZED',verdict='REQUEST_CHANGES',status_posted=1 WHERE ticket_id=?").run(reviewed));
    await transact(m=>{m.reviewCount=m.budget.maxReviewRounds;m.revision++;return m;});
    assert.equal(await used(),4);
    const correction=await f.call('zana_correction_start',{missionId:ready.missionId},ready.author);
    assert.equal(correction.error,undefined,correction.error);
    assert.match(correction.unitId,/^fix-/);
  }finally{await f.cleanup();}
});
