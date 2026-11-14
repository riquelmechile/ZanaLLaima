import test from 'node:test';
import assert from 'node:assert/strict';
import {runBoard,runMemoryEntries} from '../src/project-run-memory.mjs';

const sha='a'.repeat(40), merge='b'.repeat(40), at='2026-11-14T12:00:00.000Z';
const part=(missionId='mision-1',prNumber=17,final=false)=>({missionId,prNumber,headSha:sha,mergeCommitSha:merge,final,at});
const running=(missionId='mision-1',final=false)=>({missionId,final,baseSha:sha,at});
const milestone=(id='uno',rest={})=>({id,dependsOn:[],objective:'Entregar módulo',acceptance:'Pruebas verdes',
  status:'PENDING',parts:[],running:null,attempts:[],...rest});
const state=(milestones=[milestone()],rest={})=>({schema:'zana.project-run.v2',projectId:'zp_1234567890abcdef',
  repo:'riquelmechile/ZanaLLaima',base:'main',ownerClient:'chatgpt',workspaceId:'espacio',
  planDigest:'c'.repeat(64),revision:0,status:'ACTIVE',milestones,outsidePlan:[],
  createdAt:at,updatedAt:at,...rest});
const step=(prior,changed,rest={})=>({...prior,revision:prior.revision+1,
  milestones:[changed],updatedAt:at,...rest});
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const kinds=x=>x.save.map(e=>e.kind+':'+e.topic);

test('tablero de corrida nueva y todos los estados de hito',()=>{
  const s=state();
  assert.equal(runBoard(s),'Plan cccccccc · ACTIVE · revisión 0 · 0/1 hitos\nuno: PENDING');
  const ms=[milestone('a',{status:'DONE',parts:[part('m1',1,true)]}),
    milestone('b',{status:'PARTIAL',parts:[part('m2',2,false)]}),
    milestone('c',{status:'RUNNING',running:running('m3',true),parts:[part('m4',3,false)]}),
    milestone('d',{status:'PENDING'})];
  assert.equal(runBoard(state(ms,{revision:4})),
    'Plan cccccccc · ACTIVE · revisión 4 · 1/4 hitos\n'+
    'a: DONE (1 partes)\nb: PARTIAL (1 partes fusionadas)\n'+
    'c: RUNNING misión m3 (parte 2, final sí)\nd: PENDING');
});
test('tablero indica intentos fallidos, misiones fuera del plan y cancelación',()=>{
  const ms=[milestone('a',{attempts:[{missionId:'m1',reason:'Error',prNumber:null,at},
    {missionId:'m2',reason:'Error',prNumber:9,at}]})];
  const s=state(ms,{outsidePlan:[{missionId:'extra',reason:'No aprobada',at}]});
  assert.match(runBoard(s),/a: PENDING · 2 intentos fallidos\nFuera del plan: 1 misiones$/);
  const cancelled=runBoard(state(ms,{status:'CANCELLED',reason:'Falta permiso',revision:9}));
  assert.match(cancelled,/Plan cccccccc · CANCELLED · revisión 9 · 0\/1 hitos · motivo: Falta permiso/);
});
test('tablero recorta sin perder el encabezado ni cortar el marcador de hitos',()=>{
  const many=state(Array.from({length:60},(_,i)=>milestone('hito-'+String(i).padStart(2,'0')+'-'+
    'nombre-repetido'.repeat(4))));
  const board=runBoard(many);
  const count=(board.match(/^hito-\d{2}/gm)||[]).length;
  assert.ok(board.length<=1000);assert.match(board,/^Plan cccccccc/);
  assert.ok(count<60);assert.ok(count>0);
  assert.ok(board.endsWith('… +'+(60-count)+' hitos'));
});
test('nueva corrida guarda solamente el tablero y admite cero hitos',()=>{
  const s=state([]),result=runMemoryEntries(null,s);
  assert.deepEqual(result,{save:[{kind:'decision',topic:'proyecto:avance',
    body:'Plan cccccccc · ACTIVE · revisión 0 · 0/0 hitos',missionId:null,sha:null}],resolve:[]});
});
test('reclamo crea un pendiente con parte siguiente y misión causal en el tablero',()=>{
  const old=state(),next=step(old,milestone('uno',{status:'RUNNING',running:running('nuevo',true)}));
  const result=runMemoryEntries(old,next);
  assert.deepEqual(kinds(result),['decision:proyecto:avance','pending:hito:uno']);
  assert.equal(result.save[0].missionId,'nuevo');
  assert.deepEqual(result.save[1],{kind:'pending',topic:'hito:uno',
    body:'En curso: misión nuevo, parte 1, final sí. Objetivo: Entregar módulo. Aceptación: Pruebas verdes.',
    missionId:'nuevo',sha:null});
});
test('parte no final queda pendiente con PR y SHA completo en metadatos',()=>{
  const old=state([milestone('uno',{status:'RUNNING',running:running()})]);
  const next=step(old,milestone('uno',{status:'PARTIAL',parts:[part()]}));
  const result=runMemoryEntries(old,next);
  assert.deepEqual(kinds(result),['decision:proyecto:avance','pending:hito:uno']);
  assert.match(result.save[1].body,/Parcial: 1 partes fusionadas \(PR #17 bbbbbbb\)/);
  assert.match(result.save[1].body,/Falta la parte siguiente/);
  assert.equal(result.save[1].sha,merge);
  assert.equal(result.save[1].missionId,'mision-1');
});
test('parte final resuelve pending y deja la decisión con todas las partes',()=>{
  const first=part('antes',10,false),last=part('ultimo',18,true);
  const old=state([milestone('uno',{status:'RUNNING',parts:[first],running:running('ultimo',true)})]);
  const next=step(old,milestone('uno',{status:'DONE',parts:[first,last]}),{status:'READY_TO_DELIVER'});
  const result=runMemoryEntries(old,next);
  assert.deepEqual(kinds(result),['decision:proyecto:avance','decision:hito:uno']);
  assert.deepEqual(result.resolve,['hito:uno']);
  assert.match(result.save[1].body,/Terminado en 2 partes: PR #10 \(misión antes, merge bbbbbbb\), PR #18 \(misión ultimo, merge bbbbbbb\)/);
  assert.equal(result.save[1].missionId,'ultimo');assert.equal(result.save[1].sha,merge);
  assert.match(result.save[0].body,/READY_TO_DELIVER · revisión 1 · 1\/1 hitos/);
});
test('liberación sin partes produce issue y resuelve pending anterior',()=>{
  const old=state([milestone('uno',{status:'RUNNING',running:running('fallo')})]);
  const next=step(old,milestone('uno',{attempts:[{missionId:'fallo',reason:'CI en rojo',prNumber:22,at}]}));
  const result=runMemoryEntries(old,next);
  assert.deepEqual(kinds(result),['decision:proyecto:avance','issue:hito:uno']);
  assert.deepEqual(result.resolve,['hito:uno']);
  assert.deepEqual(result.save[1],{kind:'issue',topic:'hito:uno',
    body:'Intento fallido: misión fallo, PR #22. Motivo: CI en rojo.',missionId:'fallo',sha:null});
});
test('liberación con partes emite issue seguido del pendiente parcial',()=>{
  const p=part('terminada',2);
  const old=state([milestone('uno',{status:'RUNNING',parts:[p],running:running('fallo')})]);
  const next=step(old,milestone('uno',{status:'PARTIAL',parts:[p],
    attempts:[{missionId:'fallo',reason:'Agotó revisión',prNumber:null,at}]}));
  const result=runMemoryEntries(old,next);
  assert.deepEqual(kinds(result),['decision:proyecto:avance','issue:hito:uno','pending:hito:uno']);
  assert.deepEqual(result.resolve,[]);
  assert.match(result.save[1].body,/misión fallo\. Motivo: Agotó revisión\./);
  assert.equal(result.save[2].missionId,'terminada');assert.equal(result.save[2].sha,merge);
});
test('cancelación solamente cambia el tablero; sin cambios devuelve vacío',()=>{
  const old=state([milestone('uno',{status:'RUNNING',running:running()})]);
  const cancelled={...old,status:'CANCELLED',reason:'Fin autorizado',revision:1};
  const result=runMemoryEntries(old,cancelled);
  assert.deepEqual(kinds(result),['decision:proyecto:avance']);
  assert.equal(result.save[0].missionId,null);
  assert.deepEqual(runMemoryEntries(cancelled,cancelled),{save:[],resolve:[]});
});
test('tablero primero e hitos en orden, con causas distintas',()=>{
  const old=state([milestone('b'),milestone('a')]);
  const next={...old,revision:1,milestones:[
    milestone('b',{status:'RUNNING',running:running('m-b')}),
    milestone('a',{status:'RUNNING',running:running('m-a')})]};
  const out=runMemoryEntries(old,next);
  assert.deepEqual(kinds(out),['decision:proyecto:avance','pending:hito:b','pending:hito:a']);
  assert.equal(out.save[0].missionId,'m-b');
});
test('textos y listas enormes respetan límites y no alteran el estado congelado',()=>{
  const huge='L'.repeat(5000),parts=Array.from({length:70},(_,i)=>part('mission-'+i,100+i));
  const old=freeze(state([milestone('uno',{status:'RUNNING',parts:parts.slice(0,-1),
    running:running('ultima')})]));
  const next=freeze(step(old,milestone('uno',{status:'DONE',parts:parts.concat(part('ultima',999,true)),
    objective:huge,acceptance:huge,attempts:[{missionId:'fallo',reason:huge,prNumber:null,at}]}),
    {status:'READY_TO_DELIVER'}));
  const result=runMemoryEntries(old,next);
  for(const e of result.save){assert.ok(e.body.length<=1000);assert.ok(e.topic.length<=80);}
  assert.deepEqual(kinds(result),['decision:proyecto:avance','decision:hito:uno','issue:hito:uno']);
  assert.equal(result.resolve[0],'hito:uno');
  assert.equal(next.milestones[0].objective,huge);
  assert.ok(runBoard(freeze({...next,status:'CANCELLED',reason:huge})).length<=1000);
});
test('intentos sin PR y tabla congelada nunca se modifican al leer',()=>{
  const p=part('anterior',5),next=freeze(state([
    milestone('a',{status:'PARTIAL',parts:[p],attempts:[{missionId:'f',reason:'Sin PR',prNumber:null,at}]}),
    milestone('b',{status:'PENDING'})],{revision:8}));
  const before=structuredClone(next);
  assert.ok(runBoard(next).includes('1 intentos fallidos'));
  assert.ok(runMemoryEntries(null,next).save.length>=1);
  assert.deepEqual(next,before);
});
