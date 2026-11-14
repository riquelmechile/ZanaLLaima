import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
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
const prOf=id=>parseInt(createHash('sha256').update(id).digest('hex').slice(0,7),16)+1;
const mergeOf=id=>createHash('sha256').update('merge:'+id).digest('hex').slice(0,40);
const proof=id=>({...evidence,mergeCommitSha:mergeOf(id)});
const complete=(s,id,extra={})=>api.completePart(s,{missionId:id,prNumber:prOf(id),headSha:head,mergeCommitSha:mergeOf(id),evidence:proof(id),now,...extra});
const attach=(s,m,id,final=true,extra={})=>api.attachPart(s,{milestoneId:m,missionId:id,prNumber:prOf(id),headSha:head,mergeCommitSha:mergeOf(id),final,evidence:proof(id),now,...extra});
const release=(s,id,extra={})=>api.releaseMilestone(s,{missionId:id,reason:'Intento cancelado',now,...extra});
const bad=(code,fn)=>assert.throws(fn,e=>e?.code===code,code);
const broken=(s,edit)=>{const x=structuredClone(s);edit(x);bad('INVALID_PROJECT',()=>api.validateRun(x));};
test('inicio v2 estricto y estado congelado',()=>{
  const s=init();assert.equal(api.validateRun(s),s);assert.equal(s.schema,'zana.project-run.v2');assert.equal(s.repo,'riquelmechile/ZanaLLaima');
  assert.equal(s.base,'main');assert.equal(s.ownerClient,'cliente');assert.equal(s.workspaceId,'espacio');assert.equal(s.createdAt,now);
  assert.deepEqual(s.outsidePlan,[]);assert.deepEqual(s.milestones[0].parts,[]);assert.equal(s.milestones[0].running,null);
  assert.ok(Object.isFrozen(s.milestones[0].attempts));assert.equal(s.revision,0);
  bad('APPROVAL_REQUIRED',()=>api.initializeProjectRun(plan(),{projectId,approvedDigest:'x'}));
  bad('INVALID_ID',()=>api.initializeProjectRun(plan(),{projectId:'no',approvedDigest:plan().digest}));
  bad('INVALID_REPO',()=>api.initializeProjectRun(plan(),{projectId,approvedDigest:plan().digest,now}));
});
test('dos partes, prioridad PARTIAL, DAG y estado terminal',()=>{
  const p=plan([{...milestones[0]},{...milestones[1],dependsOn:[]},milestones[2]]);let s=init(p);
  const original=s;s=take(s,'discovery','mission-one',false);assert.equal(original.revision,0);
  assert.equal(s.milestones[0].status,'RUNNING');assert.deepEqual(api.readyMilestones(s),[]);
  bad('MILESTONE_NOT_READY',()=>take(s,'code','mission-two'));
  s=complete(s,'mission-one');assert.equal(s.milestones[0].status,'PARTIAL');
  assert.deepEqual(api.readyMilestones(s).map(m=>[m.id,m.status,m.parts]),[['discovery','PARTIAL',1],['code','PENDING',0]]);
  const view=api.readyMilestones(s);assert.ok(Object.isFrozen(view[0])&&Object.isFrozen(view[0].attempts));
  s=take(s,'discovery','mission-final');s=complete(s,'mission-final');assert.equal(s.milestones[0].status,'DONE');
  s=attach(s,'code','mission-code');s=attach(s,'delivery','mission-delivery');
  assert.equal(s.status,'READY_TO_DELIVER');assert.deepEqual(api.readyMilestones(s),[]);
  assert.equal(s.revision,6);assert.equal(s.updatedAt,now);assert.ok(Object.isFrozen(s.milestones[0].parts[0]));
  assert.equal(original.milestones[0].status,'PENDING');assert.equal(s.milestones[0].parts[0].final,false);
});
test('rechaza individualmente cada evidencia y conserva estado',()=>{
  const s=take(init(),'discovery','mission-one');
  for(const [key,value] of [['sha',base],['ci','PENDING'],['review','CHANGES_REQUESTED'],['merged',false],['mergeCommitSha',base]]){
    bad('EVIDENCE_NOT_READY',()=>complete(s,'mission-one',{evidence:{...proof('mission-one'),[key]:value}}));
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
  assert.equal(cancelled.reason,'Proyecto cancelado');assert.equal(cancelled.milestones[0].status,'PENDING');
  assert.equal(cancelled.milestones[0].running,null);assert.equal(cancelled.milestones[0].attempts[0].missionId,'one');
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

test('A3: tipos y evidencias propios, matriz positiva/negativa',()=>{
  const s=init(), running=take(s,'discovery','typed-run'),part=complete(running,'typed-run');
  const attempt=release(take(s,'discovery','typed-attempt'),'typed-attempt');
  const outside=api.recordOutsidePlan(s,{missionId:'typed-outside',reason:'Razón válida',now});
  for(const [key,value] of [['projectId',[projectId]],['repo',['riquelmechile/ZanaLLaima']],
    ['planDigest',[s.planDigest]],['base',['main']],['ownerClient',{x:1}],['workspaceId',['espacio']],
    ['createdAt',[now]],['updatedAt',[now]]])broken(s,x=>{x[key]=value;});
  for(const [state,edit] of [
    [running,x=>x.milestones[0].running.baseSha=[base]],
    [running,x=>x.milestones[0].running.at=[now]],
    [part,x=>x.milestones[0].parts[0].headSha=[head]],
    [part,x=>x.milestones[0].parts[0].mergeCommitSha=[mergeOf('typed-run')]],
    [part,x=>x.milestones[0].parts[0].at=[now]],
    [attempt,x=>x.milestones[0].attempts[0].reason=['Intento cancelado']],
    [outside,x=>x.outsidePlan[0].reason=['Fuera del plan']],
    [running,x=>x.milestones[0].running.unknown=1],
    [part,x=>x.milestones[0].parts[0].unknown=1],
    [attempt,x=>x.milestones[0].attempts[0].unknown=1],
    [outside,x=>x.outsidePlan[0].unknown=1]]){assert.doesNotThrow(()=>api.validateRun(state));broken(state,edit);}
  for(const badSha of [[head],head.toUpperCase(),head.slice(1)])bad('INVALID_SHA',()=>complete(running,'typed-run',{headSha:badSha}));
  bad('INVALID_SHA',()=>take(s,'discovery','another',true,{baseSha:[base]}));
  bad('EVIDENCE_NOT_READY',()=>complete(running,'typed-run',{evidence:Object.create(proof('typed-run'))}));
  bad('EVIDENCE_NOT_READY',()=>complete(running,'typed-run',{evidence:{...proof('typed-run'),merged:1}}));
});
test('A3: PR/merge únicos, dependencias y estado DONE',()=>{
  const s=complete(take(init(),'discovery','unique-one'),'unique-one');
  bad('DUPLICATE_PR',()=>attach(s,'code','unique-two',true,{prNumber:prOf('unique-one')}));
  bad('DUPLICATE_PR',()=>attach(s,'code','unique-two',true,{mergeCommitSha:mergeOf('unique-one'),
    evidence:{...proof('unique-two'),mergeCommitSha:mergeOf('unique-one')}}));
  const two=attach(s,'code','unique-two');
  broken(two,x=>{x.milestones[1].parts[0].prNumber=prOf('unique-one');});
  broken(two,x=>{x.milestones[1].parts[0].mergeCommitSha=mergeOf('unique-one');});
  broken(two,x=>{x.milestones[0].status='PENDING';x.milestones[0].parts=[];});
  broken(init(),x=>{x.milestones[2].id='discovery';});
  broken(init(),x=>{x.milestones[1].dependsOn=['discovery','discovery'];});
  let parts=complete(take(init(),'discovery','intermediate',false),'intermediate');
  parts=complete(take(parts,'discovery','terminal'),'terminal');
  assert.equal(parts.milestones[0].status,'DONE');
  broken(parts,x=>{x.milestones[0].parts[0].final=true;});
  broken(parts,x=>{x.milestones[0].parts.at(-1).final=false;});
});
test('A3: misión, recuperación y cancelación con misión viva',()=>{
  let s=release(take(init(),'discovery','CASE-one'),'CASE-one');
  bad('DUPLICATE_MISSION',()=>take(s,'discovery','case-one'));
  s=attach(s,'discovery','CASE-one',false);
  assert.equal(s.milestones[0].status,'PARTIAL');assert.equal(s.milestones[0].attempts.length,0);
  bad('DUPLICATE_MISSION',()=>attach(s,'discovery','case-one'));
  const independent=plan([{...milestones[0]},{...milestones[1],dependsOn:[]},milestones[2]]);
  let other=release(take(init(independent),'code','taken-elsewhere'),'taken-elsewhere');
  bad('DUPLICATE_MISSION',()=>attach(other,'discovery','taken-elsewhere'));
  const live=take(init(),'discovery','cancel-live');
  const cancelled=api.cancelProjectRun(live,{reason:'Proyecto terminado',now});
  assert.equal(cancelled.status,'CANCELLED');assert.equal(cancelled.milestones[0].status,'PENDING');
  assert.equal(cancelled.milestones[0].attempts[0].reason,'Corrida cancelada: Proyecto terminado');
  broken(cancelled,x=>{x.milestones[0].running={...live.milestones[0].running};x.milestones[0].attempts=[];x.milestones[0].status='RUNNING';});
  for(const f of [()=>api.claimMilestone(init(),null),()=>api.completePart(live,null),
    ()=>api.releaseMilestone(live,null)])bad('INVALID_ID',f);
  bad('MILESTONE_NOT_RUNNING',()=>complete(init(),'missing-id'));
  bad('INVALID_PR',()=>complete(live,'cancel-live',{prNumber:0}));
  bad('INVALID_PR',()=>release(live,'cancel-live',{prNumber:0}));
});
test('A3: hora ISO estricta, forma canónica y razones saneadas',()=>{
  const p=plan(),raw=structuredClone(p);raw.milestones[0].objective='  Diseñar alcance  ';
  assert.equal(init(raw).milestones[0].objective,'Diseñar alcance');
  const altered=structuredClone(p);altered.digest='0'.repeat(64);
  bad('PLAN_TAMPERED',()=>init(altered));
  bad('INVALID_TIME',()=>take(init(),'discovery','missing-time',true,{now:undefined}));
  for(const timestamp of ['2026-11-14T12:00:00-03:00','2026-02-30T00:00:00.000Z','ayer'])
    bad('INVALID_TIME',()=>take(init(),'discovery','bad-time',true,{now:timestamp}));
  const second='2026-11-14T17:00:00.000Z',third='2026-11-14T18:00:00.000Z';
  let s=take(init(),'discovery','time-one',true,{now:second});
  assert.equal(s.updatedAt,second);assert.equal(s.milestones[0].running.at,second);
  s=complete(s,'time-one',{now:third});
  assert.equal(s.updatedAt,third);assert.equal(s.milestones[0].parts[0].at,third);
  for(const [size,valid] of [[7,false],[8,true],[300,true],[301,false]]){
    const f=()=>api.recordOutsidePlan(init(),{missionId:'reason-limit',reason:'a'.repeat(size),now});
    if(valid)assert.equal(f().outsidePlan[0].reason.length,size);else bad('INVALID_REASON',f);
  }
  s=api.recordOutsidePlan(init(),{missionId:'reason-clean',reason:'  Ocho\u0000  \tpalabras\u202E  ',now});
  assert.equal(s.outsidePlan[0].reason,'Ocho palabras');
  const cancel=api.cancelProjectRun(take(init(),'discovery','long-reason'),{reason:'z'.repeat(300),now});
  assert.equal(cancel.milestones[0].attempts[0].reason.length,300);
});
test('A3: tope de partes e hitos',()=>{
  let s=init();
  for(let i=0;i<50;i++)s=attach(s,'discovery','part-'+i,false);
  assert.equal(s.milestones[0].parts.length,50);
  bad('TOO_MANY_PARTS',()=>attach(s,'discovery','part-overflow',false));
  const live=take(s,'discovery','part-running');
  bad('TOO_MANY_PARTS',()=>complete(live,'part-running'));
  broken(s,x=>{x.milestones[0].parts.push({...x.milestones[0].parts[0],missionId:'part-overflow',prNumber:9000001,mergeCommitSha:base});});
  broken(init(),x=>{x.milestones=Array.from({length:201},(_,i)=>({...x.milestones[0],id:'hito-'+i}));});
});


test('A4: cancelación corta por puntos de código y sanea después del corte',()=>{
  for(const reason of [
    'x'.repeat(280)+' '+'z'.repeat(19),
    'x'.repeat(280)+'😀'+'z'.repeat(19)
  ]){
    const s=api.cancelProjectRun(take(init(),'discovery','cancel-a4'),{reason,now});
    const text=s.milestones[0].attempts[0].reason;
    assert.ok(Array.from(text).length<=300);
    assert.doesNotMatch(text,/^\s|\s$/u);
    assert.doesNotMatch(text,/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  }
});

test('A4: la parte 50 solo puede ser final y ready informa capacidad',()=>{
  let s=init();
  for(let i=0;i<49;i++){
    const id='limit-'+i;
    s=complete(take(s,'discovery',id,false),id);
  }
  const ready=api.readyMilestones(s);
  assert.ok(Object.isFrozen(ready));
  assert.equal(ready[0].parts,49);
  assert.equal(ready[0].maxParts,50);
  bad('TOO_MANY_PARTS',()=>take(s,'discovery','limit-no-final',false));
  const final=take(s,'discovery','limit-final',true);
  const done=complete(final,'limit-final');
  assert.equal(done.milestones[0].parts.length,50);
  assert.equal(done.milestones[0].status,'DONE');
  assert.ok(done.milestones.every(m=>m.parts.length<50||m.status==='DONE'));
});

test('A4: misión en curso y reciclada no distingue mayúsculas ni cambia su caso',()=>{
  let s=take(init(),'discovery','Case-Mission',false);
  s=complete(s,'case-mission');
  s=take(s,'discovery','Release-Mission');
  s=release(s,'release-mission');
  assert.equal(s.milestones[0].status,'PARTIAL');
  s=attach(s,'discovery','RELEASE-MISSION',true);
  assert.equal(s.milestones[0].parts.at(-1).missionId,'Release-Mission');

  let withPr=take(init(),'discovery','Attempt-With-Pr');
  withPr=release(withPr,'attempt-with-pr',{prNumber:17});
  bad('DUPLICATE_MISSION',()=>attach(withPr,'discovery','ATTEMPT-WITH-PR',true,{prNumber:18}));
});

test('A4: motivos conservan espacios reales antes de retirar controles',()=>{
  let s=take(init(),'discovery','reason-whitespace');
  s=release(s,'reason-whitespace',{reason:'Falló CI\n\ten paso seguro'});
  assert.equal(s.milestones[0].attempts[0].reason,'Falló CI en paso seguro');
});

test('A4: validateRun rechaza dependencias dispersas, tipos, tiempos, repo y base',()=>{
  const sparse=structuredClone(init());
  sparse.milestones[0].dependsOn=Array(1);
  bad('INVALID_PROJECT',()=>api.validateRun(sparse));
  broken(init(),x=>{x.milestones[0].dependsOn=[null];});
  broken(init(),x=>{x.updatedAt='2026-11-14T14:59:59.999Z';});
  broken(init(),x=>{x.repo='../escape';});
  broken(init(),x=>{x.base=' main\n';});
  bad('INVALID_REPO',()=>api.initializeProjectRun(plan(),{
    projectId,approvedDigest:plan().digest,repo:'../escape',base:'main',
    ownerClient:'cliente',workspaceId:'espacio',now
  }));
  bad('INVALID_ID',()=>api.initializeProjectRun(plan(),{
    projectId,approvedDigest:plan().digest,repo:'riquelmechile/ZanaLLaima',base:' main ',
    ownerClient:'cliente',workspaceId:'espacio',now
  }));
});

test('A4: validateRun cubre unicidad, dependencias activas, razones e ids de hito',()=>{
  let s=take(init(),'discovery','mission-case',false);
  const duplicate=structuredClone(s);
  duplicate.outsidePlan.push({missionId:'MISSION-CASE',reason:'Motivo válido',at:now});
  bad('INVALID_PROJECT',()=>api.validateRun(duplicate));

  const depPlan=plan([{...milestones[0]},{...milestones[1],dependsOn:['discovery']}]);
  const pending=init(depPlan);
  for(const status of ['RUNNING','PARTIAL']){
    const corrupt=structuredClone(pending);
    const m=corrupt.milestones[1];
    if(status==='RUNNING'){
      m.status='RUNNING';
      m.running={missionId:'dep-active',final:true,baseSha:base,at:now};
    }else{
      m.status='PARTIAL';
      m.parts=[{missionId:'dep-part',prNumber:1,headSha:head,mergeCommitSha:merge,final:false,at:now}];
    }
    bad('INVALID_PROJECT',()=>api.validateRun(corrupt));
  }

  for(const reason of ['corto',' x'.repeat(151)]){
    const corrupt=structuredClone(init());
    corrupt.outsidePlan=[{missionId:'reason-bad',reason,at:now}];
    bad('INVALID_PROJECT',()=>api.validateRun(corrupt));
  }

  const repeated=structuredClone(init());
  repeated.milestones[1].id=repeated.milestones[0].id;
  repeated.milestones[1].dependsOn=[];
  repeated.milestones[2].dependsOn=['code'];
  bad('INVALID_PROJECT',()=>api.validateRun(repeated));
});

test('A4: completePart detecta PR duplicado y cancelar conserva PARTIAL',()=>{
  let s=complete(take(init(),'discovery','first-part',false),'first-part');
  s=take(s,'discovery','second-part',true);
  bad('DUPLICATE_PR',()=>complete(s,'second-part',{prNumber:prOf('first-part')}));
  const cancelled=api.cancelProjectRun(s,{reason:'Cancelación solicitada por operador',now});
  assert.equal(cancelled.milestones[0].status,'PARTIAL');
  assert.equal(cancelled.milestones[0].parts.length,1);
  assert.equal(cancelled.milestones[0].attempts.at(-1).missionId,'second-part');
});

test('A4: attachPart valida el id de hito antes de disponibilidad',()=>{
  bad('INVALID_ID',()=>attach(init(),null,'attach-invalid'));
});
