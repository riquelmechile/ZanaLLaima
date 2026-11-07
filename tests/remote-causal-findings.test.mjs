// PR3: hallazgos causales. Solo bloquea lo grave que trae el PR; lo
// PREEXISTING con prueba, en un archivo que el PR no toca, pasa a "Pendientes" y no bloquea.
import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture,readDiff} from './helpers/remote-fixture.mjs';
import {validateLens,validProof,lensDigest,reviewBody,canonPath,inTouchedFile,touchedFiles} from '../src/remote-review.mjs';
import {remoteWrite} from '../src/store.mjs';

const clean=lens=>({lens,findings:[],evidence:['read every page']});
// Head: line 1 context (a-b, already in the base), line 2 added by the PR, line 3 context.
const DIFF='diff --git a/src/sum.mjs b/src/sum.mjs\n--- a/src/sum.mjs\n+++ b/src/sum.mjs\n@@ -1,2 +1,3 @@\n'+
  ' export const sum=(a,b)=>a-b;\n+export const twice=x=>sum(x,x);\n // fin\n';
const PROOF='lib/other.mjs:5 ya restaba en la base (get_file_contents ref=baseSha)';
// Files of the PR (GitHub's /pulls/7/files): src/sum.mjs and a rename src/old.mjs → src/new.mjs.
const FILES=[{filename:'src/sum.mjs',additions:1,deletions:0,status:'modified'},
  {filename:'src/new.mjs',previous_filename:'src/old.mjs',additions:0,deletions:0,status:'renamed'}];
const OLD={location:'lib/other.mjs:5',proof:PROOF};
const finding=(origin,extra={})=>({severity:'BLOCKER',location:'src/sum.mjs:3',evidence:'returns a-b',origin,...extra});
const risk=(...findings)=>({lens:'risk',findings,evidence:['diff']});
async function claimed(f,diff=DIFF,files=FILES){
  f.api.state.diffText=diff;
  f.api.state.pullFiles['7']=files;
  const ready=await f.authorReady();
  const req=await f.call('zana_review_request',{missionId:ready.missionId},ready.author);
  const reviewer=await f.session();
  const claim=await f.call('zana_review_claim',{ticket:req.ticket},reviewer);
  assert.deepEqual([claim.state,claim.base,claim.baseSha],['CLAIMED','main','b'.repeat(40)]);
  await readDiff(f.call,req.ticket,reviewer);
  return {...ready,reviewer,ticket:req.ticket};
}
async function rest(f,ticket,reviewer){
  for(const l of ['readability','reliability','resilience'])
    assert.equal((await f.call('zana_review_lens_submit',{ticket,...clean(l)},reviewer)).error,undefined);
}
const finalize=(f,ticket,reviewer)=>f.call('zana_review_finalize',{ticket,execution:'PARALLEL_SUBAGENTS'},reviewer);
const sentBody=f=>JSON.parse(f.api.state.requests.find(x=>x.method==='POST'&&x.path.endsWith('/pulls/7/reviews')).body);

test('a PREEXISTING BLOCKER with a file:line proof in a file the PR does not touch approves and is a pending item',async()=>{
  const f=await remoteFixture();
  try{
    const {ticket,reviewer,missionId}=await claimed(f);
    const r=await f.call('zana_review_lens_submit',{ticket,...risk(finding('PREEXISTING',{...OLD,title:'resta'}),
      finding('PREEXISTING',{location:'other/sum.mjs:5',proof:'other/sum.mjs:5 sin cambios'}))},reviewer);
    assert.deepEqual({blocking:r.blocking,down:r.originDowngraded},{blocking:false,down:[]});
    await rest(f,ticket,reviewer);
    assert.deepEqual(await f.runtime.review.openBlocking(missionId),[]);
    const done=await finalize(f,ticket,reviewer);
    assert.equal(done.event,'APPROVE');
    const {body,event}=sentBody(f);
    assert.equal(event,'APPROVE');
    assert.match(body,/\| risk \| 0 \| 0 \| 0 \| 0 \| 2 \|/);
    assert.match(body,/### risk\nSin hallazgos del PR\./);
    assert.match(body,/Veredicto: \*\*APPROVE\*\*[^]*### Pendientes preexistentes \(no bloquean\)\n- \*\*BLOCKER\*\* `lib\/other.mjs:5` — resta\. Lente: risk\..*Prueba en la base: lib\/other.mjs:5 ya restaba/);
  }finally{await f.cleanup();}
});

test('a PREEXISTING without a valid proof is stored as UNKNOWN and requests changes',async()=>{
  const f=await remoteFixture();
  try{
    const {ticket,reviewer}=await claimed(f);
    const at=proof=>finding('PREEXISTING',{location:'lib/other.mjs:5',proof});
    const r=await f.call('zana_review_lens_submit',{ticket,...risk(at(),at('ya estaba así en main'),at('lib/other.mjs sin línea'),
      finding('PREEXISTING',{location:'src/sum.mjs:2',proof:'src/sum.mjs:2'}),// the PR adds line 2
      finding('PREEXISTING',{location:'src/sum.mjs:1',proof:PROOF}),// a line the PR does not add, but its file is touched
      at('src/sum.mjs:2'),// the proof cites base lines: only the location is checked
      at('a las 16:30, ratio 1:2, Node:22'),
      finding('PREEXISTING',{...OLD,severity:'WARNING'}))},reviewer);
    assert.deepEqual(r.originDowngraded,[0,1,2,3,4,6]);
    assert.equal(r.blocking,true);
    const stored=await remoteWrite(db=>JSON.parse(db.prepare("SELECT result FROM review_receipts WHERE lens_id='risk'").get().result));
    assert.deepEqual(stored.findings.map(x=>x.origin),[...Array(5).fill('UNKNOWN'),'PREEXISTING','UNKNOWN','PREEXISTING']);
    assert.equal(stored.findings[1].proof,'ya estaba así en main');
    await rest(f,ticket,reviewer);
    assert.equal((await finalize(f,ticket,reviewer)).event,'REQUEST_CHANGES');
    const {body}=sentBody(f);
    assert.match(body,/\| risk \| 6 \| 0 \| 0 \| 0 \| 2 \|/);
    assert.match(body,/- \*\*BLOCKER\*\* `lib\/other.mjs:5`\. Origen: `UNKNOWN`\./);
  }finally{await f.cleanup();}
});

test('INTRODUCED, ACTIVATED, WORSENED and UNKNOWN block with BLOCKER or CRITICAL',async()=>{
  for(const origin of ['INTRODUCED','ACTIVATED','WORSENED','UNKNOWN'])for(const severity of ['BLOCKER','CRITICAL']){
    const f=await remoteFixture();
    try{
      const {ticket,reviewer,missionId}=await claimed(f);
      const r=await f.call('zana_review_lens_submit',{ticket,...risk(finding(origin,{severity,proof:PROOF}))},reviewer);
      assert.equal(r.blocking,true,origin+' '+severity);
      await rest(f,ticket,reviewer);
      assert.equal((await f.runtime.review.openBlocking(missionId)).length,1,origin);
      assert.equal((await finalize(f,ticket,reviewer)).event,'REQUEST_CHANGES',origin+' '+severity);
      assert.match(sentBody(f).body,new RegExp('Origen: `'+origin+'`'));
    }finally{await f.cleanup();}
  }
});

test('a lens stored before origin existed counts as UNKNOWN and keeps blocking',async()=>{
  const f=await remoteFixture();
  try{
    const {ticket,reviewer,missionId,author}=await claimed(f);
    await remoteWrite(db=>db.prepare("INSERT INTO review_receipts(review_id,lens_id,token,result,created_at) SELECT ticket_id,'risk',?,?,? FROM review_tickets")
      .run('h'.repeat(64),JSON.stringify({findings:[{severity:'CRITICAL',location:'src/sum.mjs:3',evidence:'old'}],evidence:['old']}),new Date().toISOString()));
    assert.equal((await f.runtime.review.openBlocking(missionId)).length,1);
    assert.match((await f.call('zana_review_request',{missionId},author)).error,/CHANGES_REQUESTED_SAME_SHA/);
    await rest(f,ticket,reviewer);
    assert.equal((await finalize(f,ticket,reviewer)).event,'REQUEST_CHANGES');
    assert.match(sentBody(f).body,/- \*\*CRITICAL\*\* `src\/sum.mjs:3`\. Origen: `UNKNOWN`\. Evidencia: old/);
  }finally{await f.cleanup();}
});

test('without the file list (missing, truncated or unreadable), or in a row stored without a valid proof, PREEXISTING fails closed',async()=>{
  const f=await remoteFixture();
  try{
    const {ticket,reviewer,missionId}=await claimed(f);
    const lenses=['risk','readability','reliability'];
    const stored=await remoteWrite(db=>JSON.parse(db.prepare('SELECT line_budget FROM review_tickets').get().line_budget));
    assert.deepEqual(stored.touched,['src/sum.mjs','src/new.mjs','src/old.mjs']);
    for(const [i,budget] of [{...stored,touched:undefined},{...stored,truncated:true},'{nope'].entries()){
      await remoteWrite(db=>db.prepare('UPDATE review_tickets SET line_budget=?').run(typeof budget==='string'?budget:JSON.stringify(budget)));
      const r=await f.call('zana_review_lens_submit',{ticket,lens:lenses[i],findings:[finding('PREEXISTING',OLD)],evidence:['diff']},reviewer);
      assert.deepEqual([r.originDowngraded,r.blocking],[[0],true],String(i));
    }
    await remoteWrite(db=>db.prepare("DELETE FROM review_receipts").run());
    await remoteWrite(db=>db.prepare("INSERT INTO review_receipts(review_id,lens_id,token,result,created_at) SELECT ticket_id,'readability',?,?,? FROM review_tickets")
      .run('h'.repeat(64),JSON.stringify({findings:[{severity:'BLOCKER',location:'a.mjs:1',evidence:'x',origin:'PREEXISTING',proof:'16:30'}],evidence:['x']}),new Date().toISOString()));
    assert.equal((await f.runtime.review.openBlocking(missionId)).length,1);
    assert.equal((await f.runtime.review.list(missionId))[0].blocking,true);
  }finally{await f.cleanup();}
});

test('same SHA: only a PREEXISTING BLOCKER allows a new ticket; an INTRODUCED one does not',async()=>{
  for(const [origin,refused] of [['PREEXISTING',false],['INTRODUCED',true]]){
    const f=await remoteFixture();
    try{
      const {ticket,reviewer,missionId,author}=await claimed(f);
      await f.call('zana_review_lens_submit',{ticket,...risk(finding(origin,OLD))},reviewer);
      assert.equal((await f.runtime.review.list(missionId))[0].blocking,refused,'list '+origin);
      const again=await f.call('zana_review_request',{missionId},author);
      if(refused)assert.match(again.error,/CHANGES_REQUESTED_SAME_SHA/);
      else assert.equal(again.error,undefined,again.error);
    }finally{await f.cleanup();}
  }
});

test('origin and proof validation; the lens hash covers origin and proof',()=>{
  const base={severity:'WARNING',location:'a.mjs:1',evidence:'x'};
  for(const origin of [undefined,'NEW','preexisting',1])
    assert.throws(()=>validateLens('risk',[{...base,origin}],['e']),/^Error: INVALID_FINDING: finding 0 needs origin/);
  for(const proof of [7,'x'.repeat(2001)])
    assert.throws(()=>validateLens('risk',[{...base,origin:'UNKNOWN',proof}],['e']),/INVALID_FINDING: finding 0 proof/);
  validateLens('risk',[{...base,origin:'PREEXISTING',proof:'x'.repeat(2000)}],['e']);
  for(const ok of ['src/a.mjs:3','ver `src/a.mjs:3-9`.','en (lib/x.js:12), main','a.mjs:1: igual'])assert.equal(validProof(ok),true,ok);
  for(const bad of [undefined,'','src/a.mjs','línea 3 de main','a.mjs:x','a las 16:30','ratio 1:2','Node:22'])assert.equal(validProof(bad),false,String(bad));
  const digest=findings=>lensDigest({ticketId:'t',sha:'s',lens:'risk',findings,evidence:['e']});
  const one={...base,origin:'INTRODUCED'};
  assert.notEqual(digest([one]),digest([{...one,origin:'PREEXISTING'}]));
  assert.notEqual(digest([one]),digest([{...one,proof:PROOF}]));
});

test('submit returns the stored lens hash, which changes with origin',async()=>{
  const f=await remoteFixture();
  try{
    const {ticket,reviewer}=await claimed(f);
    const r=await f.call('zana_review_lens_submit',{ticket,...risk(finding('WORSENED'))},reviewer);
    const t=await remoteWrite(db=>db.prepare('SELECT ticket_id,sha FROM review_tickets').get());
    const stored={...finding('WORSENED')};
    assert.equal(r.hash,lensDigest({ticketId:t.ticket_id,sha:t.sha,lens:'risk',findings:[stored],evidence:['diff']}));
    assert.notEqual(r.hash,lensDigest({ticketId:t.ticket_id,sha:t.sha,lens:'risk',findings:[{...stored,origin:'UNKNOWN'}],evidence:['diff']}));
    assert.match((await f.call('zana_review_lens_submit',{ticket,...clean('readability'),findings:[{...finding('NEW')}]},reviewer)).error,/INVALID_FINDING/);
  }finally{await f.cleanup();}
});

test('review body: the verdict survives the size cut; pending items go last',()=>{
  const pending=Array.from({length:50},()=>finding('PREEXISTING',{proof:PROOF,evidence:'x'.repeat(4000)}));
  const lenses=['risk','readability','reliability','resilience'].map(l=>({lens:l,hash:'h'.repeat(64),findings:pending,evidence:['e']}));
  const body=reviewBody({code:'ZR-AAAA-AAAA-AAAA-AAAA',ticket:{pr_number:1,sha:'a'.repeat(40)},lenses,execution:'PARALLEL_SUBAGENTS',event:'APPROVE'});
  assert.match(body,/cuerpo recortado/);
  assert.match(body,/Veredicto: \*\*APPROVE\*\*\.\n\nPrueba: sesión revisora[^]*### Pendientes preexistentes/);
});

// The W1b escapes of rounds 1-3 (repro3): any line of a touched file is UNKNOWN and requests changes.
const REPRO=[['src/my file.mjs:2','src/my file.mjs:1'],['src/año.mjs:2','src/año.mjs:1'],['src/s.mjs:3','src/s.mjs:1'],
  ['b/src/s.mjs:2','src/s.mjs:1'],['src/s.mjs:3-1','src/s.mjs:1'],['s.mjs:2','src/s.mjs:1'],['src/s.mjs:53','src/s.mjs:50']];
test('repro3 end to end: a PREEXISTING on any line of a touched file is UNKNOWN and requests changes',async()=>{
  const f=await remoteFixture();
  try{
    const hunk=p=>'diff --git a/'+p+' b/'+p+'\n--- a/'+p+'\n+++ b/'+p+'\n@@ -1 +1,2 @@\n a\n+eval(process.env.X);\n';
    const diff=hunk('src/my file.mjs')+hunk('src/año.mjs')+hunk('src/s.mjs').replace('+eval','+++ b/src/decoy.mjs\n+eval')+
      '@@ -1,1 +1,3 @@\n a\n+// auth: Bearer\n+ABCDEFGHIJKLMNOPQRSTUV==\n@@ -50,1 +52,2 @@\n x\n+eval(process.env.X);\n';
    const {ticket,reviewer}=await claimed(f,diff,['src/my file.mjs','src/año.mjs','src/s.mjs'].map(filename=>({filename,additions:2,deletions:0})));
    const r=await f.call('zana_review_lens_submit',{ticket,...risk(...REPRO.map(([location,proof])=>
      finding('PREEXISTING',{location,proof:proof+' igual en la base'})))},reviewer);
    assert.deepEqual([r.originDowngraded,r.blocking],[[0,1,2,3,4,5,6],true]);
    await rest(f,ticket,reviewer);
    assert.equal((await finalize(f,ticket,reviewer)).event,'REQUEST_CHANGES');
  }finally{await f.cleanup();}
});
test('file granularity: path forms of a touched file (rename under both names) are UNKNOWN; other files keep PREEXISTING',async()=>{
  const touched=['src/sum.mjs:1','sum.mjs:1','/src/sum.mjs:1','SRC/Sum.MJS:1','src\\sum.mjs:1','o/r/src/sum.mjs:1','a/src/sum.mjs:1',
    './src//./sum.mjs:1','src/sum.mjs :1','src:1','src/old.mjs:4','old.mjs:4','src/new.mjs:4','src/su\u200bm.mjs:1','src/../lib/x.mjs:1'];
  const untouched=['lib/other.mjs:5','other/sum.mjs:5','xsum.mjs:5','um.mjs:5','xsrc/sum.mjs:5','src/sum.mjs.bak:5','lib/src.mjs:5'];
  const f=await remoteFixture();
  try{
    const {ticket,reviewer}=await claimed(f);
    const r=await f.call('zana_review_lens_submit',{ticket,...risk(...[...touched,...untouched].map(location=>finding('PREEXISTING',{location,proof:PROOF})))},reviewer);
    assert.deepEqual([r.originDowngraded,r.blocking],[touched.map((_,i)=>i),true]);
  }finally{await f.cleanup();}
  assert.deepEqual(touchedFiles(Object.assign([{filename:'a'}],{truncated:true})),null);
  assert.deepEqual(touchedFiles([{filename:'a',previousFilename:'b'},{filename:'c'}]),['a','b','c']);
  for(const bad of ['','/','./.','a/..','x\u0007y'])assert.equal(canonPath(bad),null,JSON.stringify(bad));
  assert.deepEqual([canonPath(' B/Src\\A.mjs '),canonPath('b')],['src/a.mjs','b']);
  assert.equal(inTouchedFile(['bad\u0001name'],'lib/x.mjs:1'),true);
});

test('claim: baseSha is null when the compare JSON fails; mergeBase refuses an invalid base',async()=>{
  const f=await remoteFixture();
  try{
    const ready=await f.authorReady();
    const req=await f.call('zana_review_request',{missionId:ready.missionId},ready.author);
    f.api.state.compareJsonError=true;
    const claim=await f.call('zana_review_claim',{ticket:req.ticket},await f.session());
    assert.deepEqual([claim.state,claim.baseSha],['CLAIMED',null]);
    await assert.rejects(f.runtime.github.mergeBase('o/r','bad..ref','a'.repeat(40)),/Invalid base/);
  }finally{await f.cleanup();}
});
