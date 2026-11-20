// Regresiones: conversaciones abiertas tras APPROVE y adopción tras merge fallido.
import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture,readDiff,sha} from './helpers/remote-fixture.mjs';
import {remoteRead} from '../src/store.mjs';

const clean=lens=>({lens,findings:[],evidence:['revisé el diff completo']});
async function approved(f){
  const r=await f.authorReady();
  const t=await f.call('zana_review_request',{missionId:r.missionId},r.author);
  assert.equal(t.error,undefined,t.error);
  const reviewer=await f.session();
  assert.equal((await f.call('zana_review_claim',{ticket:t.ticket},reviewer)).state,'CLAIMED');
  await readDiff(f.call,t.ticket,reviewer);
  for(const lens of ['risk','readability','reliability','resilience'])
    assert.equal((await f.call('zana_review_lens_submit',{ticket:t.ticket,...clean(lens)},reviewer)).error,undefined);
  assert.equal((await f.call('zana_review_finalize',{ticket:t.ticket,execution:'SEQUENTIAL_SAME_CONVERSATION'},reviewer)).event,'APPROVE');
  return {...r,t};
}
const countUnits=()=>remoteRead(db=>JSON.parse(db.prepare('SELECT code_units FROM remote_missions LIMIT 1').get().code_units));

test('APPROVE + conversaciones abiertas crea fix-threads, usa presupuesto existente y bloquea entrega',async()=>{
  const f=await remoteFixture();
  try{
    const r=await approved(f);
    f.api.state.threads['7']=[false,true,false];
    const delivery=await f.call('zana_delivery_status',{missionId:r.missionId},r.author);
    assert.equal(delivery.unresolvedThreads,2);
    assert.equal(delivery.ready,false);
    assert.match(delivery.blockers.join(' '),/conversaciones/i);
    const c=await f.call('zana_correction_start',{missionId:r.missionId},r.author);
    assert.equal(c.error,undefined,c.error);
    assert.match(c.unitId,/^fix-threads-/);
    assert.equal(c.correctionBudget.maxLines,5);
    assert.match(await remoteRead((db,mission)=>mission.units.find(u=>u.id===c.unitId)?.instruction),/conversaciones abiertas/);
    assert.equal((await countUnits()).includes(c.unitId),true);
    f.api.state.push(r.branch,sha('b'));f.api.state.green(sha('b'));
    f.api.state.compareFiles=[{filename:'src/otro.mjs',additions:12,deletions:0,status:'modified'}];
    assert.match((await f.call('zana_review_request',{missionId:r.missionId},r.author)).error??'',/^CORRECTION_OUT_OF_SCOPE:/);
  }finally{await f.cleanup();}
});

test('APPROVE sin conversaciones abiertas no crea unidad ni inventa corrección',async()=>{
  const f=await remoteFixture();
  try{
    const r=await approved(f);
    const before=await countUnits();
    assert.match((await f.call('zana_correction_start',{missionId:r.missionId},r.author)).error??'',/^NO_CHANGES_REQUESTED:/);
    assert.deepEqual(await countUnits(),before);
    const status=await f.call('zana_delivery_status',{missionId:r.missionId},r.author);
    assert.equal(status.unresolvedThreads,0);
    assert.equal(status.ready,true);
  }finally{await f.cleanup();}
});

test('GitHub GraphQL caído: THREADS_UNAVAILABLE y ninguna unidad creada',async()=>{
  const f=await remoteFixture();
  try{
    const r=await approved(f);
    const before=await countUnits();
    f.api.state.failThreads={status:503,message:'service unavailable'};
    assert.match((await f.call('zana_correction_start',{missionId:r.missionId},r.author)).error??'',/^THREADS_UNAVAILABLE:/);
    assert.deepEqual(await countUnits(),before);
    const status=await f.call('zana_delivery_status',{missionId:r.missionId},r.author);
    assert.equal(status.ready,false);
    assert.equal(status.unresolvedThreads,null);
    assert.match(status.blockers.join(' '),/THREADS_UNAVAILABLE/);
  }finally{await f.cleanup();}
});

test('APPROVE con conversaciones respeta rondas agotadas y no duplica unidad',async()=>{
  const f=await remoteFixture();
  try{
    f.spec.budget={maxReviewRounds:1};
    const r=await approved(f);
    f.api.state.threads['7']=[false];
    assert.match((await f.call('zana_correction_start',{missionId:r.missionId},r.author)).error??'',/^REVIEW_ROUNDS_EXHAUSTED:/);
    assert.equal((await countUnits()).some(x=>x.startsWith('fix-threads-')),false);
  }finally{await f.cleanup();}
});

test('fallo HTTP 405 de merge libera adopción solo de la sesión responsable',async()=>{
  const f=await remoteFixture();
  try{
    const r=await approved(f);
    const adopter=await f.session();
    assert.equal((await f.call('zana_mission_adopt',{missionId:r.missionId},adopter)).adopted,true);
    const other=await f.session();
    assert.match((await f.call('zana_mission_adopt',{missionId:r.missionId},other)).error??'',/^ADOPT_MISSION_BUSY:/);
    f.api.state.mergeFailure={status:405,message:'All comments must be resolved'};
    assert.match((await f.call('zana_merge',{missionId:r.missionId},adopter)).error??'',/GitHub HTTP 405/);
    assert.equal((await f.call('zana_mission_adopt',{missionId:r.missionId},other)).adopted,true);
    const events=await remoteRead(db=>db.prepare("SELECT kind,session_id FROM remote_activity WHERE mission_id=? AND kind='MISSION_ADOPT_RELEASE'").all(r.missionId));
    assert.deepEqual(events.map(x=>x.session_id),[adopter.sessionId]);
  }finally{await f.cleanup();}
});

test('NOT_READY por conversaciones pendientes libera adopción tras rechazo del gate GitHub',async()=>{
  const f=await remoteFixture();
  try{
    const r=await approved(f);
    const adopter=await f.session(),other=await f.session();
    assert.equal((await f.call('zana_mission_adopt',{missionId:r.missionId},adopter)).adopted,true);
    f.api.state.threads['7']=[false];
    const refused=await f.call('zana_merge',{missionId:r.missionId},adopter);
    assert.equal(refused.state,'NOT_READY');
    assert.match(refused.blockers.join(' '),/conversaciones de revisión abiertas/);
    assert.equal((await f.call('zana_mission_adopt',{missionId:r.missionId},other)).adopted,true);
  }finally{await f.cleanup();}
});

test('merge exitoso NO libera adopción; otra sesión sigue bloqueada',async()=>{
  const f=await remoteFixture();
  try{
    const r=await approved(f);
    const adopter=await f.session(),other=await f.session();
    assert.equal((await f.call('zana_mission_adopt',{missionId:r.missionId},adopter)).adopted,true);
    assert.equal((await f.call('zana_merge',{missionId:r.missionId},adopter)).state,'MERGED');
    assert.match((await f.call('zana_mission_adopt',{missionId:r.missionId},other)).error??'',/^ADOPT_MISSION_BUSY:/);
    const n=await remoteRead(db=>db.prepare("SELECT COUNT(*) n FROM remote_activity WHERE mission_id=? AND kind='MISSION_ADOPT_RELEASE'").get(r.missionId).n);
    assert.equal(n,0);
  }finally{await f.cleanup();}
});
