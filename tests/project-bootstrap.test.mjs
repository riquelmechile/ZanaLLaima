import test from 'node:test';
import assert from 'node:assert/strict';
import {startDiscovery,answerDiscovery,draftProjectPlan} from '../src/project-discovery.mjs';
import {validateBootstrapPlan,prepareBootstrap,validateBootstrapIntent,executeBootstrap} from '../src/project-bootstrap.mjs';
const plan=()=>draftProjectPlan({
  brief:answerDiscovery(startDiscovery('Una plataforma de pedidos para tiendas pequeñas'),{
    goal:'Administrar pedidos',users:'Comerciantes',platform:'Web',features:'Ventas',data:'Datos personales'}),
  alternatives:[
    {id:'go',technology:'Go',rationale:'API rápida',benefits:'Compilado',tradeoffs:'Binario',sources:[{title:'Go',url:'https://go.dev/doc/',checkedOn:'2026-11-10'}]},
    {id:'node',technology:'Node',rationale:'Ecosistema',benefits:'JS',tradeoffs:'Runtime',sources:[{title:'Node',url:'https://nodejs.org/docs/latest/api/',checkedOn:'2026-11-10'}]},
  ],selectedId:'go',milestones:[{id:'m1',objective:'Probar flujo',acceptance:'Tests verdes',dependsOn:[]}],
});
const intent=()=>prepareBootstrap(plan(),{owner:'riquelmechile',name:'Proyecto-uno'});
function fixture(){
  const calls=[],repo={id:42,full_name:'riquelmechile/Proyecto-uno'};
  const backend={authorize:async x=>{calls.push('authorize');return x.operation==='create_repository'},
    reserve:async x=>{calls.push('reserve');return{state:'RESERVED',digest:x.digest}},
    markUncertain:async()=>{calls.push('uncertain')},
    createRepository:async()=>{calls.push('create');return repo},
    commit:async()=>{calls.push('commit')}};
  return{calls,repo,backend};
}
test('plan verificable y destino privado por defecto',()=>{
  const p=plan(),i=intent();assert.equal(validateBootstrapPlan(p),p.digest);
  assert.equal(validateBootstrapIntent(i),true);assert.equal(i.visibility,'private');
  assert.equal(i.defaultBranch,'main');assert.match(i.digest,/^[a-f0-9]{64}$/);
});
test('rechaza adulteración del plan y aprobación declarada por modelo',()=>{
  assert.throws(()=>validateBootstrapPlan({...plan(),selectedId:'node'}),/PLAN_TAMPERED/);
  assert.throws(()=>validateBootstrapPlan({...plan(),approval:'APPROVED'}),/INVALID_PLAN/);
});
test('no permite proveedores, nombres y visibilidades arbitrarios',()=>{
  for(const args of [{owner:'x',name:'a/b'},{owner:'x',name:'..'},{owner:'x',name:'a',provider:'gitlab'},
    {owner:'x',name:'a',visibility:'internal'}])assert.throws(()=>prepareBootstrap(plan(),args),/INVALID_REPOSITORY|UNSUPPORTED_PROVIDER|INVALID_VISIBILITY/);
});
test('modificar destino o consentimiento invalida huella del intento',()=>{
  const i=intent();assert.throws(()=>validateBootstrapIntent({...i,name:'another'}),/INTENT_TAMPERED/);
  assert.throws(()=>validateBootstrapIntent({...i,status:'APPROVED'}),/INVALID_INTENT/);
});
test('sin permiso autenticado no reserva ni crea',async()=>{
  const f=fixture();f.backend.authorize=async()=>false;
  await assert.rejects(executeBootstrap(intent(),f.backend),/AUTHORIZATION_REQUIRED/);
  assert.deepEqual(f.calls,[]);
});
test('no ejecuta acciones sin servicios de backend',async()=>{
  await assert.rejects(executeBootstrap(intent(),{}),/BACKEND_UNAVAILABLE/);
});
test('una creación autorizada persiste UNCERTAIN antes del POST',async()=>{
  const f=fixture(),r=await executeBootstrap(intent(),f.backend);
  assert.equal(r.state,'DONE');assert.deepEqual(r.repository,f.repo);
  assert.deepEqual(f.calls,['authorize','reserve','uncertain','create','commit']);
  assert.equal(r.needsOperatorSetup.length,3);
});
test('operación duplicada terminada solo devuelve el recibo',async()=>{
  const f=fixture();f.backend.reserve=async x=>({state:'DONE',digest:x.digest,repository:f.repo});
  const r=await executeBootstrap(intent(),f.backend);assert.equal(r.reused,true);
  assert.deepEqual(f.calls,['authorize']);
});
test('estado incierto o digest distinto bloquean la ejecución',async()=>{
  const f=fixture();f.backend.reserve=async x=>({state:'UNCERTAIN',digest:x.digest});
  await assert.rejects(executeBootstrap(intent(),f.backend),/RECONCILIATION_REQUIRED/);
  f.backend.reserve=async()=>({state:'RESERVED',digest:'x'});
  await assert.rejects(executeBootstrap(intent(),f.backend),/RESERVATION_MISMATCH/);
});
test('fallo remoto, respuesta falsa y error de commit nunca provocan reintento',async()=>{
  for(const mode of ['throw','bad','commit']){
    const f=fixture();
    if(mode==='throw')f.backend.createRepository=async()=>{throw Error('network')};
    if(mode==='bad')f.backend.createRepository=async()=>({id:42,full_name:'foreign/other'});
    if(mode==='commit')f.backend.commit=async()=>{throw Error('disk')};
    await assert.rejects(executeBootstrap(intent(),f.backend),/OUTCOME_UNKNOWN/);
  }
});
