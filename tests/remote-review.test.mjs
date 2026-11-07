import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture,REVIEWER_TOKEN,REVIEWER_LOGIN,AUTHOR_TOKEN,sha,sleep,readDiff} from './helpers/remote-fixture.mjs';
import {ticketCode,validateLens,reviewBody} from '../src/remote-review.mjs';
import {remoteWrite} from '../src/store.mjs';

const clean=lens=>({lens,findings:[],evidence:['Read the full diff of src/sum.mjs and its test']});
const finding=(severity,extra={})=>({severity,location:'src/sum.mjs:3',evidence:'returns a-b instead of a+b',origin:'INTRODUCED',...extra});
async function claimed(f){
  const ready=await f.authorReady();
  const req=await f.call('zana_review_request',{missionId:ready.missionId},ready.author);
  assert.equal(req.error,undefined,req.error);
  const reviewer=await f.session();
  const claim=await f.call('zana_review_claim',{ticket:req.ticket},reviewer);
  assert.equal(claim.error,undefined,claim.error);
  await readDiff(f.call,req.ticket,reviewer);
  return {...ready,req,reviewer,claim,ticket:req.ticket};
}
async function allLenses(f,ticket,reviewer,risk=clean('risk')){
  for(const l of [risk,clean('readability'),clean('reliability'),clean('resilience')]){
    const r=await f.call('zana_review_lens_submit',{ticket,...l},reviewer);
    assert.equal(r.error,undefined,r.error);
  }
}

test('checks: start dispatches or associates on the exact head SHA; status reports logs without secrets',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId,branch,packet}=await f.authorReady({green:false});
    const started=await f.call('zana_checks_start',{missionId},author);
    assert.equal(started.sha,sha('a'));
    assert.equal(started.dispatched,true);
    assert.deepEqual(f.api.state.dispatches,[{workflow:'zana-checks.yml',ref:branch}]);
    let status=await f.call('zana_checks_status',{checkId:started.checkId},author);
    assert.equal(status.state,'PENDING');
    f.api.state.red(sha('a'));
    status=await f.call('zana_checks_status',{checkId:started.checkId},author);
    assert.equal(status.state,'FAILURE');
    assert.ok(status.failures[0].logTail.some(l=>l.includes('expected 2 got 3')));
    assert.equal(JSON.stringify(status).includes(AUTHOR_TOKEN),false);
    assert.equal(JSON.stringify(status).includes('\x1b'),false);
    // A code unit cannot be completed without a green check on its final SHA.
    const outcome={success:true,summary:'implemented',evidence:['x']};
    const blocked=await f.call('zana_complete_unit',{unitId:'code',token:packet.token,leaseGeneration:packet.leaseGeneration,outcome},author);
    assert.match(blocked.error,/CHECKS_NOT_GREEN/);
    // New push: the runs of that SHA are associated, not re-dispatched.
    f.api.state.push(branch,sha('b'));
    f.api.state.workflowRuns[sha('b')]=[{id:3,head_sha:sha('b'),path:'.github/workflows/zana-checks.yml',status:'in_progress'}];
    const again=await f.call('zana_checks_start',{missionId},author);
    assert.equal(again.dispatched,false);
    assert.equal(again.associatedRuns.length,1);
    f.api.state.green(sha('b'));
    const green=await f.call('zana_checks_status',{checkId:again.checkId},author);
    assert.equal(green.state,'SUCCESS');
    assert.equal(green.headMoved,false);
    const oldStatus=await f.call('zana_checks_status',{checkId:started.checkId},author);
    assert.equal(oldStatus.headMoved,true);
    const done=await f.call('zana_complete_unit',{unitId:'code',token:packet.token,leaseGeneration:packet.leaseGeneration,outcome},author);
    assert.equal(done.checkedSha,sha('b'));
    assert.match((await f.call('zana_checks_status',{checkId:'00000000-0000'},author)).error,/Unknown checkId/);
  }finally{await f.cleanup();}
});

test('required checks: missing names stay pending; a log that cannot be read is reported',async()=>{
  const f=await remoteFixture({envExtra:{ZANA_REQUIRED_CHECKS:'test,lint'}});
  try{
    const {author,missionId}=await f.authorReady({green:false});
    f.api.state.green(sha('a'),'test');
    const s=await f.call('zana_checks_start',{missionId},author);
    let st=await f.call('zana_checks_status',{checkId:s.checkId},author);
    assert.equal(st.state,'PENDING');
    assert.deepEqual(st.missing,['lint']);
    f.api.state.checkRuns[sha('a')].push({id:91,name:'lint',status:'completed',conclusion:'timed_out',head_sha:sha('a')});
    st=await f.call('zana_checks_status',{checkId:s.checkId},author);
    assert.equal(st.state,'FAILURE');
    assert.match(st.failures[0].logTail[0],/log unavailable/);
  }finally{await f.cleanup();}
});

test('review request needs an open mission PR with green checks; claim rules',async()=>{
  const f=await remoteFixture();
  try{
    const noPr=await f.authorReady({pull:false});
    assert.match((await f.call('zana_review_request',{missionId:noPr.missionId},noPr.author)).error,/NO_PULL_REQUEST/);
    f.api.state.openPull(noPr.branch);
    f.api.state.checkRuns={};
    assert.match((await f.call('zana_review_request',{missionId:noPr.missionId},noPr.author)).error,/CHECKS_NOT_GREEN/);
    f.api.state.green(sha('a'));
    // W3 order: a RUNNING code unit blocks the ticket until it is completed.
    assert.match((await f.call('zana_review_request',{missionId:noPr.missionId},noPr.author)).error,/UNIT_STILL_RUNNING/);
    assert.equal((await f.call('zana_complete_unit',{unitId:'code',token:noPr.packet.token,leaseGeneration:noPr.packet.leaseGeneration,
      outcome:{success:true,summary:'code done',evidence:['green checks']}},noPr.author)).error,undefined);
    const before=await f.session();
    const writer=await f.session();
    const req=await f.call('zana_review_request',{missionId:noPr.missionId},noPr.author);
    assert.match(req.message,/^Revisa el ticket ZR-[A-Z2-7-]+ con ZanaLLaima$/);
    // Author session.
    assert.match((await f.call('zana_review_claim',{ticket:req.ticket},noPr.author)).error,/AUTHOR_SESSION/);
    // A session that wrote in the mission (any mutating tool counts).
    await sleep(3);
    const wroteAfter=await f.session();
    assert.equal((await f.call('zana_checks_start',{missionId:noPr.missionId},wroteAfter)).error,undefined);
    assert.match((await f.call('zana_review_claim',{ticket:req.ticket},wroteAfter)).error,/SESSION_WROTE/);
    // A session created before the ticket.
    assert.match((await f.call('zana_review_claim',{ticket:req.ticket},before)).error,/SESSION_PREDATES_TICKET/);
    void writer;
    // Unknown, then reused.
    assert.match((await f.call('zana_review_claim',{ticket:'ZR-AAAA-AAAA-AAAA-AAAA'},before)).error,/TICKET_NOT_FOUND/);
    assert.match((await f.call('zana_review_claim',{ticket:'not-a-ticket'},before)).error,/TICKET_NOT_FOUND/);
    const reviewer=await f.session();
    let late;
    const ok=await f.call('zana_review_claim',{ticket:req.ticket},reviewer);
    assert.equal(ok.state,'CLAIMED');
    assert.equal(ok.sha,sha('a'));
    assert.equal(ok.diffManifest.totalPages,1);
    const page=await f.call('zana_review_diff',{ticket:req.ticket,page:0},reviewer);
    assert.equal(page.text.includes(AUTHOR_TOKEN),false,'diff is redacted');
    assert.deepEqual(page.unread,[]);
    assert.match((await f.call('zana_review_diff',{ticket:req.ticket,page:1},reviewer)).error,/INVALID_PAGE/);
    assert.match((await f.call('zana_review_diff',{ticket:req.ticket,page:0},late=await f.session())).error,/NOT_REVIEWER/);
    assert.deepEqual(ok.lenses,['risk','readability','reliability','resilience']);
    assert.match((await f.call('zana_review_claim',{ticket:req.ticket},late)).error,/TICKET_ALREADY_CLAIMED/);
    // Expired ticket.
    const req2=await f.call('zana_review_request',{missionId:noPr.missionId},noPr.author);
    await remoteWrite(db=>db.prepare("UPDATE review_tickets SET expires_at='2000-01-01T00:00:00.000Z' WHERE state='OPEN'").run());
    const fresh=await f.session();
    assert.match((await f.call('zana_review_claim',{ticket:req2.ticket},fresh)).error,/TICKET_EXPIRED/);
    assert.match((await f.call('zana_review_claim',{ticket:req2.ticket},fresh)).error,/TICKET_EXPIRED/);
  }finally{await f.cleanup();}
});

test('reviewer session is read-only on the mission: no downstream writes, no mission tools, no merge',async()=>{
  const f=await remoteFixture();
  try{
    const {reviewer,missionId,branch,packet}=await claimed(f);
    const w=await f.call('zana_ds_github',{operation:'create_or_update_file',missionId,
      arguments:{owner:'o',repo:'r',branch,path:'a',content:'x',message:'m'}},reviewer);
    assert.match(w.raw.content[0].text,/REVIEWER_READ_ONLY/);
    for(const [tool,args] of [['zana_start_batch',{}],['zana_mission_cancel',{}],
      ['zana_unit_heartbeat',{unitId:'code',token:packet.token,leaseGeneration:packet.leaseGeneration}],
      ['zana_checks_start',{missionId}],['zana_review_request',{missionId}],['zana_merge',{missionId}]])
      assert.match((await f.call(tool,args,reviewer)).error,/REVIEWER_READ_ONLY/,tool);
    const status=await f.call('zana_session_status',{},reviewer);
    assert.equal(status.activeMission.reviewer,true);
    assert.equal(status.activeMission.wrote,false);
  }finally{await f.cleanup();}
});

test('lens submit validation and finalize preconditions',async()=>{
  const f=await remoteFixture();
  try{
    const {ticket,reviewer,author}=await claimed(f);
    const sub=args=>f.call('zana_review_lens_submit',{ticket,...args},reviewer);
    assert.match((await sub({lens:'risk',findings:[{severity:'CRITICAL',location:'src/a.mjs',evidence:'x',origin:'INTRODUCED'}],evidence:['e']})).error,/MISSING_LOCATION/);
    assert.match((await sub({lens:'risk',findings:[{severity:'CRITICAL',location:'src/a.mjs:3',evidence:' ',origin:'INTRODUCED'}],evidence:['e']})).error,/MISSING_EVIDENCE/);
    assert.match((await sub({lens:'risk',findings:[{location:'src/a.mjs:3',evidence:'x',origin:'INTRODUCED'}],evidence:['e']})).error,/MISSING_SEVERITY/);
    assert.ok((await sub({lens:'risk',findings:[],evidence:[]})).error);
    assert.match((await f.call('zana_review_lens_submit',{ticket,...clean('risk')},author)).error,/NOT_REVIEWER/);
    const first=await sub(clean('risk'));
    assert.deepEqual(first.remaining,['readability','reliability','resilience']);
    assert.match((await sub(clean('risk'))).error,/LENS_ALREADY_SUBMITTED/);
    await sub(clean('readability'));await sub(clean('reliability'));
    // Finalize with three lenses.
    assert.match((await f.call('zana_review_finalize',{ticket,execution:'PARALLEL_SUBAGENTS'},reviewer)).error,/LENSES_INCOMPLETE: missing lenses: resilience/);
    await sub(clean('resilience'));
    assert.match((await f.call('zana_review_finalize',{ticket,execution:'PARALLEL_SUBAGENTS'},author)).error,/NOT_REVIEWER/);
    // Finalize with CI red on the ticket SHA publishes nothing.
    f.api.state.checkRuns[sha('a')]=[];f.api.state.red(sha('a'));
    assert.match((await f.call('zana_review_finalize',{ticket,execution:'PARALLEL_SUBAGENTS'},reviewer)).error,/CHECKS_NOT_GREEN/);
    assert.equal((f.api.state.reviews[7]??[]).length,0);
    assert.throws(()=>validateLens('style',[],['e']),/INVALID_LENS/);
    assert.throws(()=>validateLens('risk',null,['e']),/INVALID_FINDINGS/);
    assert.throws(()=>validateLens('risk',[null],['e']),/INVALID_FINDING/);
    assert.throws(()=>validateLens('risk',[finding('WARNING',{title:'x'.repeat(301)})],['e']),/title too long/);
  }finally{await f.cleanup();}
});

test('finalize after a new push is STALE_SHA and publishes nothing',async()=>{
  const f=await remoteFixture();
  try{
    const {ticket,reviewer,branch}=await claimed(f);
    await allLenses(f,ticket,reviewer);
    f.api.state.push(branch,sha('c'));
    const r=await f.call('zana_review_finalize',{ticket,execution:'PARALLEL_SUBAGENTS'},reviewer);
    assert.equal(r.state,'STALE_SHA');
    assert.equal(r.published,false);
    assert.equal((f.api.state.reviews[7]??[]).length,0);
    assert.equal((f.api.state.statuses[sha('a')]??[]).length,0);
    assert.match((await f.call('zana_review_finalize',{ticket,execution:'PARALLEL_SUBAGENTS'},reviewer)).error,/TICKET_NOT_CLAIMED/);
  }finally{await f.cleanup();}
});

test('clean 4R approves the exact commit with the reviewer token and posts zana/4r',async()=>{
  const f=await remoteFixture();
  try{
    const {ticket,reviewer,missionId,author}=await claimed(f);
    await allLenses(f,ticket,reviewer);
    const r=await f.call('zana_review_finalize',{ticket,execution:'SEQUENTIAL_SAME_CONVERSATION'},reviewer);
    assert.equal(r.state,'FINALIZED');
    assert.equal(r.event,'APPROVE');
    const post=f.api.state.requests.find(x=>x.method==='POST'&&x.path.endsWith('/pulls/7/reviews'));
    assert.equal(post.token,REVIEWER_TOKEN,'review posted with the reviewer token');
    const sent=JSON.parse(post.body);
    assert.equal(sent.commit_id,sha('a'));
    assert.equal(sent.event,'APPROVE');
    assert.match(sent.body,/4 lentes en secuencia en la misma conversación revisora/);
    assert.ok(sent.body.includes(ticket));
    for(const l of ['risk','readability','reliability','resilience'])assert.ok(sent.body.includes('| '+l+' |'));
    const status=f.api.state.requests.find(x=>x.path.endsWith('/statuses/'+sha('a')));
    assert.equal(status.token,REVIEWER_TOKEN);
    assert.deepEqual({...JSON.parse(status.body),description:undefined},{state:'success',context:'zana/4r',description:undefined});
    // Idempotent: a second finalize reports and publishes nothing new.
    const again=await f.call('zana_review_finalize',{ticket,execution:'SEQUENTIAL_SAME_CONVERSATION'},reviewer);
    assert.equal(again.state,'FINALIZED');
    assert.equal(f.api.state.reviews[7].length,1);
    const delivery=await f.call('zana_delivery_status',{missionId},author);
    assert.equal(delivery.review.state,'APPROVED_EXACT_SHA');
    assert.equal(delivery.fourR,'success');
    assert.equal(delivery.ci.state,'SUCCESS');
    assert.equal(delivery.ready,true,JSON.stringify(delivery.blockers));
  }finally{await f.cleanup();}
});

test('a BLOCKER gives REQUEST_CHANGES and zana/4r failure; open blocking tickets block merge',async()=>{
  const f=await remoteFixture();
  try{
    const {ticket,reviewer,missionId,author}=await claimed(f);
    await allLenses(f,ticket,reviewer,{lens:'risk',findings:[finding('BLOCKER',{title:'wrong sum'})],evidence:['diff']});
    const blocking=await f.runtime.review.openBlocking(missionId);
    assert.equal(blocking.length,1);
    const merge=await f.call('zana_merge',{missionId},author);
    assert.equal(merge.state,'NOT_READY');
    assert.ok(merge.blockers.some(b=>/BLOCKER or CRITICAL/.test(b)));
    const r=await f.call('zana_review_finalize',{ticket,execution:'PARALLEL_SUBAGENTS'},reviewer);
    assert.equal(r.event,'REQUEST_CHANGES');
    assert.equal(r.status.state,'failure');
    const sent=JSON.parse(f.api.state.requests.find(x=>x.method==='POST'&&x.path.endsWith('/pulls/7/reviews')).body);
    assert.equal(sent.event,'REQUEST_CHANGES');
    assert.match(sent.body,/\*\*BLOCKER\*\* `src\/sum.mjs:3` — wrong sum/);
    assert.match(sent.body,/4 subagentes en paralelo/);
    const delivery=await f.call('zana_delivery_status',{missionId},author);
    assert.equal(delivery.review.state,'CHANGES_REQUESTED');
    assert.equal(delivery.fourR,'failure');
  }finally{await f.cleanup();}
});

test('merge: every missing condition refused, disabled by config, STALE_SHA on moved head, success with exact sha',async()=>{
  const f=await remoteFixture();
  try{
    const {ticket,reviewer,missionId,author,branch}=await claimed(f);
    const stranger=await f.session();
    assert.match((await f.call('zana_merge',{missionId},stranger)).error,/NOT_AUTHOR/);
    let m=await f.call('zana_merge',{missionId},author);
    assert.equal(m.state,'NOT_READY');
    assert.ok(m.blockers.some(b=>/MISSING/.test(b)),'no approval yet');
    assert.ok(m.blockers.some(b=>/zana\/4r/.test(b)),'no zana/4r yet');
    await allLenses(f,ticket,reviewer);
    await f.call('zana_review_finalize',{ticket,execution:'PARALLEL_SUBAGENTS'},reviewer);
    const pull=f.api.state.pulls[0];
    pull.mergeable=false;pull.mergeable_state='dirty';
    m=await f.call('zana_merge',{missionId},author);
    assert.deepEqual(m.blockers,['Pull request not mergeable (dirty)']);
    pull.mergeable=true;
    f.api.state.checkRuns[sha('a')][0].conclusion='failure';
    m=await f.call('zana_merge',{missionId},author);
    assert.ok(m.blockers.some(b=>/CI on .*FAILURE/.test(b)));
    f.api.state.checkRuns[sha('a')][0].conclusion='success';
    // The reviewer authored a commit: not independent.
    f.api.state.commits[7].push({author:{login:REVIEWER_LOGIN}});
    m=await f.call('zana_merge',{missionId},author);
    assert.ok(m.blockers.some(b=>/REVIEWER_IS_AUTHOR/.test(b)));
    f.api.state.commits[7].pop();
    // Head moved after approval: approval is stale.
    f.api.state.push(branch,sha('d'));
    f.api.state.green(sha('d'));
    m=await f.call('zana_merge',{missionId},author);
    assert.ok(m.blockers.some(b=>/STALE_SHA/.test(b)));
    f.api.state.push(branch,sha('a'));
    // Head moves between verification and merge: GitHub refuses, STALE_SHA, no retry.
    const realMerge=f.runtime.github.merge.bind(f.runtime.github);
    f.runtime.github.merge=async(...a)=>{f.api.state.push(branch,sha('e'));return realMerge(...a);};
    m=await f.call('zana_merge',{missionId},author);
    assert.equal(m.state,'STALE_SHA');
    assert.equal(f.api.state.merges.length,1);
    f.runtime.github.merge=realMerge;
    f.api.state.push(branch,sha('a'));
    m=await f.call('zana_merge',{missionId},author);
    assert.equal(m.state,'MERGED');
    const last=f.api.state.merges.at(-1);
    assert.deepEqual({sha:last.sha,method:last.merge_method,token:last.token},{sha:sha('a'),method:'squash',token:AUTHOR_TOKEN});
    const audit=await f.runtime.readAudit({missionId,limit:200});
    assert.ok(audit.some(a=>a.tool==='zana_merge.result'&&a.outcome==='MERGED'&&a.detail.headSha===sha('a')));
  }finally{await f.cleanup();}
});

test('merge can be disabled by configuration; operator merge needs no author session',async()=>{
  const f=await remoteFixture({envExtra:{ZANA_MERGE_ENABLED:'false'}});
  try{
    const {missionId,author}=await f.authorReady();
    assert.equal((await f.call('zana_merge',{missionId},author)).state,'MERGE_DISABLED');
    const op=await f.runtime.ops.zana_merge({missionId},{operator:true,host:'operator',sessionId:'operator-cli'});
    assert.equal(op.state,'MERGE_DISABLED');
  }finally{await f.cleanup();}
});

test('ticket codes and review body helpers',()=>{
  assert.match(ticketCode(Buffer.alloc(16,0)),/^ZR-AAAA-AAAA-AAAA-AAAA$/);
  assert.match(ticketCode(),/^ZR-[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
  const lenses=['risk','readability','reliability','resilience'].map(l=>({lens:l,hash:'h'.repeat(64),findings:[],evidence:['e']}));
  const body=reviewBody({code:'ZR-AAAA-AAAA-AAAA-AAAA',ticket:{pr_number:1,sha:sha('a')},lenses,
    execution:'PARALLEL_SUBAGENTS',event:'APPROVE'});
  assert.match(body,/Sin hallazgos/);
  const huge=reviewBody({code:'ZR-AAAA-AAAA-AAAA-AAAA',ticket:{pr_number:1,sha:sha('a')},
    lenses:lenses.map(l=>({...l,findings:Array.from({length:50},()=>finding('WARNING',{evidence:'x'.repeat(4000)}))})),
    execution:'PARALLEL_SUBAGENTS',event:'APPROVE'});
  assert.match(huge,/cuerpo recortado/);
});

test('finalize without ZANA_REVIEWER_LOGIN fails closed and publishes nothing',async()=>{
  const f=await remoteFixture({envExtra:{ZANA_REVIEWER_LOGIN:''}});
  try{
    const {ticket,reviewer}=await claimed(f);
    await allLenses(f,ticket,reviewer);
    const r=await f.call('zana_review_finalize',{ticket,execution:'PARALLEL_SUBAGENTS'},reviewer);
    assert.match(r.error,/REVIEWER_LOGIN_MISSING/);
    assert.equal((f.api.state.reviews[7]??[]).length,0);
    assert.equal((f.api.state.statuses?.[sha('a')]??[]).length,0);
  }finally{await f.cleanup();}
});
