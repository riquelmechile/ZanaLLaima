// Etapa B, ronda de corrección 3: tests negativos de los P1.
import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture,readDiff,sha,sleep} from './helpers/remote-fixture.mjs';
import {remoteRead,remoteWrite} from '../src/store.mjs';

const clean=lens=>({lens,findings:[],evidence:['read every page']});
const blocker={lens:'risk',findings:[{severity:'BLOCKER',location:'src/sum.mjs:3',evidence:'returns a-b'}],evidence:['diff']};
const outcome=x=>({success:true,summary:'done on '+x,evidence:['head '+x]});
async function lenses(f,ticket,s,risk=clean('risk')){
  assert.equal((await f.call('zana_review_claim',{ticket},s)).state,'CLAIMED');
  await readDiff(f.call,ticket,s);
  for(const l of [risk,clean('readability'),clean('reliability'),clean('resilience')])
    assert.equal((await f.call('zana_review_lens_submit',{ticket,...l},s)).error,undefined);
}
const finalize=(f,ticket,s)=>f.call('zana_review_finalize',{ticket,execution:'PARALLEL_SUBAGENTS'},s);
async function complete(f,author,packet){
  const r=await f.call('zana_complete_unit',{unitId:packet.unitId,token:packet.token,leaseGeneration:packet.leaseGeneration,outcome:outcome(sha('a'))},author);
  assert.equal(r.error,undefined,r.error);
}

test('P1-A: zana_review_request refuses while a code unit is still RUNNING, and correction next includes zana_complete_unit',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId,packet}=await f.authorReady();
    const early=await f.call('zana_review_request',{missionId},author);
    assert.match(early.error??'',/UNIT_STILL_RUNNING/,'W3 order: complete the unit before asking for a ticket');
    await complete(f,author,packet);
    const t=await f.call('zana_review_request',{missionId},author);
    assert.equal(t.error,undefined,t.error);
  }finally{await f.cleanup();}
});

test('P1-A: the next step of zana_correction_start follows the skill order',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId,packet}=await f.authorReady();
    await complete(f,author,packet);
    const t=await f.call('zana_review_request',{missionId},author);
    const s=await f.session();
    await lenses(f,t.ticket,s,blocker);
    assert.equal((await finalize(f,t.ticket,s)).event,'REQUEST_CHANGES');
    const corr=await f.call('zana_correction_start',{missionId},author);
    assert.equal(corr.error,undefined,corr.error);
    const next=String(corr.next);
    const order=['zana_start_batch','zana_checks_','zana_complete_unit','zana_review_request'].map(x=>next.indexOf(x));
    assert.ok(order.every(i=>i>=0),'next must name every step: '+next);
    assert.deepEqual([...order].sort((a,b)=>a-b),order,'next must keep the skill order: '+next);
    const unit=(await f.call('zana_mission_status',{},author)).units.find(u=>u.id===corr.unitId);
    assert.match(unit.instruction,/zana_complete_unit/);
  }finally{await f.cleanup();}
});

test('P1-B: a ticket superseded while its finalize waits on GitHub never revives nor enables the merge',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId,packet}=await f.authorReady();
    await complete(f,author,packet);
    const t1=await f.call('zana_review_request',{missionId},author);
    const s1=await f.session();
    await lenses(f,t1.ticket,s1);
    // While t1's finalize is inside the GitHub call, the author asks for a new
    // ticket (same SHA: t1 is superseded) and a second reviewer requests changes.
    const gh=f.runtime.reviewerGithub,real=gh.createReview.bind(gh);
    let second=null,t2=null;
    const runSecond=async()=>{
      t2=t2??await second;
      assert.equal(t2.error,undefined,t2.error);
      const s2=await f.session('gpt-c','zc_other');
      await lenses(f,t2.ticket,s2,blocker);
      assert.equal((await finalize(f,t2.ticket,s2)).event,'REQUEST_CHANGES');
    };
    let raced=false;
    gh.createReview=async(...a)=>{
      if(!second){
        second=f.call('zana_review_request',{missionId},author);
        // Either request() runs now (no serialization) or it waits for this finalize.
        const settled=await Promise.race([second.then(x=>x),sleep(300).then(()=>null)]);
        if(settled){t2=settled;raced=true;await runSecond();}
      }
      return real(...a);
    };
    const r1=await finalize(f,t1.ticket,s1);
    if(!raced&&second)await runSecond();
    gh.createReview=real;
    const rows=await remoteRead(db=>db.prepare('SELECT ticket_id,state,verdict,created_at,finalized_at FROM review_tickets WHERE mission_id=? ORDER BY created_at').all(missionId));
    assert.equal(rows.length,2);
    const [a,b]=rows;
    if(a.state==='FINALIZED'){
      assert.ok(Date.parse(a.finalized_at)<=Date.parse(b.created_at),
        'a ticket superseded before its finalize ended must not end FINALIZED (it revived)');
    }else{
      assert.notEqual(r1.state,'FINALIZED');
    }
    const ds=await f.call('zana_delivery_status',{missionId},author);
    assert.equal(ds.ready,false,'the current ticket requested changes: no merge');
    assert.equal((await f.call('zana_merge',{missionId},author)).state,'NOT_READY');
  }finally{await f.cleanup();}
});

test('P1-B: finalize revalidates the ticket in the DB before publishing and never publishes or revives a superseded one',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId,packet}=await f.authorReady();
    await complete(f,author,packet);
    const gh=f.runtime.reviewerGithub;
    const realReviews=gh.pullReviews.bind(gh),realCreate=gh.createReview.bind(gh),realStatus=gh.createStatus.bind(gh);
    let created=0,statuses=[];
    gh.createReview=async(...a)=>{created++;return realCreate(...a);};
    gh.createStatus=async(repo,commit,s)=>{statuses.push(s.state);return realStatus(repo,commit,s);};
    // (a) Superseded (ABANDONED by another process) before the publication: nothing is published.
    const t1=await f.call('zana_review_request',{missionId},author);
    const s1=await f.session();
    await lenses(f,t1.ticket,s1);
    gh.pullReviews=async(...a)=>{
      await remoteWrite(db=>db.prepare("UPDATE review_tickets SET state='ABANDONED' WHERE mission_id=?").run(missionId));
      return realReviews(...a);
    };
    const r1=await finalize(f,t1.ticket,s1);
    gh.pullReviews=realReviews;
    assert.equal(created,0,'a superseded ticket must not publish');
    assert.notEqual(r1.state,'FINALIZED');
    assert.equal((await remoteRead(db=>db.prepare('SELECT state FROM review_tickets WHERE mission_id=?').all(missionId)))[0].state,'ABANDONED');
    // (b) Superseded while GitHub publishes: the state is not revived, no zana/4r success, inconsistency audited.
    await remoteWrite(db=>db.prepare("UPDATE review_tickets SET operator_released=1 WHERE mission_id=?").run(missionId));
    const t2=await f.call('zana_review_request',{missionId},author);
    assert.equal(t2.error,undefined,t2.error);
    const s2=await f.session();
    await lenses(f,t2.ticket,s2);
    gh.createReview=async(...a)=>{
      created++;
      await remoteWrite(db=>db.prepare("UPDATE review_tickets SET state='ABANDONED' WHERE state='FINALIZING'").run());
      return realCreate(...a);
    };
    const r2=await finalize(f,t2.ticket,s2);
    const row=(await remoteRead(db=>db.prepare('SELECT * FROM review_tickets WHERE mission_id=? ORDER BY created_at DESC').all(missionId)))[0];
    assert.equal(row.state,'ABANDONED','the UPDATE to FINALIZED must be conditional');
    assert.notEqual(r2.state,'FINALIZED');
    assert.ok(!statuses.includes('success'),'no zana/4r success for a superseded ticket');
    const audit=await remoteRead(db=>db.prepare("SELECT outcome FROM remote_audit WHERE mission_id=? AND outcome='INCONSISTENT'").all(missionId));
    assert.equal(audit.length,1,'a publication of a superseded ticket is audited');
    assert.equal((await f.call('zana_delivery_status',{missionId},author)).ready,false);
  }finally{await f.cleanup();}
});
