import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture,sha,readDiff} from './helpers/remote-fixture.mjs';

test('CI de repo: dispara workflow propio, exige sus jobs y preserva SHA',async()=>{
  const envExtra={ZANA_REPO_CHECKS_JSON:JSON.stringify({'o/r':{
    workflow:'zana-python.yml',requiredChecks:['pytest']}})};
  const f=await remoteFixture({envExtra});
  try{
    const {author,missionId,branch,packet}=await f.authorReady({green:false});
    const check=await f.call('zana_checks_start',{missionId},author);
    assert.equal(check.workflow,'zana-python.yml');
    assert.equal(check.sha,sha('a'));
    assert.deepEqual(f.api.state.dispatches,[{workflow:'zana-python.yml',ref:branch}]);
    f.api.state.green(sha('a'),'test');
    const missing=await f.call('zana_checks_status',{checkId:check.checkId},author);
    assert.equal(missing.state,'PENDING');
    assert.deepEqual(missing.missing,['pytest']);
    f.api.state.green(sha('a'),'pytest');
    const green=await f.call('zana_checks_status',{checkId:check.checkId},author);
    assert.equal(green.state,'SUCCESS');
    assert.equal(green.sha,sha('a'));
    const done=await f.call('zana_complete_unit',{unitId:'code',token:packet.token,
      leaseGeneration:packet.leaseGeneration,outcome:{success:true,summary:'CI por repo',evidence:['pytest verde'] }},author);
    assert.equal(done.error,undefined);
  }finally{await f.cleanup();}
});

async function completeReviewedMission(f){
  const {author,missionId,packet}=await f.authorReady({green:false});
  f.api.state.green(sha('a'),'pytest');
  const started=await f.call('zana_checks_start',{missionId},author);
  assert.equal(started.workflow,'zana-python.yml');
  assert.equal((await f.call('zana_checks_status',{checkId:started.checkId},author)).state,'SUCCESS');
  const done=await f.call('zana_complete_unit',{unitId:packet.unitId,token:packet.token,
    leaseGeneration:packet.leaseGeneration,outcome:{success:true,summary:'Trabajo probado',
      evidence:['pytest aprobado en sha exacto']}},author);
  assert.equal(done.error,undefined,done.error);
  const request=await f.call('zana_review_request',{missionId},author);
  assert.equal(request.error,undefined,request.error);
  const reviewer=await f.session();
  const claim=await f.call('zana_review_claim',{ticket:request.ticket},reviewer);
  assert.equal(claim.error,undefined,claim.error);
  await readDiff(f.call,request.ticket,reviewer);
  for(const lens of ['risk','readability','reliability','resilience']){
    const submitted=await f.call('zana_review_lens_submit',{ticket:request.ticket,lens,
      findings:[],evidence:['Diff completo de la rama y CI pytest verificados']},reviewer);
    assert.equal(submitted.error,undefined,submitted.error);
  }
  const reviewed=await f.call('zana_review_finalize',{ticket:request.ticket,
    execution:'SEQUENTIAL_SAME_CONVERSATION'},reviewer);
  assert.equal(reviewed.event,'APPROVE',reviewed.error);
  return {author,missionId};
}

test('CRITICAL regresión A: override pytest prevalece sobre check global hasta el gate de merge',async()=>{
  const f=await remoteFixture({envExtra:{
    ZANA_REQUIRED_CHECKS:'test',
    ZANA_REPO_CHECKS_JSON:JSON.stringify({'o/r':{workflow:'zana-python.yml',requiredChecks:['pytest']}})
  }});
  try{
    const {author,missionId}=await completeReviewedMission(f);
    const status=await f.call('zana_delivery_status',{missionId},author);
    assert.equal(status.ci.state,'SUCCESS',JSON.stringify(status.ci));
    assert.deepEqual(status.ci.missing,[]);
    assert.equal(status.ready,true,JSON.stringify(status.blockers));
    const merged=await f.call('zana_merge',{missionId},author);
    assert.equal(merged.state,'MERGED',JSON.stringify(merged));
    assert.equal(f.api.state.merges.length,1);
  }finally{await f.cleanup();}
});

test('CRITICAL regresión B: check ajeno nunca habilita merge si falta pytest obligatorio',async()=>{
  const f=await remoteFixture({envExtra:{
    ZANA_REQUIRED_CHECKS:'',
    ZANA_REPO_CHECKS_JSON:JSON.stringify({'o/r':{workflow:'zana-python.yml',requiredChecks:['pytest']}})
  }});
  try{
    const {author,missionId}=await completeReviewedMission(f);
    // El revisor aprobó el SHA; un check del mismo SHA no reemplaza el job requerido.
    f.api.state.checkRuns[sha('a')]=[];
    f.api.state.green(sha('a'),'lint');
    const status=await f.call('zana_delivery_status',{missionId},author);
    assert.equal(status.ci.state,'PENDING');
    assert.deepEqual(status.ci.missing,['pytest']);
    assert.equal(status.ready,false);
    const refused=await f.call('zana_merge',{missionId},author);
    assert.equal(refused.state,'NOT_READY');
    assert.ok(refused.blockers.some(b=>/CI on .*PENDING/.test(b)),JSON.stringify(refused));
    assert.equal(f.api.state.merges.length,0);
  }finally{await f.cleanup();}
});

test('override de workflow: downstream solo permite el workflow efectivo del repositorio',async()=>{
  const f=await remoteFixture({envExtra:{
    ZANA_REPO_CHECKS_JSON:JSON.stringify({'o/r':{workflow:'zana-python.yml',requiredChecks:['pytest']}})
  }});
  try{
    const {author,missionId,branch}=await f.authorReady({green:false});
    const args={owner:'o',repo:'r',method:'run_workflow',ref:branch};
    const expected=await f.call('zana_ds_github',{missionId,operation:'actions_run_trigger',
      arguments:{...args,workflow_id:'zana-python.yml'}},author);
    assert.equal(expected.error,undefined,expected.error);
    const wrong=await f.call('zana_ds_github',{missionId,operation:'actions_run_trigger',
      arguments:{...args,workflow_id:'zana-checks.yml'}},author);
    assert.match(wrong.error,/WORKFLOW_NOT_ALLOWED/);
  }finally{await f.cleanup();}
});
