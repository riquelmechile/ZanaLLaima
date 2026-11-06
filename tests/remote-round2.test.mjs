// Etapa B, ronda de corrección 2: tests negativos de P1 y W1/W2.
import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture,readDiff,sha} from './helpers/remote-fixture.mjs';
import {remoteWrite} from '../src/store.mjs';

const clean=lens=>({lens,findings:[],evidence:['read every page']});
const blocker={lens:'risk',findings:[{severity:'BLOCKER',location:'src/sum.mjs:3',evidence:'returns a-b',origin:'INTRODUCED'}],evidence:['diff']};
async function review(f,ticket,s,risk=clean('risk')){
  assert.equal((await f.call('zana_review_claim',{ticket},s)).state,'CLAIMED');
  await readDiff(f.call,ticket,s);
  for(const l of [risk,clean('readability'),clean('reliability'),clean('resilience')])
    assert.equal((await f.call('zana_review_lens_submit',{ticket,...l},s)).error,undefined);
  return f.call('zana_review_finalize',{ticket,execution:'PARALLEL_SUBAGENTS'},s);
}
const outcome=x=>({success:true,summary:'done on '+x,evidence:['head '+x]});

test('P1: correction_start revalidates the latest ticket inside the mission transaction (TOCTOU)',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId,branch,packet}=await f.authorReady({complete:false});
    await f.call('zana_complete_unit',{unitId:'code',token:packet.token,leaseGeneration:packet.leaseGeneration,outcome:outcome(sha('a'))},author);
    const t1=await f.call('zana_review_request',{missionId},author);
    assert.equal((await review(f,t1.ticket,await f.session(),blocker)).event,'REQUEST_CHANGES');
    // Between the pre-check and the insertion, a newer ticket appears (the
    // author already pushed a fix and asked for a new review).
    const real=f.runtime.review.latest;
    f.runtime.review.latest=async id=>{
      const seen=await real(id);
      f.api.state.push(branch,sha('b'));
      await remoteWrite(db=>db.prepare("INSERT INTO review_tickets(ticket_id,code_hash,mission_id,repo,pr_number,sha,author_session,created_at,expires_at,state,updated_at) VALUES('newer','h-newer',?,'o/r',7,?,?,?,?,'OPEN',?)")
        .run(id,sha('b'),author.sessionId,new Date(Date.now()+1000).toISOString(),new Date(Date.now()+3600e3).toISOString(),new Date().toISOString()));
      return seen;
    };
    const r=await f.call('zana_correction_start',{missionId},author);
    assert.match(r.error??'',/NO_CHANGES_REQUESTED/,'the stale pre-check must not add a correction unit');
  }finally{await f.cleanup();}
});

test('W1: a BLOCKER on an abandoned/expired ticket still blocks a re-request on the same SHA until the operator releases it',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId}=await f.authorReady();
    // CLAIMED + BLOCKER, then the claim TTL passes (ABANDONED).
    const t1=await f.call('zana_review_request',{missionId},author);
    const s1=await f.session();
    await f.call('zana_review_claim',{ticket:t1.ticket},s1);
    await f.call('zana_review_lens_submit',{ticket:t1.ticket,...blocker},s1);
    await remoteWrite(db=>db.prepare("UPDATE review_tickets SET claimed_at='2000-01-01T00:00:00.000Z'").run());
    assert.match((await f.call('zana_review_request',{missionId},author)).error??'',/CHANGES_REQUESTED_SAME_SHA/,
      'waiting for the TTL must not buy a new review of the same SHA');
    // FINALIZING with REQUEST_CHANGES that expires: same rule.
    await remoteWrite(db=>db.prepare("UPDATE review_tickets SET state='FINALIZING',verdict='REQUEST_CHANGES',claimed_at='2000-01-01T00:00:00.000Z'").run());
    assert.match((await f.call('zana_review_request',{missionId},author)).error??'',/CHANGES_REQUESTED_SAME_SHA/);
    // Only an explicit operator abandon releases it.
    const id=(await f.runtime.review.list(missionId))[0].ticketId;
    await remoteWrite(db=>db.prepare("UPDATE review_tickets SET state='CLAIMED',claimed_at=? WHERE ticket_id=?").run(new Date().toISOString(),id));
    await f.runtime.review.abandon(id,{host:'operator',sessionId:'operator-cli'});
    assert.equal((await f.call('zana_review_request',{missionId},author)).error,undefined);
  }finally{await f.cleanup();}
});

test('W2: with ZANA_DISTINCT_REVIEWER_CLIENT the reviewer client differs from every client active in the mission',async()=>{
  const f=await remoteFixture({envExtra:{ZANA_DISTINCT_REVIEWER_CLIENT:'true'}});
  try{
    // The creator (client zc_test) builds the mission; another client asks for the ticket.
    const {missionId}=await f.authorReady();
    const requester=await f.session('gpt-b','zc_requester');
    const t=await f.call('zana_review_request',{missionId},requester);
    assert.equal(t.error,undefined,t.error);
    const sameAsCreator=await f.session('zana-chatgpt','zc_test');
    assert.match((await f.call('zana_review_claim',{ticket:t.ticket},sameAsCreator)).error??'',/SAME_CLIENT/);
    const sameAsRequester=await f.session('gpt-b','zc_requester');
    assert.match((await f.call('zana_review_claim',{ticket:t.ticket},sameAsRequester)).error??'',/SAME_CLIENT/);
    // The client survives session pruning: it is stored with the activity.
    await remoteWrite(db=>db.prepare("DELETE FROM remote_sessions WHERE client_id IN ('zc_test','zc_requester') AND session_id NOT IN (?,?)").run(sameAsCreator.sessionId,sameAsRequester.sessionId));
    const again=await f.session('zana-chatgpt','zc_test');
    assert.match((await f.call('zana_review_claim',{ticket:t.ticket},again)).error??'',/SAME_CLIENT/);
    const independent=await f.session('gpt-c','zc_reviewer');
    assert.equal((await f.call('zana_review_claim',{ticket:t.ticket},independent)).state,'CLAIMED');
  }finally{await f.cleanup();}
});
