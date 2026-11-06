// Etapa B, ronda 2 (R3-C1): cada test mata una mutación de un guard nuevo.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {request as httpRequest} from 'node:http';
import {createServer} from 'node:net';
import {remoteFixture,readDiff,sha} from './helpers/remote-fixture.mjs';
import {remoteWrite,remoteRead,transact} from '../src/store.mjs';
import {createRemoteRuntime} from '../src/remote.mjs';
import {deliveryStatus} from '../src/github-delivery.mjs';
import {createDeadline} from '../src/deadline.mjs';
import {GitHubApi,breakerFor} from '../src/github-api.mjs';
import {DownstreamGateway} from '../src/downstream.mjs';
import {EmbeddedOAuth} from '../src/oauth.mjs';
import {createHttpServer,httpSettings} from '../src/http.mjs';
import {runCli,loadServerEnv} from '../src/cli.mjs';
import {pruneRemote,MAX_READ_AUDIT,audit as writeAuditRow} from '../src/remote-state.mjs';

const clean=lens=>({lens,findings:[],evidence:['read every page']});
const blocker={lens:'risk',findings:[{severity:'BLOCKER',location:'src/sum.mjs:3',evidence:'returns a-b'}],evidence:['diff']};
const outcome=x=>({success:true,summary:'done on '+x,evidence:['head '+x]});
const q=(sql,...a)=>remoteRead(db=>db.prepare(sql).all(...a));
async function claimAndRead(f,ticket,s){
  assert.equal((await f.call('zana_review_claim',{ticket},s)).state,'CLAIMED');
  await readDiff(f.call,ticket,s);
}
async function review(f,ticket,s,risk=clean('risk')){
  await claimAndRead(f,ticket,s);
  for(const l of [risk,clean('readability'),clean('reliability'),clean('resilience')])
    assert.equal((await f.call('zana_review_lens_submit',{ticket,...l},s)).error,undefined);
  return f.call('zana_review_finalize',{ticket,execution:'PARALLEL_SUBAGENTS'},s);
}
async function completedAndRejected(f){
  const r=await f.authorReady({complete:false});
  await f.call('zana_complete_unit',{unitId:'code',token:r.packet.token,leaseGeneration:r.packet.leaseGeneration,outcome:outcome(sha('a'))},r.author);
  const t=await f.call('zana_review_request',{missionId:r.missionId},r.author);
  assert.equal((await review(f,t.ticket,await f.session(),blocker)).event,'REQUEST_CHANGES');
  return {...r,ticket:t.ticket};
}

test('W3: unit completed before the ticket; REQUEST_CHANGES -> correction -> APPROVE -> merge -> close -> archive',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId,branch,packet}=await f.authorReady({complete:false});
    // Checks green on the PR head, then complete, then request: no RUNNING unit needed for the ticket.
    const done=await f.call('zana_complete_unit',{unitId:'code',token:packet.token,leaseGeneration:packet.leaseGeneration,outcome:outcome(sha('a'))},author);
    assert.equal(done.error,undefined,done.error);
    assert.equal((await f.call('zana_mission_status',{},author)).units.find(u=>u.id==='code').status,'DONE');
    const t1=await f.call('zana_review_request',{missionId},author);
    assert.equal(t1.error,undefined,t1.error);
    assert.equal((await review(f,t1.ticket,await f.session(),blocker)).event,'REQUEST_CHANGES');
    const corr=await f.call('zana_correction_start',{missionId},author);
    let cp;
    for(let i=0;i<3&&!cp;i++){
      const b=await f.call('zana_start_batch',{leaseSeconds:300},author);
      cp=b.packets.find(p=>p.unitId===corr.unitId);
      for(const o of b.packets.filter(p=>p.unitId!==corr.unitId))
        await f.call('zana_complete_unit',{unitId:o.unitId,token:o.token,leaseGeneration:o.leaseGeneration,outcome:outcome('n')},author);
    }
    await f.call('zana_ds_github',{operation:'create_or_update_file',missionId,
      arguments:{owner:'o',repo:'r',branch,path:'src/sum.mjs',content:'a+b',message:'fix'}},author);
    f.api.state.push(branch,sha('b'));f.api.state.green(sha('b'));
    assert.equal((await f.call('zana_complete_unit',{unitId:corr.unitId,token:cp.token,leaseGeneration:cp.leaseGeneration,outcome:outcome(sha('b'))},author)).error,undefined);
    const t2=await f.call('zana_review_request',{missionId},author);
    assert.equal((await review(f,t2.ticket,await f.session())).event,'APPROVE');
    assert.equal((await f.call('zana_merge',{missionId},author)).state,'MERGED');
    const closed=await f.call('zana_mission_close',{},author);
    assert.equal(closed.status,'CLOSED',JSON.stringify(closed));
    assert.equal((await f.call('zana_mission_archive',{},author)).archived,true);
  }finally{await f.cleanup();}
});

test('M1: rebind refuses a wrong token, an expired lease, and records UNIT_REBIND',async()=>{
  const f=await remoteFixture();
  try{
    const {missionId,packet}=await f.authorReady({complete:false});
    const s=await f.session();
    const args={missionId,unitId:'code',token:packet.token,leaseGeneration:packet.leaseGeneration};
    assert.match((await f.call('zana_session_rebind',{...args,token:'00000000-0000-4000-8000-000000000000'},s)).error,/Invalid or stale run token/);
    assert.match((await f.call('zana_session_rebind',{...args,unitId:'notes'},s)).error,/Invalid or stale run token/);
    await transact(m=>{m.units.find(u=>u.id==='code').run.expiresAt=new Date(Date.now()-1).toISOString();m.revision++;return m;});
    assert.match((await f.call('zana_session_rebind',args,s)).error,/Lease expired/);
    await transact(m=>{m.units.find(u=>u.id==='code').run.expiresAt=new Date(Date.now()+60_000).toISOString();m.revision++;return m;});
    assert.equal((await f.call('zana_session_rebind',args,s)).rebound,true);
    assert.equal((await q("SELECT COUNT(*) n FROM remote_activity WHERE session_id=? AND kind='UNIT_REBIND'",s.sessionId))[0].n,1);
    assert.match((await f.call('zana_session_rebind',{...args,missionId:'00000000-0000-0000-0000-000000000000'},s)).error,/MISSION_NOT_ACTIVE/);
  }finally{await f.cleanup();}
});

test('M2: correction_start guards',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId,ticket}=await completedAndRejected(f);
    const reviewer=(await q('SELECT reviewer_session s FROM review_tickets'))[0].s;
    assert.match((await f.call('zana_correction_start',{missionId},{sessionId:reviewer,host:'zana-chatgpt',clientId:'zc_test'})).error,/REVIEWER_READ_ONLY/);
    // Rounds exhausted.
    await transact(m=>{m.reviewCount=m.budget.maxReviewRounds;m.revision++;return m;});
    assert.match((await f.call('zana_correction_start',{missionId},author)).error,/REVIEW_ROUNDS_EXHAUSTED/);
    await transact(m=>{m.reviewCount=1;m.revision++;return m;});
    // No code units.
    await remoteWrite(db=>db.prepare("UPDATE remote_missions SET code_units='[]'").run());
    assert.match((await f.call('zana_correction_start',{missionId},author)).error,/NO_CODE_UNITS/);
    await remoteWrite(db=>db.prepare("UPDATE remote_missions SET code_units='[\"code\"]'").run());
    assert.ok((await f.call('zana_correction_start',{missionId},author)).unitId);
    assert.match((await f.call('zana_correction_start',{missionId},author)).error,/CORRECTION_EXISTS/);
    // Latest ticket not FINALIZED, then APPROVE.
    await remoteWrite(db=>db.prepare("UPDATE review_tickets SET state='CLAIMED'").run());
    assert.match((await f.call('zana_correction_start',{missionId},author)).error,/NO_CHANGES_REQUESTED/);
    await remoteWrite(db=>db.prepare("UPDATE review_tickets SET state='FINALIZED',verdict='APPROVE'").run());
    assert.match((await f.call('zana_correction_start',{missionId},author)).error,/NO_CHANGES_REQUESTED/);
    void ticket;
  }finally{await f.cleanup();}
  // Work-start budget: one unit, one start.
  const g=await remoteFixture();
  try{
    const a=await g.session();
    const init=await g.call('zana_mission_init',{spec:{objective:'tight budget',budget:{maxWorkStarts:1},
      units:[{id:'code',effect:'READ',code:true,instruction:'x'}]},github:{repo:'o/r',base:'main'}},a);
    const b=await g.call('zana_start_batch',{},a);
    g.api.state.push(init.github.branch,sha('a'));g.api.state.green(sha('a'));g.api.state.openPull(init.github.branch);
    await g.call('zana_complete_unit',{unitId:'code',token:b.packets[0].token,leaseGeneration:b.packets[0].leaseGeneration,outcome:outcome('a')},a);
    const t=await g.call('zana_review_request',{missionId:init.id},a);
    await review(g,t.ticket,await g.session(),blocker);
    assert.match((await g.call('zana_correction_start',{missionId:init.id},a)).error,/work-start budget exhausted/);
  }finally{await g.cleanup();}
});

test('M3/M4/M11: same-SHA live BLOCKER, claim TTL -> ABANDONED, openBlocking, supersede states and request rounds',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId,branch}=await f.authorReady();
    const t1=await f.call('zana_review_request',{missionId},author);
    const s1=await f.session();
    await f.call('zana_review_claim',{ticket:t1.ticket},s1);
    assert.deepEqual(await f.runtime.review.openBlocking(missionId),[]);
    await f.call('zana_review_lens_submit',{ticket:t1.ticket,...blocker},s1);
    assert.equal((await f.runtime.review.openBlocking(missionId)).length,1);
    assert.match((await f.call('zana_review_request',{missionId},author)).error,/CHANGES_REQUESTED_SAME_SHA/);
    await remoteWrite(db=>db.prepare("UPDATE review_tickets SET claimed_at='2000-01-01T00:00:00.000Z'").run());
    assert.deepEqual(await f.runtime.review.openBlocking(missionId),[],'abandoned tickets do not block the merge');
    assert.equal((await q('SELECT state FROM review_tickets'))[0].state,'ABANDONED');
    // New SHA: the next ticket supersedes; an open same-SHA ticket becomes ABANDONED, another SHA STALE_SHA.
    f.api.state.push(branch,sha('b'));f.api.state.green(sha('b'));
    const t2=await f.call('zana_review_request',{missionId},author);
    const t3=await f.call('zana_review_request',{missionId},author);
    f.api.state.push(branch,sha('c'));f.api.state.green(sha('c'));
    const t4=await f.call('zana_review_request',{missionId},author);
    const states=Object.fromEntries((await q('SELECT ticket_id,state FROM review_tickets ORDER BY created_at')).map((r,i)=>[i,r.state]));
    assert.deepEqual(states,{0:'ABANDONED',1:'ABANDONED',2:'STALE_SHA',3:'OPEN'});
    assert.deepEqual(t4.superseded.length,1);
    void t2;void t3;
    await transact(m=>{m.reviewCount=m.budget.maxReviewRounds;m.revision++;return m;});
    f.api.state.push(branch,sha('d'));f.api.state.green(sha('d'));
    assert.match((await f.call('zana_review_request',{missionId},author)).error,/REVIEW_ROUNDS_EXHAUSTED/);
  }finally{await f.cleanup();}
});

test('M5: retention keeps writes, merges, active missions and live tickets; the prune runs from audit writes',async()=>{
  const f=await remoteFixture();
  try{
    const {missionId}=await f.authorReady();
    const old='2020-01-01T00:00:00.000Z';
    await remoteWrite(db=>{
      const ins=db.prepare('INSERT INTO remote_audit(at,tool,outcome,category) VALUES(?,?,?,?)');
      ins.run(new Date().toISOString(),'early-write','OK','write');
      ins.run(new Date().toISOString(),'early-merge','MERGED','merge');
      for(let i=0;i<MAX_READ_AUDIT+3;i++)ins.run(new Date().toISOString(),'r'+i,'OK','read');
      db.prepare("INSERT INTO remote_activity(session_id,mission_id,kind,tool,created_at) VALUES('s',?,'X','t',?)").run(missionId,old);
      db.prepare("INSERT INTO review_tickets(ticket_id,code_hash,mission_id,repo,pr_number,sha,author_session,created_at,expires_at,state,updated_at) VALUES('live','h',?,'o/r',1,'x','s',?,?,'CLAIMED',?)").run(missionId,old,old,old);
      db.prepare("INSERT INTO review_receipts(review_id,lens_id,token,result,created_at) VALUES('gone','risk','h','{}','x')").run();
      db.prepare("INSERT INTO review_tickets(ticket_id,code_hash,mission_id,repo,pr_number,sha,author_session,created_at,expires_at,state,updated_at) VALUES('gone','h2','m','o/r',1,'x','s',?,?,'ABANDONED',?)").run(old,old,old);
      db.prepare("INSERT INTO remote_checks(check_id,mission_id,sha,workflow,dispatched,session_id,created_at) VALUES('oldcheck','m','x','w',0,'s',?)").run(old);
      pruneRemote(db);
    });
    const counts=(await q("SELECT (SELECT COUNT(*) FROM remote_audit WHERE tool IN ('early-write','early-merge')) kept,(SELECT COUNT(*) FROM remote_audit WHERE category='read') reads,(SELECT COUNT(*) FROM remote_activity WHERE mission_id=? AND created_at='2020-01-01T00:00:00.000Z') active,(SELECT COUNT(*) FROM review_tickets WHERE ticket_id='live') live,(SELECT COUNT(*) FROM review_receipts WHERE review_id='gone') orphan",missionId))[0];
    assert.deepEqual({...counts},{kept:2,reads:MAX_READ_AUDIT,active:1,live:1,orphan:0});
    // The prune runs on its own every 100 audit rows.
    await remoteWrite(db=>db.prepare("INSERT INTO remote_checks(check_id,mission_id,sha,workflow,dispatched,session_id,created_at) VALUES('oldcheck2','m','x','w',0,'s',?)").run(old));
    for(let i=0;i<100;i++)await writeAuditRow({caller:null,tool:'tick',outcome:'OK',category:'read'});
    assert.equal((await q("SELECT COUNT(*) n FROM remote_checks WHERE check_id='oldcheck2'"))[0].n,0);
  }finally{await f.cleanup();}
});

test('M6: deliveryStatus with no time left is never green',async()=>{
  const ctx={missionId:'m',repo:'o/r',branch:'zana/m',base:'main'};
  const gh={openPullsFor:async()=>[{number:1,head:{ref:'zana/m'},base:{ref:'main'}}],
    pull:async()=>({number:1,state:'open',mergeable:true,head:{sha:'h'}}),
    checkRuns:async()=>[{name:'t',status:'completed',conclusion:'success',head_sha:'h'}],
    statuses:async()=>[{context:'zana/4r',state:'success',creator:{login:'rev'}}],
    pullCommits:async()=>[],pullReviews:async()=>[{user:{login:'rev'},state:'APPROVED',commit_id:'h',id:1}]};
  const r=await deliveryStatus({github:gh,config:{reviewerLogin:'rev',requiredChecks:[]},ctx,deadline:createDeadline(0)});
  assert.deepEqual({ci:r.ci.state,fourR:r.fourR,review:r.review.state,ready:r.ready},{ci:'UNKNOWN',fourR:'UNKNOWN',review:'UNAVAILABLE',ready:false});
  assert.deepEqual(r.partial,['ci','zana/4r','review']);
  const currentTicket={ticket_id:'t',state:'FINALIZED',verdict:'APPROVE',sha:'h',github_review_id:1};
  assert.equal((await deliveryStatus({github:gh,config:{reviewerLogin:'rev',requiredChecks:[]},ctx,currentTicket})).ready,true);
});

const raw=(base,path,headers={})=>new Promise((ok,fail)=>{
  const u=new URL(base);
  const r=httpRequest({host:u.hostname,port:u.port,path,method:'GET',headers},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>ok({status:res.statusCode,body:JSON.parse(b)}));});
  r.on('error',fail);r.end();
});
test('M7/M15/W7: /health 503 when degraded, stale ticket count, public body without detail',async()=>{
  const f=await remoteFixture({envExtra:{ZANA_REVIEWER_TOKEN:''}});
  try{
    const settings={...httpSettings({ZANA_PUBLIC_HOST:'zanallaima.test',ZANA_OAUTH_DB:join(f.dir,'o.sqlite')}),password:'p'.repeat(40)};
    const oauth=new EmbeddedOAuth({path:settings.oauthDb,resource:'https://zanallaima.test/mcp',redirectUris:['https://chatgpt.com/cb'],password:'p'.repeat(40)});
    const http=createHttpServer({runtime:f.runtime,oauth,settings,log:{error(){}}});
    await new Promise(ok=>http.listen(0,'127.0.0.1',ok));
    const base='http://127.0.0.1:'+http.address().port;
    try{
      await remoteWrite(db=>db.prepare("INSERT INTO review_tickets(ticket_id,code_hash,mission_id,repo,pr_number,sha,author_session,created_at,expires_at,state,claimed_at,updated_at) VALUES('t','h','m','o/r',1,'x','s',?,?,'CLAIMED',?,?)")
        .run(new Date().toISOString(),new Date(Date.now()+1e6).toISOString(),'2000-01-01T00:00:00.000Z',new Date().toISOString()));
      const local=await raw(base,'/health');
      assert.equal(local.status,503);
      assert.equal(local.body.status,'degraded');
      assert.equal(local.body.staleTickets,1);
      assert.ok(local.body.problems.some(p=>/ZANA_REVIEWER_TOKEN/.test(p)));
      const pub=await raw(base,'/health',{host:'zanallaima.test','cf-connecting-ip':'203.0.113.5'});
      assert.equal(pub.status,503);
      assert.deepEqual(Object.keys(pub.body).sort(),['sessions','staleTickets','status','version']);
    }finally{http.closeAllConnections();await new Promise(ok=>http.close(ok));oauth.close();}
  }finally{await f.cleanup();}
});

test('M8: CLI env from ZANA_ENV_FILE and from the default file (fills only unset, warns on mismatch)',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zana-env-'));
  try{
    const file=join(dir,'a.env');
    await writeFile(file,'ZANA_STATE_FILE=/srv/a/state.json\nZANA_OAUTH_DB=/srv/a/oauth.sqlite\n');
    const env={ZANA_ENV_FILE:file,ZANA_STATE_FILE:'/shell/state.json'};
    assert.equal(loadServerEnv([],env),file);
    assert.equal(env.ZANA_STATE_FILE,'/srv/a/state.json','an explicit file wins');
    const home=join(dir,'home');
    await mkdir(join(home,'.config','zanallaima'),{recursive:true});
    await writeFile(join(home,'.config','zanallaima','zanallaima.env'),'ZANA_STATE_FILE=/srv/b/state.json\nZANA_OAUTH_DB=/srv/b/oauth.sqlite\n');
    const env2={HOME:home,ZANA_STATE_FILE:'/shell/state.json'};
    const warnings=[];
    const write=process.stderr.write;
    process.stderr.write=m=>{warnings.push(String(m));return true;};
    try{assert.ok(loadServerEnv([],env2).endsWith('zanallaima.env'));}finally{process.stderr.write=write;}
    assert.equal(env2.ZANA_STATE_FILE,'/shell/state.json','the default file only fills unset variables');
    assert.equal(env2.ZANA_OAUTH_DB,'/srv/b/oauth.sqlite');
    assert.ok(warnings.some(w=>/ZANA_STATE_FILE from the shell/.test(w)));
    assert.equal(loadServerEnv([],{HOME:join(dir,'none')}),null);
    assert.throws(()=>loadServerEnv(['--env-file'],{}),/requires a path/);
    await writeFile(join(dir,'bad.env'),'not a line\n');
    assert.throws(()=>loadServerEnv(['--env-file',join(dir,'bad.env')],{}),/Invalid line/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('M9: operator remote-ticket-abandon succeeds once, is audited, and never touches a finalized review',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId}=await f.authorReady();
    await f.call('zana_review_request',{missionId},author);
    const id=(await runCli('remote-tickets',[missionId])).tickets[0].ticketId;
    const r=await runCli('remote-ticket-abandon',[id]);
    assert.deepEqual({...r},{ticketId:id,previousState:'OPEN',state:'ABANDONED',released:true});
    await assert.rejects(runCli('remote-ticket-abandon',[id]),/TICKET_TERMINAL/);
    const rows=await f.runtime.readAudit({missionId,limit:50});
    assert.ok(rows.some(a=>a.tool==='remote-ticket-abandon'&&a.outcome==='ABANDONED'&&a.category==='operator'));
    await remoteWrite(db=>db.prepare("UPDATE review_tickets SET state='FINALIZED',operator_released=0").run());
    await assert.rejects(runCli('remote-ticket-abandon',[id]),/finalized review/);
  }finally{await f.cleanup();}
});

test('M10: diff guards — DIFF_CHANGED, TICKET_NOT_CLAIMED, missing manifest is an explicit error',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId}=await f.authorReady();
    const t=await f.call('zana_review_request',{missionId},author);
    const s=await f.session();
    assert.match((await f.call('zana_review_diff',{ticket:t.ticket,page:0},s)).error,/TICKET_NOT_CLAIMED/);
    // Claim while the diff cannot be read: no manifest recorded.
    f.api.state.failNext={status:500,message:'boom'};
    const c=await f.call('zana_review_claim',{ticket:t.ticket},s);
    assert.match(c.diffManifestError,/HTTP 500/);
    for(const l of ['risk','readability','reliability','resilience'])await f.call('zana_review_lens_submit',{ticket:t.ticket,...clean(l)},s);
    assert.match((await f.call('zana_review_finalize',{ticket:t.ticket,execution:'PARALLEL_SUBAGENTS'},s)).error,/DIFF_NOT_FULLY_READ: no diff manifest/);
    await readDiff(f.call,t.ticket,s);
    // After a restart (cache gone) the diff of the SHA changed: refused.
    f.api.state.diffText='diff --git a/y b/y\n+changed\n';
    const restarted=createRemoteRuntime({env:f.env});
    const r=await restarted.dispatch('zana_review_diff',{ticket:t.ticket,page:0},s);
    assert.match(r.content[0].text,/DIFF_CHANGED/);
    await restarted.close();
  }finally{await f.cleanup();}
});

test('M12: only our own review of this commit with this ticket marker is adopted',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId}=await f.authorReady();
    const t=await f.call('zana_review_request',{missionId},author);
    const ticketId=(await q('SELECT ticket_id FROM review_tickets'))[0].ticket_id;
    f.api.state.reviews[7]=[
      {id:1,user:{login:'sebastianriquelme95-max'},commit_id:sha('a'),body:'<!-- zana-ticket:other -->',state:'APPROVED'},
      {id:2,user:{login:'sebastianriquelme95-max'},commit_id:sha('0'),body:'<!-- zana-ticket:'+ticketId+' -->',state:'APPROVED'},
      {id:3,user:{login:'someone-else'},commit_id:sha('a'),body:'<!-- zana-ticket:'+ticketId+' -->',state:'APPROVED'},
    ];
    const r=await review(f,t.ticket,await f.session());
    assert.equal(r.adoptedExistingReview,false);
    assert.equal(f.api.state.reviews[7].length,4);
  }finally{await f.cleanup();}
});

test('M13: merge recovers MERGED when GitHub says not merged but the PR is; ERROR attempts are audited',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId}=await f.authorReady();
    const t=await f.call('zana_review_request',{missionId},author);
    await review(f,t.ticket,await f.session());
    const gh=f.runtime.github;
    const realMerge=gh.merge.bind(gh);
    gh.merge=async()=>{throw Object.assign(new Error('Forbidden'),{status:403});};
    assert.match((await f.call('zana_merge',{missionId},author)).error,/Forbidden/);
    let rows=await f.runtime.readAudit({missionId,limit:100});
    assert.ok(rows.some(a=>a.tool==='zana_merge.result'&&a.outcome==='ERROR'&&a.category==='merge'));
    gh.merge=async(...a)=>{await realMerge(...a);return {merged:false,message:'answer lost'};};
    const m=await f.call('zana_merge',{missionId},author);
    assert.deepEqual({state:m.state,recovered:m.recovered},{state:'MERGED',recovered:true});
  }finally{await f.cleanup();}
});

test('M14: the REST breaker counts 429, rate-limit 403 and network errors, not other 4xx',async()=>{
  const mk=(origin,responses)=>new GitHubApi({baseUrl:origin,token:'t'.repeat(20),fetcher:async()=>{const r=responses.shift();if(r instanceof Error)throw r;return r;}});
  const origin='https://breaker-m14.example';
  const res=(status,body='{}',headers={})=>new Response(body,{status,headers});
  const api=mk(origin,[res(429),res(403,'{"message":"You have exceeded a secondary rate limit"}'),new Error('ECONNRESET'),
    res(403,'{}',{'x-ratelimit-remaining':'0'}),res(403,'{}',{'retry-after':'5'})]);
  for(let i=0;i<5;i++)await assert.rejects(api.repo('o/r'));
  assert.ok(breakerFor(origin).openUntil>Date.now(),'five rate-limit/network failures open it');
  const other='https://breaker-m14b.example';
  const plain=mk(other,[res(403,'{"message":"Resource not accessible"}'),res(404),res(422)]);
  for(let i=0;i<3;i++)await assert.rejects(plain.repo('o/r'));
  assert.equal(breakerFor(other).failures,0,'ordinary 4xx never count');
});

test('M15: failed-job logs have their own budget and are reported as partial',async()=>{
  const f=await remoteFixture({envExtra:{ZANA_TOOL_DEADLINE_MS:'5000'}});
  try{
    const {author,missionId}=await f.authorReady({green:false});
    f.api.state.red(sha('a'));
    const s=await f.call('zana_checks_start',{missionId},author);
    f.runtime.github.jobLogTail=()=>new Promise(r=>setTimeout(()=>r(['late']),6000));
    const st=await f.runtime.checks.status(s.checkId);
    assert.equal(st.state,'FAILURE');
    assert.match(st.failures[0].logTail[0],/log time budget exhausted/);
    assert.ok(st.partial.some(p=>p.startsWith('log:')));
  }finally{await f.cleanup();}
});

test('M16: a dead downstream fails fast after a failed refresh and its breaker opens',async()=>{
  const srv=createServer(sock=>sock.destroy());
  await new Promise(ok=>srv.listen(0,'127.0.0.1',ok));
  let t=1_000_000;
  const g=new DownstreamGateway({name:'github',url:'http://127.0.0.1:'+srv.address().port+'/mcp',token:'x'.repeat(30),timeoutMs:1000},{now:()=>t});
  try{
    for(let i=0;i<3;i++){
      assert.match((await g.call({host:'h'},'get_me',{})).content[0].text,/could not read its tool list/);
      assert.match((await g.call({host:'h'},'get_me',{})).content[0].text,/could not read its tool list/,'fails fast');
      t+=20_000;
    }
    assert.equal(g.status().state,'CIRCUIT_OPEN');
    await assert.rejects(g.refresh(),/circuit open/);
  }finally{await g.close();await new Promise(ok=>srv.close(ok));}
});

test('W6: a write tool with a valid rule but no ALLOWED_KEYS entry is denied and reported',async()=>{
  const {createGitHubPolicy,catalogProblems}=await import('../src/github-policy.mjs');
  const catalog={version:'t',tools:{shiny_write:{zana:'write',rule:'file',readOnlyHint:false}}};
  assert.deepEqual(catalogProblems(catalog),['shiny_write: write without ALLOWED_KEYS']);
  const policy=createGitHubPolicy({config:{},catalog,deps:{github:{repo:async()=>({default_branch:'main'})},
    missionContext:async()=>({status:'ACTIVE',reviewer:false,runningForSession:true,repo:'o/r',branch:'zana/m',base:'main'})}});
  const d=await policy({caller:{},tool:'shiny_write',args:{owner:'o',repo:'r',branch:'zana/m',path:'a'},cls:'write',missionId:'m'});
  assert.match(d.reason,/UNCLASSIFIED: shiny_write has no ALLOWED_KEYS/);
});
