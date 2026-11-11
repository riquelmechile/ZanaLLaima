import test from 'node:test';
import assert from 'node:assert/strict';
import {startDiscovery,answerDiscovery,nextDiscoveryQuestions,checkBrief,draftProjectPlan} from '../src/project-discovery.mjs';

const initial=()=>startDiscovery('Crear una plataforma segura de pedidos para pequeñas tiendas.');
const complete=()=>answerDiscovery(initial(),{
  goal:'Gestionar pedidos y comprobantes',users:'Vendedores y administradores',
  platform:'Web responsive',features:'Pedidos, catálogo y exportación',
  data:'Sí, información de clientes',
});
const options=()=>[
  {id:'a',technology:'TypeScript + PostgreSQL',rationale:'Integración web y datos relacionales',
    benefits:'Ecosistema y tipos',tradeoffs:'Requiere runtime Node',
    sources:[{title:'TypeScript Handbook',url:'https://www.typescriptlang.org/docs/',checkedOn:'2026-11-10'}]},
  {id:'b',technology:'Go + PostgreSQL',rationale:'Servicios compilados y concurrencia',
    benefits:'Binario único',tradeoffs:'Menos reutilización con frontend',
    sources:[{title:'Go documentation',url:'https://go.dev/doc/',checkedOn:'2026-11-10'}]},
];
const steps=()=>[
  {id:'core',objective:'Modelo y acceso seguro',acceptance:'Pruebas de autorización aprobadas',dependsOn:[]},
  {id:'ui',objective:'Interfaz',acceptance:'Flujos E2E aprobados',dependsOn:['core']},
];
const plan=()=>draftProjectPlan({brief:complete(),alternatives:options(),selectedId:'a',milestones:steps()});

test('la idea es obligatoria y acotada',()=>{
  assert.throws(()=>startDiscovery('x'),/INVALID_TEXT/);
  assert.equal(initial().status,'COLLECTING');
});
test('preguntas adaptativas sin repetir campos contestados',()=>{
  const s=answerDiscovery(initial(),{goal:'Centralizar los pedidos'});
  assert.deepEqual(nextDiscoveryQuestions(s).map(q=>q.key),['users','platform','features']);
  assert.equal(nextDiscoveryQuestions(s,{includeOptional:true}).length,3);
});
test('las preguntas pendientes desaparecen al completar el briefing',()=>{
  assert.equal(complete().status,'READY_FOR_PLAN');
  assert.deepEqual(nextDiscoveryQuestions(complete()),[]);
  assert.equal(nextDiscoveryQuestions(complete(),{includeOptional:true}).length,3);
});
test('el estado es inmutable y el número de revisión aumenta',()=>{
  const first=initial();const second=answerDiscovery(first,{goal:'Centralizar los pedidos'});
  assert.equal(first.revision,0);assert.equal(second.revision,1);
  assert.equal(Object.isFrozen(second.answers),true);
});
test('rechaza propiedades y objetos no confiables',()=>{
  assert.throws(()=>answerDiscovery(initial(),{'__proto__':'no',rogue:'x'}),/UNKNOWN_FIELD/);
  assert.throws(()=>answerDiscovery(initial(),Object.create({goal:'inherited'})),/INVALID_OBJECT/);
  assert.throws(()=>nextDiscoveryQuestions(initial(),{limit:100}),/INVALID_LIMIT/);
});
test('no confía en un estado READY adulterado',()=>{
  assert.throws(()=>checkBrief({...initial(),status:'READY_FOR_PLAN'}),/INVALID_STATE/);
  assert.throws(()=>draftProjectPlan({brief:initial(),alternatives:options(),selectedId:'a',milestones:steps()}),/DISCOVERY_INCOMPLETE/);
});
test('un plan requiere opciones comparadas y fuentes HTTPS verificables',()=>{
  assert.throws(()=>draftProjectPlan({brief:complete(),alternatives:[options()[0]],selectedId:'a',milestones:steps()}),/INVALID_ALTERNATIVES/);
  const bad=options();bad[0].sources=[{title:'x',url:'http://example.org',checkedOn:'2026-11-10'}];
  assert.throws(()=>draftProjectPlan({brief:complete(),alternatives:bad,selectedId:'a',milestones:steps()}),/INVALID_SOURCE/);
});
test('rechaza fechas imposibles, credenciales en URL y alternativas duplicadas',()=>{
  const bad=options();bad[0].sources[0].checkedOn='2026-02-30';
  assert.throws(()=>draftProjectPlan({brief:complete(),alternatives:bad,selectedId:'a',milestones:steps()}),/INVALID_DATE/);
  const embedded=options();embedded[0].sources[0].url='https://u:p@example.org/path';
  assert.throws(()=>draftProjectPlan({brief:complete(),alternatives:embedded,selectedId:'a',milestones:steps()}),/INVALID_SOURCE/);
  const duplicate=options();duplicate[1].id='a';
  assert.throws(()=>draftProjectPlan({brief:complete(),alternatives:duplicate,selectedId:'a',milestones:steps()}),/DUPLICATE_ID/);
});
test('valida dependencias de hitos y bloquea ciclos',()=>{
  const cycle=steps();cycle[0].dependsOn=['ui'];
  assert.throws(()=>draftProjectPlan({brief:complete(),alternatives:options(),selectedId:'a',milestones:cycle}),/CYCLIC_DEPENDENCY/);
  const missing=steps();missing[1].dependsOn=['absent'];
  assert.throws(()=>draftProjectPlan({brief:complete(),alternatives:options(),selectedId:'a',milestones:missing}),/INVALID_DEPENDENCIES/);
});
test('plan estable, sin aprobación ni autoridad implícita',()=>{
  const a=plan(),b=plan();
  assert.equal(a.digest,b.digest);
  assert.match(a.digest,/^[a-f0-9]{64}$/);
  assert.equal(a.approval,'PENDING_AUTHENTICATED_USER');
  assert.equal(Object.isFrozen(a.milestones),true);
});
test('cambios tecnológicos invalidan la huella del plan',()=>{
  const a=plan(),alternative=options();alternative[0].tradeoffs='Nuevo costo de operación';
  const b=draftProjectPlan({brief:complete(),alternatives:alternative,selectedId:'a',milestones:steps()});
  assert.notEqual(a.digest,b.digest);
});

test('digest canónico independiente del orden de respuestas equivalentes',()=>{
  const input=complete();
  const reverse={...input,answers:Object.fromEntries(Object.entries(input.answers).reverse())};
  const a=plan();
  const b=draftProjectPlan({brief:reverse,alternatives:options(),selectedId:'a',milestones:steps()});
  assert.equal(a.digest,b.digest);
});
