// Etapa B, ronda de corrección 1: tests negativos de los CRITICAL/P1.
import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture,readDiff,sha} from './helpers/remote-fixture.mjs';

const clean=lens=>({lens,findings:[],evidence:['Read every diff page and the checks']});
const blocker={lens:'risk',findings:[{severity:'BLOCKER',location:'src/sum.mjs:3',evidence:'returns a-b'}],evidence:['diff']};
async function review(f,ticket,s,risk=clean('risk'),execution='PARALLEL_SUBAGENTS'){
  const claim=await f.call('zana_review_claim',{ticket},s);
  assert.equal(claim.error,undefined,claim.error);
  await readDiff(f.call,ticket,s);
  for(const l of [risk,clean('readability'),clean('reliability'),clean('resilience')]){
    const r=await f.call('zana_review_lens_submit',{ticket,...l},s);
    assert.equal(r.error,undefined,r.error);
  }
  const fin=await f.call('zana_review_finalize',{ticket,execution},s);
  assert.equal(fin.error,undefined,fin.error);
  return fin;
}
const outcome=s=>({success:true,summary:'done on '+s,evidence:['head '+s]});

test('C1: completed code unit + REQUEST_CHANGES -> correction unit -> new ticket -> APPROVE -> merge',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId,branch,packet}=await f.authorReady();
    // The author completes the code unit before review (allowed, but then no unit is RUNNING).
    const done=await f.call('zana_complete_unit',{unitId:'code',token:packet.token,leaseGeneration:packet.leaseGeneration,outcome:outcome(sha('a'))},author);
    assert.equal(done.error,undefined,done.error);
    const t1=await f.call('zana_review_request',{missionId},author);
    const r1=await review(f,t1.ticket,await f.session(),blocker);
    assert.equal(r1.event,'REQUEST_CHANGES');
    // Correction: a new PENDING code unit the author can start and write with.
    const corr=await f.call('zana_correction_start',{missionId},author);
    assert.equal(corr.error,undefined,corr.error);
    const batch=await f.call('zana_start_batch',{},author);
    const cp=batch.packets.find(p=>p.unitId===corr.unitId);
    assert.ok(cp,'correction unit started');
    const w=await f.call('zana_ds_github',{operation:'create_or_update_file',missionId,
      arguments:{owner:'o',repo:'r',branch,path:'src/sum.mjs',content:'a+b',message:'fix'}},author);
    assert.equal(Boolean(w.error||w.isError),false,JSON.stringify(w));
    f.api.state.push(branch,sha('b'));f.api.state.green(sha('b'));
    const t2=await f.call('zana_review_request',{missionId},author);
    assert.equal(t2.error,undefined,t2.error);
    assert.equal((await review(f,t2.ticket,await f.session())).event,'APPROVE');
    const c2=await f.call('zana_complete_unit',{unitId:corr.unitId,token:cp.token,leaseGeneration:cp.leaseGeneration,outcome:outcome(sha('b'))},author);
    assert.equal(c2.error,undefined,c2.error);
    assert.equal((await f.call('zana_merge',{missionId},author)).state,'MERGED');
  }finally{await f.cleanup();}
});
