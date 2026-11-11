import test from 'node:test';
import assert from 'node:assert/strict';
import {assessProjectDelivery,authorizeProjectDelivery} from '../src/project-delivery.mjs';
import {createProjectEvent,verifyProjectEvent} from '../src/project-events.mjs';
const sha='a'.repeat(40),other='b'.repeat(40),secret='this-is-only-a-test-event-secret-value';
const state=()=>({schema:'zana.project-run.v1',status:'READY_TO_DELIVER',
  projectId:'zp_1234567890abcdef',planDigest:'c'.repeat(64),
  milestones:[{id:'final',status:'DONE',headSha:sha}]});
const proof=()=>({sha,ci:'SUCCESS',review:'APPROVED',mergeable:null,merged:true,integrationVerified:true});
const assess=(s=state(),v=async()=>proof(),expectedSha=sha)=>assessProjectDelivery(s,{repo:'riquelmechile/ZanaLLaima',expectedSha},v);
test('entrega exige todos los hitos, SHA válidos y callback verificable',async()=>{
  await assert.rejects(assess({...state(),status:'ACTIVE'}),/PROJECT_INCOMPLETE/);
  await assert.rejects(assess(state(),async()=>proof(),other),/DELIVERY_NOT_READY/);
  await assert.rejects(assess(state(),null),/VERIFIER_REQUIRED/);
  await assert.rejects(assess({...state(),milestones:[{id:'x',status:'DONE',headSha:'not-a-sha'}]}),/INVALID_DELIVERY_MILESTONES/);
});
test('CI, 4R, merge y SHA se verifican otra vez',async()=>{
  for(const key of ['sha','ci','review','merged','integrationVerified']){
    const bad={...proof(),[key]:key==='sha'?other:false};
    await assert.rejects(assess(state(),async()=>bad),/DELIVERY_NOT_READY/);
  }
  const ticket=await assess();assert.equal(ticket.deploymentAuthorized,false);
  assert.equal(ticket.source,'VERIFIED_BACKEND');
});
test('operador autoriza efecto y destino exactos, sin ejecutar despliegue',async()=>{
  const t=await assess();
  await assert.rejects(authorizeProjectDelivery(t,{target:'oracle'},async()=>false),/OPERATOR_APPROVAL_REQUIRED/);
  await assert.rejects(authorizeProjectDelivery(t,{target:'oracle'},null),/VERIFIER_REQUIRED/);
  await assert.rejects(authorizeProjectDelivery(t,{target:'invalid host!'},async()=>true),/INVALID_TARGET/);
  const a=await authorizeProjectDelivery(t,{target:'oracle',kind:'deployment'},async x=>x.sha===sha);
  assert.equal(a.state,'AUTHORIZED_NOT_EXECUTED');assert.equal(a.mustReverifyBeforeEffect,true);
});
test('evento firmado es solo notificación y consume el ID una vez',async()=>{
  const event=createProjectEvent({type:'CI_FINISHED',projectId:'zp_1234567890abcdef',sha},secret);
  let seen=false;const consume=async()=>{if(seen)return false;seen=true;return true};
  const result=await verifyProjectEvent(event,secret,{now:Date.parse(event.at),consume});
  assert.equal(result.notificationOnly,true);
  await assert.rejects(verifyProjectEvent(event,secret,{now:Date.parse(event.at),consume}),/EVENT_DUPLICATE/);
});
test('eventos adulterados, caducados o sin deduplicación no se aceptan',async()=>{
  const event=createProjectEvent({type:'REVIEW_READY',projectId:'zp_1234567890abcdef'},secret);
  const now=Date.parse(event.at);
  await assert.rejects(verifyProjectEvent({...event,type:'APPROVAL_NEEDED'},secret,{now,consume:async()=>true}),/INVALID_SIGNATURE/);
  await assert.rejects(verifyProjectEvent(event,secret,{now:now+3600000,consume:async()=>true}),/EVENT_EXPIRED/);
  await assert.rejects(verifyProjectEvent(event,secret,{now}),/EVENT_DEDUP_REQUIRED/);
  assert.throws(()=>createProjectEvent({type:'delete_everything',projectId:'zp_1234567890abcdef'},secret),/INVALID_EVENT/);
  assert.throws(()=>createProjectEvent({type:'CI_FINISHED',projectId:'zp_1234567890abcdef'},'short'),/EVENT_SECRET_REQUIRED/);
});

test('integración de hitos en DAG acepta SHA final distinto al último del arreglo',async()=>{
  const integration='d'.repeat(40);
  const run={...state(),milestones:[
    {id:'backend',status:'DONE',headSha:other},
    {id:'frontend',status:'DONE',headSha:sha}
  ]};
  let received=null;
  const verified=async args=>{received=args;return {...proof(),sha:integration,mergeable:null};};
  const ticket=await assess(run,verified,integration);
  assert.equal(ticket.sha,integration);
  assert.deepEqual(received.milestoneHeads,[{id:'backend',sha:other},{id:'frontend',sha}]);
  await assert.rejects(assess(run,async()=>({...proof(),sha:integration,
    integrationVerified:false}),integration),/DELIVERY_NOT_READY/);
});
test('un PR ya mergeado con mergeable:null puede entregar con CI, 4R e integración comprobada',async()=>{
  const final=await assess(state(),async()=>({...proof(),mergeable:null,merged:true}));
  assert.equal(final.state,'READY_FOR_OPERATOR');
  await assert.rejects(assess(state(),async()=>({...proof(),merged:false,mergeable:true})),/DELIVERY_NOT_READY/);
});
