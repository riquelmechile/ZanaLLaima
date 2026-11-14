import test from 'node:test';
import assert from 'node:assert/strict';
import {startDiscovery,answerDiscovery,draftProjectPlan} from '../src/project-discovery.mjs';
import * as api from '../src/project-orchestrator.mjs';
const base='a'.repeat(40), head='b'.repeat(40), merge='c'.repeat(40), now='2026-11-14T15:00:00.000Z', projectId='zp_1234567890abcdef';
const milestones=[{id:'discovery',objective:'Diseñar alcance',acceptance:'Plan aprobado',dependsOn:[]},
  {id:'code',objective:'Desarrollo',acceptance:'CI verde y 4R',dependsOn:['discovery']},
  {id:'delivery',objective:'Entrega',acceptance:'Integrado',dependsOn:['code']}];
const plan=(ms=milestones)=>draftProjectPlan({
  brief:answerDiscovery(startDiscovery('Sistema para registrar proyectos completos'),{
    goal:'Organizar el desarrollo',users:'Operadores',platform:'Web',features:'Misiones',data:'Sin datos privados'}),
  alternatives:[
    {id:'node',technology:'Node',rationale:'Integración',benefits:'Ecosistema',tradeoffs:'Runtime',sources:[{title:'Node',url:'https://nodejs.org/docs/',checkedOn:'2026-11-10'}]},
    {id:'go',technology:'Go',rationale:'Binario',benefits:'Concurrencia',tradeoffs:'Desarrollo',sources:[{title:'Go',url:'https://go.dev/doc/',checkedOn:'2026-11-10'}]},
  ],selectedId:'node',milestones:ms});
const init=(p=plan())=>api.initializeProjectRun(p,{projectId,approvedDigest:p.digest,repo:'riquelmechile/ZanaLLaima',base:'main',ownerClient:'cliente',workspaceId:'espacio',now});
const take=(s,m,id,final=true,extra={})=>api.claimMilestone(s,{milestoneId:m,missionId:id,final,baseSha:base,now,...extra});
const evidence={sha:head,ci:'SUCCESS',review:'APPROVED',merged:true,mergeCommitSha:merge};
const complete=(s,id,extra={})=>api.completePart(s,{missionId:id,prNumber:12,headSha:head,mergeCommitSha:merge,evidence,now,...extra});
const attach=(s,m,id,final=true,extra={})=>api.attachPart(s,{milestoneId:m,missionId:id,prNumber:12,headSha:head,mergeCommitSha:merge,final,evidence,now,...extra});
const release=(s,id,extra={})=>api.releaseMilestone(s,{missionId:id,reason:'Intento cancelado',now,...extra});
const bad=(code,fn)=>assert.throws(fn,e=>e?.code===code,code);
const broken=(s,edit)=>{const x=structuredClone(s);edit(x);bad('INVALID_PROJECT',()=>api.validateRun(x));};
test('inicio v2 estricto y estado congelado',()=>{
  const s=init();assert.equal(api.validateRun(s),s);assert.equal(s.schema,'zana.project-run.v2');assert.equal(s.repo,'riquelmechile/ZanaLLaima');
  assert.equal(s.base,'main');assert.equal(s.ownerClient,'cliente');assert.equal(s.workspaceId,'espacio');assert.equal(s.createdAt,now);
  assert.deepEqual(s.outsidePlan,[]);assert.deepEqual(s.milestones[0].parts,[]);assert.equal(s.milestones[0].running,null);
  assert.ok(Object.isFrozen(s.milestones[0].attempts));assert.equal(s.revision,0);
  bad('APPROVAL_REQUIRED',()=>api.initializeProjectRun(plan(),{projectId,approvedDigest:'x'}));
  bad('INVALID_PROJECT',()=>api.initializeProjectRun(plan(),{projectId:'no',approvedDigest:plan().digest}));
  bad('INVALID_PROJECT',()=>api.initializeProjectRun(plan(),{projectId,approvedDigest:plan().digest,now}));
});
test('dos partes, prioridad PARTIAL, DAG y estado terminal',()=>{
  const p=plan([{...milestones[0]},{...milestones[1],dependsOn:[]},milestones[2]]);let s=init(p);
  const original=s;s=take(s,'discovery','mission-one',false);assert.equal(original.revision,0);
  assert.equal(s.milestones[0].status,'RUNNING');assert.deepEqual(api.readyMilestones(s),[]);
  bad('MILESTONE_NOT_READY',()=>take(s,'code','mission-two'));
  s=complete(s,'mission-one');assert.equal(s.milestones[0].status,'PARTIAL');
  assert.deepEqual(api.readyMilestones(s).map(m=>[m.id,m.status,m.parts]),[['discovery','PARTIAL',1],['code','PENDING',0]]);
  const view=api.readyMilestones(s);view[0].attempts.push({});assert.equal(s.milestones[0].attempts.length,0);
  s=take(s,'discovery','mission-final');s=complete(s,'mission-final');assert.equal(s.milestones[0].status,'DONE');
  s=attach(s,'code','mission-code');s=attach(s,'delivery','mission-delivery');
  assert.equal(s.status,'READY_TO_DELIVER');assert.deepEqual(api.readyMilestones(s),[]);
  assert.equal(s.revision,6);assert.equal(s.updatedAt,now);assert.ok(Object.isFrozen(s.milestones[0].parts[0]));
  assert.equal(original.milestones[0].status,'PENDING');assert.equal(s.milestones[0].parts[0].final,false);
});
test('rechaza individualmente cada evidencia y conserva estado',()=>{
  const s=take(init(),'discovery','mission-one');
  for(const [key,value] of [['sha',base],['ci','PENDING'],['review','CHANGES_REQUESTED'],['merged',false],['mergeCommitSha',base]]){
    bad('EVIDENCE_NOT_READY',()=>complete(s,'mission-one',{evidence:{...evidence,[key]:value}}));
  }
  bad('EVIDENCE_NOT_READY',()=>complete(s,'mission-one',{evidence:null}));
  bad('INVALID_SHA',()=>complete(s,'mission-one',{headSha:'x'}));
  bad('MILESTONE_NOT_RUNNING',()=>complete(s,'wrong-id'));
  assert.equal(s.milestones[0].parts.length,0);
});
test('no repite misión en running, partes, intentos ni fuera de plan',()=>{
  let s=take(init(),'discovery','mission-one',false);
  bad('DUPLICATE_MISSION',()=>api.recordOutsidePlan(s,{missionId:'mission-one',reason:'Ya existe antes',now}));
  s=complete(s,'mission-one');bad('DUPLICATE_MISSION',()=>take(s,'discovery','mission-one'));
  s=take(s,'discovery','mission-two');s=release(s,'mission-two');
  bad('DUPLICATE_MISSION',()=>take(s,'discovery','mission-two'));
  s=api.recordOutsidePlan(s,{missionId:'mission-outside',reason:'Fusionada fuera',now});
  bad('DUPLICATE_MISSION',()=>take(s,'discovery','mission-outside'));
  bad('INVALID_ID',()=>take(s,'discovery','?'));bad('INVALID_ID',()=>api.recordOutsidePlan(s,{missionId:'?',reason:'Motivo válido',now}));
  bad('INVALID_FINAL',()=>take(s,'discovery','mission-three','sí'));
  bad('INVALID_SHA',()=>take(s,'discovery','mission-three',false,{baseSha:'x'}));
});
test('libera PENDING y PARTIAL, conserva últimos 20 intentos',()=>{
  let s=init();for(let i=0;i<23;i++){const id='retry-'+i;s=release(take(s,'discovery',id),id,{prNumber:i+1});}
  assert.equal(s.milestones[0].status,'PENDING');assert.equal(s.milestones[0].attempts.length,20);
  assert.equal(s.milestones[0].attempts[0].missionId,'retry-3');
  s=complete(take(s,'discovery','partial-one',false),'partial-one');
  s=release(take(s,'discovery','partial-two'),'partial-two');
  assert.equal(s.milestones[0].status,'PARTIAL');assert.equal(api.readyMilestones(s)[0].id,'discovery');
  bad('INVALID_REASON',()=>release(take(s,'discovery','bad-reason'),'bad-reason',{reason:'breve'}));
  bad('MILESTONE_NOT_RUNNING',()=>release(s,'missing'));
});
test('adjunta solo hitos listos, y retiene últimos 50 fuera del plan',()=>{
  let s=init();bad('MILESTONE_NOT_READY',()=>attach(s,'code','mission-not-ready'));
  bad('INVALID_FINAL',()=>attach(s,'discovery','mission-bad','no'));
  bad('EVIDENCE_NOT_READY',()=>attach(s,'discovery','mission-bad',true,{evidence:{...evidence,merged:false}}));
  s=attach(s,'discovery','mission-done');
  for(let i=0;i<53;i++)s=api.recordOutsidePlan(s,{missionId:'outside-'+i,reason:'Fuera de plan',now});
  assert.equal(s.outsidePlan.length,50);assert.equal(s.outsidePlan[0].missionId,'outside-3');
  bad('INVALID_REASON',()=>api.recordOutsidePlan(s,{missionId:'outside-more',reason:'corto',now}));
});
test('revision opcional y corridas terminales son inmutables',()=>{
  const s=init();bad('STALE_REVISION',()=>take(s,'discovery','one',true,{expectedRevision:1}));
  const started=take(s,'discovery','one');bad('STALE_REVISION',()=>complete(started,'one',{expectedRevision:0}));
  bad('STALE_REVISION',()=>release(started,'one',{expectedRevision:0}));
  bad('STALE_REVISION',()=>api.recordOutsidePlan(started,{missionId:'extra',reason:'Fuera del plan',expectedRevision:0,now}));
  bad('STALE_REVISION',()=>api.cancelProjectRun(started,{reason:'Proyecto cancelado',expectedRevision:0,now}));
  const cancelled=api.cancelProjectRun(started,{reason:'Proyecto cancelado',now});
  assert.equal(cancelled.reason,'Proyecto cancelado');assert.equal(cancelled.milestones[0].status,'RUNNING');
  for(const f of [()=>take(cancelled,'code','new'),()=>complete(cancelled,'one'),()=>release(cancelled,'one'),()=>attach(cancelled,'code','new'),()=>api.recordOutsidePlan(cancelled,{missionId:'extra',reason:'Fuera del plan',now})])bad('RUN_NOT_ACTIVE',f);
  bad('INVALID_STATE',()=>api.cancelProjectRun(cancelled,{reason:'Cancelar de nuevo',now}));
  let done=complete(started,'one');done=attach(done,'code','two');done=attach(done,'delivery','three');
  for(const f of [()=>take(done,'discovery','new'),()=>attach(done,'code','new'),()=>complete(done,'one'),()=>release(done,'one'),()=>api.recordOutsidePlan(done,{missionId:'extra',reason:'Fuera del plan',now})])bad('RUN_NOT_ACTIVE',f);
  bad('INVALID_STATE',()=>api.cancelProjectRun(done,{reason:'Cancelar de nuevo',now}));
});
test('validateRun rechaza invariantes estructurales uno por uno',()=>{
  const s=init(), running=take(s,'discovery','mission-one',false), partial=complete(running,'mission-one'), done=complete(take(s,'discovery','mission-one'),'mission-one'),delivered=attach(attach(done,'code','second'),'delivery','third');
  const checks=[[s,x=>x.schema='v1'],[s,x=>x.projectId='x'],[s,x=>x.repo='x'],[s,x=>x.planDigest='x'],
    [s,x=>x.revision=-1],[s,x=>x.updatedAt='ayer'],[s,x=>x.unknown=true],[s,x=>x.milestones[0].unknown=true],
    [s,x=>x.milestones[0].id='!'],[s,x=>x.milestones[1].id='discovery'],
    [s,x=>x.milestones[0].dependsOn=['missing']],[s,x=>x.milestones[0].dependsOn=['discovery']],
    [s,x=>x.milestones[0].dependsOn=['delivery']],[s,x=>x.milestones[0].status='RUNNING'],
    [s,x=>x.milestones[0].status='PARTIAL'],[s,x=>x.status='READY_TO_DELIVER'],
    [s,x=>x.reason='Motivo inválido'],[running,x=>x.milestones[1]={...x.milestones[1],status:'RUNNING',running:{...x.milestones[0].running,missionId:'other'}}],
    [running,x=>x.milestones[0].running.baseSha='x'],[running,x=>x.milestones[0].parts.push({missionId:'mission-one',prNumber:1,headSha:head,mergeCommitSha:merge,final:false,at:now})],
    [partial,x=>x.milestones[0].status='PENDING'],[partial,x=>x.milestones[0].parts[0].mergeCommitSha='x'],
    [done,x=>x.milestones[0].status='PARTIAL'],[done,x=>x.milestones[0].parts[0].prNumber=0],
    [s,x=>x.milestones[0].attempts=Array.from({length:21},(_,i)=>({missionId:'attempt-'+i,reason:'Intento válido',prNumber:null,at:now}))],
    [s,x=>x.outsidePlan=Array.from({length:51},(_,i)=>({missionId:'outside-'+i,reason:'Motivo válido',at:now}))],
    [s,x=>x.outsidePlan=[{missionId:'a',reason:'Motivo válido',at:now},{missionId:'a',reason:'Motivo válido',at:now}]],
    [delivered,x=>x.status='ACTIVE']];
  checks.forEach(([valid,edit],i)=>{assert.doesNotThrow(()=>api.validateRun(valid),String(i));broken(valid,edit);});
  const cancelled=api.cancelProjectRun(s,{reason:'Proyecto cancelado',now});
  broken(cancelled,x=>{delete x.reason;});broken(s,x=>{x.milestones[0].parts=[{missionId:'one',prNumber:1,headSha:head,mergeCommitSha:merge,final:true,at:now}];});
});
test('acepta UUID de misión y no cambia el estado anterior',()=>{
  const uuid='12345678-1234-4234-8234-123456789012',s=init(),v=take(s,'discovery',uuid);
  assert.equal(v.milestones[0].running.missionId,uuid);assert.equal(s.milestones[0].running,null);
  assert.ok(Object.isFrozen(v.milestones[0].running));assert.equal(complete(v,uuid).milestones[0].status,'DONE');
});

test('regresión A3 rojo: no acepta repo como arreglo',()=>{
  broken(init(),x=>{x.repo=['riquelmechile/ZanaLLaima'];});
});
