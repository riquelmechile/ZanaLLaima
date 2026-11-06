import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture,sha} from './helpers/remote-fixture.mjs';
import {remoteRead,remoteWrite} from '../src/store.mjs';
import {deliveryStatus} from '../src/github-delivery.mjs';
import {createDeadline} from '../src/deadline.mjs';
import {lineBudget,excluded} from '../src/line-budget.mjs';

const file=(filename,additions,deletions=0)=>({filename,additions,deletions,status:'modified'});

test('line budget: lockfiles and .zanallaima.json do not count; truncated is over',()=>{
  assert.equal(excluded('a/b/package-lock.json'),true);
  assert.equal(excluded('sub/package-lock.json'),true);
  assert.equal(excluded('deps/Cargo.lock'),true);
  // Only the listed lockfiles: any other .lock file is code and counts.
  assert.equal(excluded('deps/x.lock'),false);
  assert.equal(excluded('src/app.lock'),false);
  // The memory pointer is excluded only at the root.
  assert.equal(excluded('.zanallaima.json'),true);
  assert.equal(excluded('lib/.zanallaima.json'),false);
  assert.equal(excluded('src/lock.mjs'),false);
  assert.deepEqual(lineBudget([file('go.sum',900),file('src/a.mjs',30,20)],{limit:50}),
    {limit:50,lines:50,lockfileLines:900,files:2,over:false});
  assert.equal(lineBudget(Object.assign([],{truncated:true}),{limit:50}).over,true);
  // A list shorter than the PR's changed_files is incomplete: truncated and over.
  assert.deepEqual(lineBudget([file('a',1)],{limit:50,changedFiles:2}),
    {limit:50,lines:1,lockfileLines:0,files:1,over:true,truncated:true,changedFiles:2});
  assert.equal(lineBudget([file('a',1)],{limit:50,changedFiles:1}).over,false);
});

test('size limits: budget, extension, reviewer refusal, diff cap and delivery status',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId}=await f.authorReady();
    // Under budget (default fake: one file of 10 lines): ticket with lineBudget and diffBytes.
    const ok=await f.call('zana_review_request',{missionId},author);
    assert.equal(ok.error,undefined,ok.error);
    assert.deepEqual(ok.lineBudget,{limit:400,lines:10,lockfileLines:0,files:1,over:false});
    assert.ok(ok.diffBytes>0);
    // A 5000-line lockfile does not count; 450 real lines are over 400.
    f.api.state.pullFiles[7]=[file('package-lock.json',5000),file('src/a.mjs',300,150)];
    const over=await f.call('zana_review_request',{missionId},author);
    assert.match(over.error,/^OVER_LINE_BUDGET: el PR cambia 450 líneas .* presupuesto es 400/);
    const ext=await f.call('zana_budget_extend',{missionId,lines:450,reason:'el usuario autorizó 450 líneas'},author);
    assert.deepEqual(ext,{missionId,lineBudget:{limit:450,previous:400,reason:'el usuario autorizó 450 líneas'}});
    const audit=await f.runtime.readAudit({missionId,limit:200});
    assert.ok(audit.some(a=>a.tool==='zana_budget_extend'&&a.outcome==='OK'&&a.category==='write'));
    const req=await f.call('zana_review_request',{missionId},author);
    assert.equal(req.error,undefined,req.error);
    assert.deepEqual(req.lineBudget,{limit:450,lines:450,lockfileLines:5000,files:2,over:false});
    // The reviewer sees the same measures and cannot extend the budget.
    const reviewer=await f.session();
    const claim=await f.call('zana_review_claim',{ticket:req.ticket},reviewer);
    assert.equal(claim.error,undefined,claim.error);
    assert.equal(claim.lineBudget.lines,450);
    assert.equal(claim.diffBytes,req.diffBytes);
    assert.match((await f.call('zana_budget_extend',{missionId,lines:5000,reason:'quiero más'},reviewer)).error,/^REVIEWER_READ_ONLY/);
    // A session that never held the mission cannot extend it either.
    const stranger=await f.session();
    assert.match((await f.call('zana_budget_extend',{missionId,lines:500,reason:'sin permiso'},stranger)).error,/^NOT_AUTHOR/);
    // Read-only line budget in delivery status.
    const status=await f.call('zana_delivery_status',{missionId},author);
    assert.equal(status.lineBudget.limit,450);
    // The diff cap has no exception, even with an extension.
    f.api.state.diffText='diff --git a/x b/x\n'+'+'.repeat(1_900_000);
    assert.match((await f.call('zana_review_request',{missionId},author)).error,/^DIFF_TOO_LARGE: el diff pesa 19000\d\d bytes y el tope es 1800000/);
    // Redaction cannot shrink a diff under the cap: the size is what GitHub sent.
    f.api.state.diffText='diff --git a/x b/x\n'+('+ghp_'+'A'.repeat(36)+'\n').repeat(46_000);
    assert.match((await f.call('zana_review_request',{missionId},author)).error,/^DIFF_TOO_LARGE: el diff pesa 1932019 bytes/);
    f.api.state.diffText='+'.repeat(2_100_000);
    assert.match((await f.call('zana_review_request',{missionId},author)).error,/^DIFF_TOO_LARGE: el diff pasa los 2 MB/);
    // 31 pages of files: the list is truncated at 30 and treated as over.
    f.api.state.diffText=undefined;
    f.api.state.pullFiles[7]=Array.from({length:3100},(_,i)=>file('f'+i,0));
    assert.match((await f.call('zana_review_request',{missionId},author)).error,/^OVER_LINE_BUDGET: el PR cambia más de 3000 archivos; no hay extensión posible/);
    // Over the largest possible extension: no question to the user, just split.
    f.api.state.pullFiles[7]=[file('src/a.mjs',6000)];
    assert.match((await f.call('zana_review_request',{missionId},author)).error,/^OVER_LINE_BUDGET: el PR cambia 6000 líneas .* extensión máxima es 5000/);
    // Only the active mission can be extended.
    assert.match((await f.call('zana_budget_extend',{missionId:'mission-unknown',lines:10,reason:'abc'},author)).error,/MISSION_NOT_ACTIVE/);
  }finally{await f.cleanup();}
});

const tickets=()=>remoteRead(db=>db.prepare('SELECT COUNT(*) n FROM review_tickets').get().n);

test('size limits: a head that moves while measuring gives HEAD_MOVED before the budget, without a ticket',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId,branch}=await f.authorReady();
    // The file list is read from the live head: push between the first and the second pull read.
    f.api.state.onPullFiles=()=>f.api.state.push(branch,sha('c'));
    const moved=await f.call('zana_review_request',{missionId},author);
    assert.match(moved.error,/^HEAD_MOVED: el head del PR cambió de a{40} a c{40}/);
    assert.equal(await tickets(),0);
    // Over budget on the other SHA: the moved head is reported, not figures of another SHA.
    f.api.state.push(branch,sha('a'));
    f.api.state.pullFiles[7]=[file('src/a.mjs',900)];
    assert.match((await f.call('zana_review_request',{missionId},author)).error,/^HEAD_MOVED/);
    assert.equal(await tickets(),0);
  }finally{await f.cleanup();}
});

test('size limits: the claim returns the line budget measured for the ticket SHA',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId}=await f.authorReady();
    const req=await f.call('zana_review_request',{missionId},author);
    assert.equal(req.error,undefined,req.error);
    // The live file list changes after the ticket: the claim keeps the measured figures.
    f.api.state.pullFiles[7]=[file('src/a.mjs',300,90)];
    const claim=await f.call('zana_review_claim',{ticket:req.ticket},await f.session());
    assert.equal(claim.error,undefined,claim.error);
    assert.deepEqual(claim.lineBudget,req.lineBudget);
    // A ticket stored before the column existed has no measure.
    const again=await f.call('zana_review_request',{missionId},author);
    assert.equal(again.error,undefined,again.error);
    await remoteWrite(db=>db.prepare("UPDATE review_tickets SET line_budget=NULL WHERE state='OPEN'").run());
    assert.equal((await f.call('zana_review_claim',{ticket:again.ticket},await f.session())).lineBudget,null);
  }finally{await f.cleanup();}
});

test('size limits: the delivery line budget runs inside the tool deadline and is partial when it does not fit',async()=>{
  const ctx={missionId:'m',repo:'o/r',branch:'zana/m',base:'main'};
  const gh={openPullsFor:async()=>[{number:1,head:{ref:'zana/m'},base:{ref:'main'}}],
    pull:async()=>({number:1,state:'open',mergeable:true,head:{sha:'h'}}),
    checkRuns:async()=>[],statuses:async()=>[],pullCommits:async()=>[],pullReviews:async()=>[]};
  const config={reviewerLogin:'rev',requiredChecks:[]};
  let started=0;
  const slow=()=>{started++;return new Promise(ok=>setTimeout(()=>ok({lines:1}),2000));};
  const t0=Date.now();
  const r=await deliveryStatus({github:gh,config,ctx,deadline:createDeadline(200),lineBudgetOf:slow});
  assert.ok(Date.now()-t0<1500,'the slow file list must not outlive the deadline');
  assert.equal(started,1);
  assert.deepEqual(r.lineBudget,{unavailable:'DEADLINE'});
  assert.deepEqual(r.partial,['lineBudget']);
  // No time left: not even started.
  const none=await deliveryStatus({github:gh,config,ctx,deadline:createDeadline(0),lineBudgetOf:slow});
  assert.equal(started,1);
  assert.deepEqual(none.partial,['ci','zana/4r','review','lineBudget']);
  // In time it is returned as measured; without the callback there is no lineBudget.
  assert.deepEqual((await deliveryStatus({github:gh,config,ctx,lineBudgetOf:async p=>({pull:p.number})})).lineBudget,{pull:1});
  assert.equal('lineBudget' in await deliveryStatus({github:gh,config,ctx}),false);
});

test('size limits: GitHub refusing a diff over 300 files (406/422) is DIFF_TOO_LARGE',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId}=await f.authorReady();
    const request=async()=>(await f.call('zana_review_request',{missionId},author)).error;
    f.api.state.compareError={status:406,body:{message:'Sorry, the diff exceeded the maximum number of files (300). Consider using the files API instead.'}};
    assert.match(await request(),/^DIFF_TOO_LARGE: GitHub no entrega el diff \(HTTP 406: más de 300 archivos o demasiado grande\); divide el cambio/);
    f.api.state.compareError={status:422,body:{message:'Validation Failed',errors:[{resource:'Compare',field:'diff',code:'too_large'}]}};
    assert.match(await request(),/^DIFF_TOO_LARGE: GitHub no entrega el diff \(HTTP 422/);
    // Another 406/422 is not a size answer.
    f.api.state.compareError={status:422,body:{message:'No common ancestor',errors:[{code:'invalid'}]}};
    assert.match(await request(),/^GitHub HTTP 422: No common ancestor/);
    f.api.state.compareError={status:406,body:{message:'Not Acceptable'}};
    assert.match(await request(),/^GitHub HTTP 406: Not Acceptable/);
    assert.equal(await tickets(),0);
  }finally{await f.cleanup();}
});

test('size limits: a file list that does not match changed_files is incomplete and over',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId}=await f.authorReady();
    f.api.state.pulls[0].changed_files=2;
    assert.match((await f.call('zana_review_request',{missionId},author)).error,
      /^OVER_LINE_BUDGET: GitHub listó 1 de los 2 archivos del PR; la medida está incompleta/);
    assert.equal((await f.call('zana_delivery_status',{missionId},author)).lineBudget.truncated,true);
    assert.equal(await tickets(),0);
  }finally{await f.cleanup();}
});
