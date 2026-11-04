import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMission,startBatch,completeUnit} from '../src/core.mjs';
import {cancelMission} from '../src/lifecycle.mjs';
import {openReview,startReviewBatch,submitReview,reviewStatus} from '../src/review.mjs';
import {transact,readState,archiveMission,readMissionArchive} from '../src/store.mjs';

const SHA='a'.repeat(40);
const outcome={success:true,summary:'Inspected code fixture for cancellation',
  evidence:['Verified read unit before starting the review']};
const make=()=>createMission({
  objective:'Cancel an abandoned review safely',
  authorization:{writesAllowed:false,allowedPaths:[]},
  units:[{id:'read',effect:'READ',instruction:'Inspect code before review'}]
});
function completeRead(m){
  const p=startBatch(m).batch.packets[0];
  completeUnit(m,p.unitId,p.token,outcome,p.leaseGeneration);
}
test('cancel invalidates running review packet and rejects its stale completion',()=>{
  const m=make();
  completeRead(m);
  openReview(m,{candidateSha:SHA});
  const packet=startReviewBatch(m).packets[0];
  assert.equal(m.review.lenses[0].state,'RUNNING');
  const finished=cancelMission(m);
  assert.equal(finished.status,'CANCELLED');
  assert.equal(m.review.state,'INVALIDATED');
  assert.equal(m.review.invalidatedReason,'MISSION_CANCELLED');
  assert.equal(m.review.lenses[0].state,'INVALIDATED');
  assert.equal(m.review.lenses[0].run,null);
  assert.equal(reviewStatus(m).gate,'INVALIDATED_CANDIDATE');
  assert.throws(()=>submitReview(m,{lensId:packet.lensId,token:packet.token,
    candidateSha:SHA,verdict:'PASS',summary:'Obsolete completion',
    evidence:['This packet was invalidated by cancellation']}),/No active review/);
  assert.throws(()=>cancelMission(m),/Mission not active/);
});
test('cancelling review preserves finished lens evidence and invalidates only active packets',()=>{
  const m=make();completeRead(m);openReview(m,{candidateSha:SHA});
  const first=startReviewBatch(m).packets[0];
  submitReview(m,{lensId:first.lensId,token:first.token,candidateSha:SHA,
    verdict:'PASS',summary:'First lens has genuine retained evidence',
    evidence:['Inspected fixture and confirmed test expectations']});
  const second=startReviewBatch(m).packets[0];
  cancelMission(m);
  assert.equal(m.review.lenses[0].state,'DONE');
  assert.equal(m.review.lenses[0].result.verdict,'PASS');
  assert.equal(m.review.lenses[1].state,'INVALIDATED');
  assert.equal(m.review.lenses[1].run,null);
  assert.throws(()=>submitReview(m,{lensId:second.lensId,token:second.token,
    candidateSha:SHA,verdict:'PASS',summary:'Cancelled result',
    evidence:['Not eligible after cancellation']}),/No active review/);
});
test('SQLite can archive a cancelled mission even if a review packet was abandoned',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zana-cancel-review-'));
  const file=join(dir,'state.json');
  try{
    await transact(()=>make(),file);
    let packet;
    await transact(m=>{
      completeRead(m);
      openReview(m,{candidateSha:SHA});
      packet=startReviewBatch(m).packets[0];
      return m;
    },file);
    await assert.rejects(archiveMission(file),/closed or cancelled/);
    await transact(m=>{cancelMission(m);return m;},file);
    const m=await readState(file);
    assert.equal(m.status,'CANCELLED');
    assert.equal(m.review.state,'INVALIDATED');
    assert.equal(m.review.lenses[0].run,null);
    await assert.rejects(transact(m=>{
      submitReview(m,{lensId:packet.lensId,token:packet.token,candidateSha:SHA,
        verdict:'PASS',summary:'Stale after cancellation',
        evidence:['A canceled review cannot accept its old token']});return m;
    },file),/No active review/);
    const archived=await archiveMission(file);
    assert.equal(archived.archived,true);
    const history=await readMissionArchive({limit:5},file);
    assert.equal(history.items.length,1);
    assert.equal(history.items[0].status,'CANCELLED');
  }finally{await rm(dir,{recursive:true,force:true});}
});
