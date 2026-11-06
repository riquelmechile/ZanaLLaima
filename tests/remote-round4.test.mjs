// Etapa B, ronda de corrección 4: test negativo del P1 (merge con una foto vieja del ticket).
import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture,readDiff,sha} from './helpers/remote-fixture.mjs';
import {remoteWrite} from '../src/store.mjs';

const clean=lens=>({lens,findings:[],evidence:['read every page']});
async function approved(f){
  const r=await f.authorReady();
  const t=await f.call('zana_review_request',{missionId:r.missionId},r.author);
  const s=await f.session();
  assert.equal((await f.call('zana_review_claim',{ticket:t.ticket},s)).state,'CLAIMED');
  await readDiff(f.call,t.ticket,s);
  for(const l of ['risk','readability','reliability','resilience'])
    assert.equal((await f.call('zana_review_lens_submit',{ticket:t.ticket,...clean(l)},s)).error,undefined);
  assert.equal((await f.call('zana_review_finalize',{ticket:t.ticket,execution:'PARALLEL_SUBAGENTS'},s)).event,'APPROVE');
  return r;
}
// A new ticket appears (another process, no lock) while the merge reads GitHub.
function newTicketDuring(f,missionId,author,read){
  const target=f.runtime.github,real=target[read].bind(target);
  let fired=false;
  target[read]=async(...a)=>{
    const out=await real(...a);
    if(!fired){
      fired=true;
      const at=new Date(Date.now()+1000).toISOString();
      await remoteWrite(db=>db.prepare("INSERT INTO review_tickets(ticket_id,code_hash,mission_id,repo,pr_number,sha,author_session,created_at,expires_at,state,updated_at) VALUES('newer','h-newer',?,'o/r',7,?,?,?,?,'OPEN',?)")
        .run(missionId,sha('a'),author.sessionId,at,at,at));
    }
    return out;
  };
  return ()=>{target[read]=real;};
}

for(const read of ['checkRuns','pullReviews']){
  test('P1: zana_merge re-reads the current ticket after the GitHub reads and never merges on a stale one ('+read+')',async()=>{
    const f=await remoteFixture();
    try{
      const {author,missionId}=await approved(f);
      const restore=newTicketDuring(f,missionId,author,read);
      const r=await f.call('zana_merge',{missionId},author);
      restore();
      assert.equal(f.api.state.merges.length,0,'github.merge must not be called with a stale ticket');
      assert.equal(r.state,'NOT_READY',JSON.stringify(r));
    }finally{await f.cleanup();}
  });
}

test('P1: the operator remote-merge path re-reads the current ticket too',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId}=await approved(f);
    const restore=newTicketDuring(f,missionId,author,'statuses');
    const r=await f.runtime.ops.zana_merge({missionId},{operator:true,host:'operator',sessionId:'operator-cli'});
    restore();
    assert.equal(f.api.state.merges.length,0);
    assert.equal(r.state,'NOT_READY');
  }finally{await f.cleanup();}
});
