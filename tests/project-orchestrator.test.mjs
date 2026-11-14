import test from 'node:test';
import assert from 'node:assert/strict';
import {startDiscovery,answerDiscovery,draftProjectPlan} from '../src/project-discovery.mjs';
import {initializeProjectRun,readyMilestones,claimMilestone,completeMilestone,releaseMilestone,cancelProjectRun} from '../src/project-orchestrator.mjs';
const base='a'.repeat(40), head='b'.repeat(40);
const projectId='zp_1234567890abcdef';
const plan=()=>draftProjectPlan({
  brief:answerDiscovery(startDiscovery('Sistema para registrar proyectos completos'),{
    goal:'Organizar el desarrollo',users:'Operadores',platform:'Web',features:'Misiones',data:'Sin datos privados'}),
  alternatives:[
    {id:'node',technology:'Node',rationale:'Integración',benefits:'Ecosistema',tradeoffs:'Runtime',sources:[{title:'Node',url:'https://nodejs.org/docs/',checkedOn:'2026-11-10'}]},
    {id:'go',technology:'Go',rationale:'Binario',benefits:'Concurrencia',tradeoffs:'Desarrollo',sources:[{title:'Go',url:'https://go.dev/doc/',checkedOn:'2026-11-10'}]},
  ],selectedId:'node',milestones:[
    {id:'discovery',objective:'Diseñar alcance',acceptance:'Plan aprobado',dependsOn:[]},
    {id:'code',objective:'Desarrollo',acceptance:'CI verde y 4R',dependsOn:['discovery']},
    {id:'delivery',objective:'Entrega',acceptance:'Integrado',dependsOn:['code']},
  ],
});
const init=()=>initializeProjectRun(plan(),{projectId,approvedDigest:plan().digest});
const claim=(s,m,id)=>claimMilestone(s,{expectedRevision:s.revision,milestoneId:m,missionId:id,headSha:base});
const done=(s,m,id,verify=async()=>({sha:head,ci:'SUCCESS',review:'APPROVED',merged:true}))=>
  completeMilestone(s,{expectedRevision:s.revision,milestoneId:m,missionId:id,headSha:head},verify);
test('inicio exige aprobación de digest exacto y projectId',()=>{
  assert.equal(init().status,'ACTIVE');assert.deepEqual(readyMilestones(init()).map(x=>x.id),['discovery']);
  assert.throws(()=>initializeProjectRun(plan(),{projectId,approvedDigest:'x'}),/APPROVAL_REQUIRED/);
  assert.throws(()=>initializeProjectRun(plan(),{projectId:'invalid',approvedDigest:plan().digest}),/INVALID_PROJECT/);
});
test('hitos inmutables y un solo trabajo RUNNING',()=>{
  const a=init(),b=claim(a,'discovery','mission-one');
  assert.equal(a.revision,0);assert.equal(b.revision,1);
  assert.deepEqual(readyMilestones(b),[]);assert.ok(Object.isFrozen(b.milestones));
  assert.throws(()=>claim(b,'code','mission-two'),/MILESTONE_NOT_READY/);
});
test('no repite misión, no salta revisión ni SHA',async()=>{
  const s=claim(init(),'discovery','mission-one');
  await assert.rejects(done(s,'discovery','wrong-id'),/MILESTONE_NOT_RUNNING/);
  await assert.rejects(done(s,'discovery','mission-one',async()=>({sha:head,ci:'SUCCESS',review:'PENDING',merged:false})),/EVIDENCE_NOT_READY/);
  await assert.rejects(done(s,'discovery','mission-one',async()=>({sha:base,ci:'SUCCESS',review:'APPROVED',merged:true})),/EVIDENCE_NOT_READY/);
  await assert.rejects(done(s,'discovery','mission-one',null),/VERIFIER_REQUIRED/);
});
test('recorre DAG respetando cada cierre revisado y mergeado',async()=>{
  let s=claim(init(),'discovery','mission-one');s=await done(s,'discovery','mission-one');
  assert.deepEqual(readyMilestones(s).map(m=>m.id),['code']);
  s=claim(s,'code','mission-two');s=await done(s,'code','mission-two');
  s=claim(s,'delivery','mission-three');s=await done(s,'delivery','mission-three');
  assert.equal(s.status,'READY_TO_DELIVER');assert.deepEqual(readyMilestones(s),[]);
  assert.equal(s.milestones.every(x=>x.status==='DONE'),true);
});
test('control optimista rechaza lecturas antiguas y SHA falso',async()=>{
  let s=init();assert.throws(()=>claimMilestone(s,{expectedRevision:1,milestoneId:'discovery',missionId:'mission-one',headSha:base}),/STALE_REVISION/);
  assert.throws(()=>claimMilestone(s,{expectedRevision:0,milestoneId:'discovery',missionId:'mission-one',headSha:'x'}),/INVALID_SHA/);
  s=claim(s,'discovery','mission-one');
  await assert.rejects(completeMilestone(s,{expectedRevision:0,milestoneId:'discovery',missionId:'mission-one',headSha:head},async()=>true),/STALE_REVISION/);
});
test('cancelación requiere revisión actual y motivo',()=>{
  const a=init();assert.throws(()=>cancelProjectRun(a,{expectedRevision:1,reason:'Cancelado ahora'}),/STALE_REVISION/);
  assert.throws(()=>cancelProjectRun(a,{expectedRevision:0,reason:'x'}),/INVALID_REASON/);
  const b=cancelProjectRun(a,{expectedRevision:0,reason:'  Proyecto cancelado  '});
  assert.equal(b.status,'CANCELLED');assert.deepEqual(readyMilestones(b),[]);
  assert.throws(()=>cancelProjectRun(b,{expectedRevision:b.revision,reason:'Cancelado de nuevo'}),/INVALID_STATE/);
});

test('acepta missionId UUID real aunque comience por un dígito',async()=>{
  const uuid='12345678-1234-4234-8234-123456789012';
  const running=claim(init(),'discovery',uuid);
  assert.equal(running.milestones[0].missionId,uuid);
  const completed=await done(running,'discovery',uuid);
  assert.equal(completed.milestones[0].status,'DONE');
});

test('CANCELLED es terminal incluso ante una respuesta de revisión tardía',async()=>{
  const started=claim(init(),'discovery','mission-one');
  const cancelled=cancelProjectRun(started,{expectedRevision:started.revision,reason:'Cancelar el proyecto'});
  let called=false;
  await assert.rejects(completeMilestone(cancelled,{expectedRevision:cancelled.revision,
    milestoneId:'discovery',missionId:'mission-one',headSha:head},async()=>{called=true;return {sha:head,ci:'SUCCESS',review:'APPROVED',merged:true}}),/INVALID_STATE/);
  assert.equal(called,false);
  assert.equal(cancelled.status,'CANCELLED');
  assert.equal(cancelled.milestones[0].status,'RUNNING');
  await assert.rejects(releaseMilestone(cancelled,{expectedRevision:cancelled.revision,
    milestoneId:'discovery',missionId:'mission-one',reason:'Misión cancelada'},async()=>({missionId:'mission-one',status:'CANCELLED',activeUnits:false})),/INVALID_STATE/);
});

test('recuperación de hito bloqueado exige misión terminal comprobada y genera nuevo intento',async()=>{
  const state=claim(init(),'discovery','mission-one');
  const args={expectedRevision:state.revision,milestoneId:'discovery',missionId:'mission-one',reason:'Rondas de revisión agotadas'};
  const verify=async()=>({missionId:'mission-one',status:'REVIEW_ROUNDS_EXHAUSTED',activeUnits:false});
  const recovered=await releaseMilestone(state,args,verify);
  assert.equal(state.milestones[0].status,'RUNNING');
  assert.equal(recovered.revision,state.revision+1);
  assert.equal(recovered.milestones[0].status,'PENDING');
  assert.deepEqual(recovered.milestones[0].attempts,[{missionId:'mission-one',reason:args.reason}]);
  assert.deepEqual(readyMilestones(recovered).map(x=>x.id),['discovery']);
  assert.throws(()=>claim(recovered,'discovery','mission-one'),/DUPLICATE_MISSION/);
  const retried=claim(recovered,'discovery','mission-two');
  assert.equal(retried.milestones[0].missionId,'mission-two');
  assert.equal((await done(retried,'discovery','mission-two')).milestones[0].status,'DONE');
});

test('fallo de misión no libera hito si existe actividad, no hay prueba o difiere su identidad',async()=>{
  const s=claim(init(),'discovery','mission-one');
  const args={expectedRevision:s.revision,milestoneId:'discovery',missionId:'mission-one',reason:'Fallo antes del merge'};
  for(const outcome of [
    {missionId:'other',status:'CANCELLED',activeUnits:false},
    {missionId:'mission-one',status:'ACTIVE',activeUnits:false},
    {missionId:'mission-one',status:'CANCELLED',activeUnits:true},
    {missionId:'mission-one',status:'REVIEW_ROUNDS_EXHAUSTED'}
  ])await assert.rejects(releaseMilestone(s,args,async()=>outcome),/RECOVERY_NOT_ALLOWED/);
  await assert.rejects(releaseMilestone(s,args,null),/VERIFIER_REQUIRED/);
  await assert.rejects(releaseMilestone(s,{...args,expectedRevision:0},async()=>true),/STALE_REVISION/);
  await assert.rejects(releaseMilestone(s,{...args,reason:'x'},async()=>true),/INVALID_REASON/);
  assert.equal(s.milestones[0].status,'RUNNING');
});

// Contrato v2 exigido por el PR A; falla por aserción hasta implementar la API.
import * as v2 from '../src/project-orchestrator.mjs';
test('API v2 presente antes de habilitar el flujo',()=>{
  assert.equal(typeof v2.validateRun,'function');
  assert.equal(typeof v2.attachPart,'function');
  assert.equal(typeof v2.completePart,'function');
});
