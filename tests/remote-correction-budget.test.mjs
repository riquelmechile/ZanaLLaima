// PR7: rondas de corrección acotadas. Tras un REQUEST_CHANGES el diff prevSha...sha solo toca
// archivos del PR o tests y a lo más min(200, ceil(líneas del PR / 2)) líneas sin lockfiles.
import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture,readDiff,sha} from './helpers/remote-fixture.mjs';
import {remoteRead,remoteWrite} from '../src/store.mjs';
import {isTestPath,correctionLimit} from '../src/line-budget.mjs';

const file=(filename,additions,deletions=0,extra={})=>({filename,additions,deletions,status:'modified',...extra});
// PR de 41 líneas: tope ceil(41/2)=21 (floor daría 20). Un rename src/old.mjs → src/new.mjs y un lockfile.
const PR=[file('src/sum.mjs',30,11),file('src/new.mjs',0,0,{previous_filename:'src/old.mjs',status:'renamed'}),file('package-lock.json',900)];
const clean=lens=>({lens,findings:[],evidence:['read every page']});
const blocker={lens:'risk',findings:[{severity:'BLOCKER',location:'src/sum.mjs:3',evidence:'returns a-b',origin:'INTRODUCED'}],evidence:['diff']};
async function review(f,ticket,risk=blocker){
  const s=await f.session();
  assert.equal((await f.call('zana_review_claim',{ticket},s)).error,undefined);
  await readDiff(f.call,ticket,s);
  for(const l of [risk,clean('readability'),clean('reliability'),clean('resilience')])
    assert.equal((await f.call('zana_review_lens_submit',{ticket,...l},s)).error,undefined);
  return f.call('zana_review_finalize',{ticket,execution:'PARALLEL_SUBAGENTS'},s);
}
// Primera ronda con REQUEST_CHANGES sobre a…a y el head ya en b…b con checks verdes.
async function rejected(f,pr=PR,extend=null){
  f.api.state.pullFiles['7']=pr;
  const ready=await f.authorReady();
  if(extend)assert.equal((await f.call('zana_budget_extend',{missionId:ready.missionId,lines:extend,reason:'el usuario autorizó'},ready.author)).error,undefined);
  const t1=await f.call('zana_review_request',{missionId:ready.missionId},ready.author);
  assert.equal(t1.error,undefined,t1.error);
  assert.equal((await review(f,t1.ticket)).event,'REQUEST_CHANGES');
  f.api.state.push(ready.branch,sha('b'));f.api.state.green(sha('b'));
  const request=async files=>{if(files)f.api.state.compareFiles=files;return f.call('zana_review_request',{missionId:ready.missionId},ready.author);};
  const ticketId=await remoteRead(db=>db.prepare('SELECT ticket_id FROM review_tickets WHERE code_hash IS NOT NULL ORDER BY created_at LIMIT 1').get().ticket_id);
  return {...ready,t1,request,ticketId};
}
const ext=(f,r,lines,scope,s=r.author)=>f.call('zana_budget_extend',{missionId:r.missionId,lines,reason:'el usuario dijo que sí',...(scope?{scope}:{})},s);
const tickets=()=>remoteRead(db=>db.prepare('SELECT COUNT(*) n FROM review_tickets').get().n);
const compareCalls=f=>f.api.state.requests.filter(x=>/\/compare\/[0-9a-f]{40}\.\.\./.test(x.path)).length;

test('correction helpers: test paths and min(200, ceil(lines/2))',()=>{
  for(const p of ['tests/a.mjs','src/test/a.mjs','x/__tests__/a.js','src/a.test.mjs','src/a.spec.ts'])assert.equal(isTestPath(p),true,p);
  for(const p of ['src/a.mjs','src/latest/a.mjs','contests/a.mjs','src/testing.mjs','mytests/a.mjs'])assert.equal(isTestPath(p),false,p);
  assert.deepEqual([1,2,41,399,400,401,5000].map(correctionLimit),[1,1,21,200,200,200,200]);
});

test('correction: only PR files and tests within the cap gives a ticket; correction_start reports the caps',async()=>{
  const f=await remoteFixture();
  try{
    const r=await rejected(f);
    const corr=await f.call('zana_correction_start',{missionId:r.missionId},r.author);
    assert.equal(corr.error,undefined,corr.error);
    assert.deepEqual(corr.correctionBudget,{files:'los archivos del PR y tests',prFiles:['src/sum.mjs','src/new.mjs','src/old.mjs','package-lock.json'],maxLines:21});
    assert.match(corr.next,/only the PR files and tests, at most correctionBudget.maxLines lines/);
    // PR files (also the old name of the PR's rename, written in another case) and a test, 21 lines: exactly the cap.
    const ok=await r.request([file('src/sum.mjs',10,5),file('./SRC/Old.mjs',2),file('tests/sum.test.mjs',4)]);
    assert.equal(ok.error,undefined,ok.error);
    assert.deepEqual(ok.correction,{forTicket:r.ticketId,fromSha:sha('a'),lines:21,limit:21,outOfScope:[],authorized:false});
    // The compare is prevSha...sha.
    assert.ok(f.api.state.requests.some(x=>x.path==='/repos/o/r/compare/'+sha('a')+'...'+sha('b')&&x.search==='?per_page=1'));
    // New test files of every kind are allowed.
    const tests=await r.request(['test/a.mjs','src/__tests__/b.js','src/c.test.mjs','lib/d.spec.ts'].map(p=>file(p,1)));
    assert.equal(tests.error,undefined,tests.error);
    // The whole PR still has its normal 400-line budget.
    f.api.state.pullFiles['7']=[file('src/sum.mjs',401)];
    assert.match((await r.request([file('src/sum.mjs',1)])).error,/^OVER_LINE_BUDGET: el PR cambia 401 líneas/);
  }finally{await f.cleanup();}
});

test('correction: a new file that is not a test is CORRECTION_OUT_OF_SCOPE (up to 10 paths, renames by both names)',async()=>{
  const f=await remoteFixture();
  try{
    const r=await rejected(f);
    const before=await tickets();
    assert.match((await r.request([file('src/sum.mjs',1),file('src/other.mjs',1)])).error,
      /^CORRECTION_OUT_OF_SCOPE: src\/other\.mjs: la corrección solo puede tocar los archivos del PR y tests; tiene 2 líneas; pregúntale al usuario si autoriza 2 líneas y, solo con su sí, llama zana_budget_extend con scope 'correction'$/);
    const many=await r.request(Array.from({length:12},(_,i)=>file('lib/f'+i+'.mjs',1)));
    assert.match(many.error,/^CORRECTION_OUT_OF_SCOPE: lib\/f0\.mjs, .*lib\/f9\.mjs \(y 2 más\): /);
    assert.doesNotMatch(many.error,/f10/);
    // A rename out of a PR file into a new path, and from an outside file into a PR path: both names count.
    assert.match((await r.request([file('src/total.mjs',0,0,{previous_filename:'src/sum.mjs',status:'renamed'})])).error,/^CORRECTION_OUT_OF_SCOPE: src\/total\.mjs:/);
    assert.match((await r.request([file('src/sum.mjs',0,0,{previous_filename:'lib/outside.mjs',status:'renamed'})])).error,/^CORRECTION_OUT_OF_SCOPE: lib\/outside\.mjs:/);
    // A lockfile outside the PR is out of scope too.
    assert.match((await r.request([file('sub/yarn.lock',1)])).error,/^CORRECTION_OUT_OF_SCOPE: sub\/yarn\.lock:/);
    assert.equal(await tickets(),before);
  }finally{await f.cleanup();}
});

test('correction: too many lines is OVER_CORRECTION_BUDGET with N and L; lockfiles do not count',async()=>{
  const f=await remoteFixture();
  try{
    const r=await rejected(f);
    assert.match((await r.request([file('src/sum.mjs',12,10)])).error,
      /^OVER_CORRECTION_BUDGET: el cambio de corrección tiene 22 líneas y el tope de esta ronda es 21; pregúntale al usuario si autoriza 22 líneas y, solo con su sí, llama zana_budget_extend con scope 'correction'$/);
    // A 5000-line lockfile of the PR does not count.
    const lock=await r.request([file('package-lock.json',5000,3000),file('src/sum.mjs',20)]);
    assert.equal(lock.error,undefined,lock.error);
    assert.equal(lock.correction.lines,20);
  }finally{await f.cleanup();}
  // A PR of 450 lines (budget extended): ceil(450/2)=225, capped at 200.
  const g=await remoteFixture();
  try{
    const r=await rejected(g,[file('src/sum.mjs',300,150)],450);
    assert.match((await r.request([file('src/sum.mjs',201)])).error,/^OVER_CORRECTION_BUDGET: el cambio de corrección tiene 201 líneas y el tope de esta ronda es 200;/);
    assert.equal((await r.request([file('src/sum.mjs',200)])).error,undefined);
  }finally{await g.cleanup();}
});

test('correction: without the stored measure, a failing or a truncated compare it is CORRECTION_UNMEASURED',async()=>{
  const f=await remoteFixture();
  try{
    const r=await rejected(f);
    const unmeasured=/^CORRECTION_UNMEASURED: no se puede medir la corrección desde a{40} \(/;
    const stored=await remoteRead(db=>db.prepare('SELECT line_budget FROM review_tickets WHERE ticket_id=?').get(r.ticketId).line_budget);
    const setPrev=v=>remoteWrite(db=>db.prepare('UPDATE review_tickets SET line_budget=? WHERE ticket_id=?').run(v,r.ticketId));
    const {touched,...noTouched}=JSON.parse(stored);void touched;
    const {lines,...noLines}=JSON.parse(stored);void lines;
    for(const v of [null,'{nope',JSON.stringify(noTouched),JSON.stringify(noLines)]){
      await setPrev(v);
      assert.match((await r.request([file('src/sum.mjs',1)])).error,new RegExp(unmeasured.source+'el ticket '+r.ticketId+' no guardó los archivos y líneas del PR\\); pregúntale al usuario si autoriza 1 líneas'),String(v));
    }
    await setPrev(stored);
    f.api.state.compareFilesError={status:500,message:'boom'};
    assert.match((await r.request()).error,/^CORRECTION_UNMEASURED: .*\(compare a{40}\.\.\.b{40}: GitHub HTTP 500: boom\); pregúntale al usuario si autoriza la ronda sin medir/);
    f.api.state.compareFilesError=null;
    // 300 files is GitHub's compare maximum: the list may be incomplete.
    assert.match((await r.request(Array.from({length:300},(_,i)=>file('tests/t'+i+'.mjs',0)))).error,/^CORRECTION_UNMEASURED: .*el compare lista 300 archivos o más/);
    assert.equal((await r.request(Array.from({length:299},(_,i)=>file('tests/t'+i+'.mjs',0)))).error,undefined);
    // Only the correction authorization of this round lets an unmeasured round through.
    f.api.state.compareFilesError={status:500,message:'boom'};
    assert.equal((await ext(f,r,5,'correction')).error,undefined);
    const lifted=await r.request();
    assert.equal(lifted.error,undefined,lifted.error);
    assert.equal(lifted.correction.authorized,true);
  }finally{await f.cleanup();}
});

test("correction: scope 'correction' lifts the three refusals of that round only; scope 'pr' does not",async()=>{
  const f=await remoteFixture();
  try{
    const r=await rejected(f);
    const over=[file('src/sum.mjs',25),file('lib/x.mjs',5)];
    // The PR extension does not lift a correction refusal, and both extensions are kept.
    assert.equal((await ext(f,r,1000)).lineBudget.limit,1000);
    assert.match((await r.request(over)).error,/^CORRECTION_OUT_OF_SCOPE: lib\/x\.mjs:/);
    assert.match((await r.request([file('src/sum.mjs',30)])).error,/^OVER_CORRECTION_BUDGET: .* 30 líneas y el tope de esta ronda es 21/);
    assert.deepEqual((await ext(f,r,29,'correction')).correctionBudget,{forTicket:r.ticketId,limit:29,previous:null,reason:'el usuario dijo que sí'});
    // Authorized for fewer lines than the change: still refused.
    assert.match((await r.request(over)).error,/^CORRECTION_OUT_OF_SCOPE: lib\/x\.mjs:.*tiene 30 líneas/);
    assert.equal((await ext(f,r,30,'correction')).correctionBudget.previous,29);
    const ok=await r.request(over);
    assert.equal(ok.error,undefined,ok.error);
    assert.equal(ok.correction.authorized,true);
    assert.equal(ok.lineBudget.limit,1000);
    const saved=await remoteRead(db=>JSON.parse(db.prepare('SELECT line_budget_extension e FROM remote_missions').get().e));
    assert.deepEqual([saved.limit,saved.correction.forTicket,saved.correction.limit,saved.correction.reason,saved.correction.sessionId],
      [1000,r.ticketId,30,'el usuario dijo que sí',r.author.sessionId]);
    // A later PR extension keeps the correction one.
    assert.equal((await ext(f,r,900)).lineBudget.previous,1000);
    const last=await r.request(over);
    assert.equal(last.error,undefined,last.error);
    const audit=await f.runtime.readAudit({missionId:r.missionId,limit:200});
    assert.equal(audit.filter(a=>a.tool==='zana_budget_extend'&&a.outcome==='OK'&&a.category==='write').length,4);
    // Next round: that ticket requests changes too; the authorization was for the previous one.
    assert.equal((await review(f,last.ticket)).event,'REQUEST_CHANGES');
    f.api.state.push(r.branch,sha('c'));f.api.state.green(sha('c'));
    const next=await r.request(over);
    assert.match(next.error,/^CORRECTION_OUT_OF_SCOPE: lib\/x\.mjs:/);
    assert.ok(f.api.state.requests.some(x=>x.path==='/repos/o/r/compare/'+sha('b')+'...'+sha('c')));
  }finally{await f.cleanup();}
});

test('correction: the reviewer cannot authorize, there is no round without REQUEST_CHANGES, and the first round has no checks',async()=>{
  const f=await remoteFixture();
  try{
    f.api.state.pullFiles['7']=PR;
    const ready=await f.authorReady();
    const r={...ready};
    // No finalized REQUEST_CHANGES: nothing to authorize.
    assert.match((await ext(f,r,10,'correction')).error,/^NO_CHANGES_REQUESTED:/);
    assert.match((await ext(f,r,10,'otro')).error,/^INVALID_ARGUMENTS:/);
    const first=await f.call('zana_review_request',{missionId:r.missionId},r.author);
    assert.equal(first.error,undefined,first.error);
    assert.equal('correction' in first,false);
    assert.equal(compareCalls(f),0);
    // An APPROVE ends the correction rounds.
    assert.equal((await review(f,first.ticket,clean('risk'))).event,'APPROVE');
    f.api.state.push(r.branch,sha('b'));f.api.state.green(sha('b'));
    f.api.state.compareFiles=[file('lib/x.mjs',500)];
    const after=await f.call('zana_review_request',{missionId:r.missionId},r.author);
    assert.equal(after.error,undefined,after.error);
    assert.equal(compareCalls(f),0);
    // The reviewer session of the mission is read-only.
    const reviewer=(await remoteRead(db=>db.prepare('SELECT reviewer_session s FROM review_tickets WHERE ticket_id IS NOT NULL AND reviewer_session IS NOT NULL').get())).s;
    assert.match((await ext(f,r,10,'correction',{sessionId:reviewer,host:'zana-chatgpt',clientId:'zc_test'})).error,/^REVIEWER_READ_ONLY/);
  }finally{await f.cleanup();}
});

test('correction: a review finalized while measuring changes the round and the request is refused',async()=>{
  const f=await remoteFixture();
  try{
    const r=await rejected(f);
    const t2=await r.request([file('src/sum.mjs',1)]);
    assert.equal(t2.error,undefined,t2.error);
    // The ticket of b…b ends in REQUEST_CHANGES between the measure (from a…a) and the new ticket.
    f.api.state.push(r.branch,sha('c'));f.api.state.green(sha('c'));
    f.api.state.onCompareFiles=async()=>{f.api.state.onCompareFiles=null;
      await remoteWrite(db=>db.prepare("UPDATE review_tickets SET state='FINALIZED',verdict='REQUEST_CHANGES' WHERE sha=?").run(sha('b')));};
    const before=await tickets();
    assert.match((await r.request()).error,/^CORRECTION_UNMEASURED: la ronda de revisión cambió mientras se medía/);
    assert.equal(await tickets(),before);
  }finally{await f.cleanup();}
});

test('correction: the grant covers only the measured SHA, files and lines of the refusal it answers',async()=>{
  const f=await remoteFixture();
  try{
    const r=await rejected(f);
    assert.match((await ext(f,r,30,'correction')).error,/^NO_CORRECTION_PENDING:/);
    assert.match((await r.request([file('lib/x.mjs',5)])).error,/^CORRECTION_OUT_OF_SCOPE: lib\/x\.mjs:/);
    assert.deepEqual((await ext(f,r,30,'correction')).correctionBudget,{forTicket:r.ticketId,forSha:sha('b'),outOfScope:['lib/x.mjs'],
      lines:5,unmeasured:false,limit:30,previous:null,reason:'el usuario dijo que sí'});
    assert.match((await r.request([file('lib/x.mjs',5),file('lib/y.mjs',1)])).error,/^CORRECTION_OUT_OF_SCOPE: lib\/x\.mjs, lib\/y\.mjs:/);
    assert.equal((await r.request([file('lib/x.mjs',5)])).error,undefined);
    // A measured grant does not cover the same SHA unmeasured, nor another SHA.
    f.api.state.compareFilesError={status:502,message:'transient'};
    assert.match((await r.request()).error,/^CORRECTION_UNMEASURED:/);
    f.api.state.compareFilesError=null;
    f.api.state.push(r.branch,sha('c'));f.api.state.green(sha('c'));
    assert.match((await r.request([file('lib/x.mjs',5)])).error,/^CORRECTION_OUT_OF_SCOPE: lib\/x\.mjs:/);
  }finally{await f.cleanup();}
});
