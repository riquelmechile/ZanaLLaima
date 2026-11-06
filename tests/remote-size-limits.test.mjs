import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture} from './helpers/remote-fixture.mjs';
import {lineBudget,excluded} from '../src/line-budget.mjs';

const file=(filename,additions,deletions=0)=>({filename,additions,deletions,status:'modified'});

test('line budget: lockfiles and .zanallaima.json do not count; truncated is over',()=>{
  assert.equal(excluded('a/b/package-lock.json'),true);
  assert.equal(excluded('deps/x.lock'),true);
  assert.equal(excluded('.zanallaima.json'),true);
  assert.equal(excluded('src/lock.mjs'),false);
  assert.deepEqual(lineBudget([file('go.sum',900),file('src/a.mjs',30,20)],{limit:50}),
    {limit:50,lines:50,lockfileLines:900,files:2,over:false});
  assert.equal(lineBudget(Object.assign([],{truncated:true}),{limit:50}).over,true);
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
