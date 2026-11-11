import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFourReviewPackets,validateReviewFindingPacket,verifyIndependentReview,REVIEW_LENSES} from '../src/project-review-delegation.mjs';
const sha='a'.repeat(40),baseSha='b'.repeat(40);
const params=()=>({ticket:'ZR-AAAA-BBBB-CCCC-DDDD',repo:'riquelmechile/ZanaLLaima',prNumber:12,
  sha,baseSha,spec:'Cambiar solo un endpoint con tests',diff:'diff --git a/src/a.mjs b/src/a.mjs\n+const a = 1;',
  checks:{sha,state:'SUCCESS'},prBody:'Risk: public-contract',
  skills:Object.fromEntries(REVIEW_LENSES.map(l=>[l,'Aplica los criterios de revisión '+l+' de forma independiente.']))});
const packages=()=>buildFourReviewPackets(params());
const response=p=>({lens:p.lens,payloadHash:p.payloadHash,sha:p.sha,findings:[],evidence:['Leí el diff completo y verifiqué las líneas cambiadas']});
const session=()=>({authorSession:{id:'author',clientId:'a'},reviewSession:{id:'reviewer',clientId:'r',wrote:false,createdAt:'2026-11-11T01:00:00Z'},ticketCreatedAt:'2026-11-11T00:30:00Z'});
test('genera cuatro paquetes separados con skills propias y SHA exacto',()=>{
  const list=packages();assert.deepEqual(list.map(x=>x.lens),REVIEW_LENSES);
  assert.equal(list.every(x=>x.sha===sha&&x.diff===params().diff),true);
  assert.notEqual(list[0].payloadHash,list[1].payloadHash);
  assert.equal(Object.isFrozen(list[0]),true);
});
test('rechaza checks rojos, SHA distinto y skills incompletas',()=>{
  assert.throws(()=>buildFourReviewPackets({...params(),checks:{state:'FAILURE',sha}}),/CHECKS_NOT_GREEN/);
  assert.throws(()=>buildFourReviewPackets({...params(),checks:{state:'SUCCESS',sha:baseSha}}),/CHECKS_NOT_GREEN/);
  assert.throws(()=>buildFourReviewPackets({...params(),skills:{risk:'x'}}),/INCOMPLETE_REVIEW_SKILLS/);
});
test('un reporte necesita identidad de lente, digest y evidencia',()=>{
  const p=packages()[0];assert.equal(validateReviewFindingPacket(p,response(p)),true);
  assert.throws(()=>validateReviewFindingPacket(p,{...response(p),sha:baseSha}),/STALE_REVIEW_PACKET/);
  assert.throws(()=>validateReviewFindingPacket(p,{...response(p),lens:'resilience'}),/STALE_REVIEW_PACKET/);
  assert.throws(()=>validateReviewFindingPacket(p,{...response(p),evidence:[]}),/INVALID_FINDINGS/);
});
test('una modificación del paquete invalida cualquier reporte anterior',()=>{
  const p=packages()[0];assert.throws(()=>validateReviewFindingPacket({...p,diff:'changed'},response(p)),/REVIEW_PACKET_TAMPERED/);
});
test('sesión nueva, sin escrituras y backend verificado no autoriza publicar por sí sola',async()=>{
  const r=await verifyIndependentReview(session(),async()=>true);
  assert.equal(r.verified,true);assert.equal(r.canPublish,false);
});
test('prohíbe misma sesión, revisión autora y sesiones anteriores al ticket',async()=>{
  const x=session();
  await assert.rejects(verifyIndependentReview({...x,reviewSession:{...x.reviewSession,id:'author'}},async()=>true),/REVIEWER_NOT_INDEPENDENT/);
  await assert.rejects(verifyIndependentReview({...x,reviewSession:{...x.reviewSession,wrote:true}},async()=>true),/REVIEWER_NOT_INDEPENDENT/);
  const {wrote:unknown,...unverified}=x.reviewSession;
  await assert.rejects(verifyIndependentReview({...x,reviewSession:unverified},async()=>true),/REVIEWER_NOT_INDEPENDENT/);
  await assert.rejects(verifyIndependentReview({...x,reviewSession:{...x.reviewSession,createdAt:'2026-11-11T00:20:00Z'}},async()=>true),/REVIEWER_PREDATES_TICKET/);
});
test('distinto cliente OAuth cuando se requiere y verificador obligatorio',async()=>{
  const x=session();
  await assert.rejects(verifyIndependentReview({...x,reviewerClientRequired:true,reviewSession:{...x.reviewSession,clientId:'a'}},async()=>true),/SAME_CLIENT/);
  await assert.rejects(verifyIndependentReview(x,null),/VERIFIER_REQUIRED/);
  await assert.rejects(verifyIndependentReview(x,async()=>false),/ACTOR_NOT_VERIFIED/);
});
