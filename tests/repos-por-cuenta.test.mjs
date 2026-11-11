import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteConfig,repoAllowed} from '../src/remote-config.mjs';
import {parseRepoChecks} from '../src/checks-policy.mjs';
import {remoteFixture} from './helpers/remote-fixture.mjs';

const L={ZANA_REVIEWER_LOGIN:'reviewer-bot'};

test('owner/* permite todos los repos de esa cuenta y ninguno de otra',()=>{
  const c=remoteConfig({...L,ZANA_GITHUB_REPOS:'Operador/*, otro/exacto'});
  for(const ok of ['operador/a','OPERADOR/Proyecto-Nuevo','Operador/x.y_z','otro/exacto','OTRO/EXACTO'])
    assert.equal(repoAllowed(c,ok),true,ok);
  // Otra cuenta, un prefijo o un sufijo del nombre de la cuenta: no.
  for(const no of ['otro/distinto','operador2/a','xoperador/a','operado/a','operador-x/a'])
    assert.equal(repoAllowed(c,no),false,no);
  // Letras que se pliegan a ASCII al pasar a minúsculas (K Kelvin, ſ larga): no son la cuenta.
  const kit=remoteConfig({...L,ZANA_GITHUB_REPOS:'kit/*,kit2/exacto,ss/x'});
  for(const fold of ['\u212Ait/a','\u212Ait2/exacto','\u017F\u017F/x','kit/\u212A'])
    assert.equal(repoAllowed(kit,fold),false,JSON.stringify(fold));
  // Lo que no es un owner/repo válido no pasa aunque empiece con la cuenta.
  for(const bad of ['operador/','operador/..','operador/.','operador/a/b','operador/*','operador/a b','operador',
    '/a','operador/a\n','operador/a?x=1','operador/a#b',null,undefined,42,{},['operador/a']])
    assert.equal(repoAllowed(c,bad),false,String(bad));
});

test('solo se acepta el comodín de cuenta completa, con la cuenta nombrada',()=>{
  for(const bad of ['*','*/*','*/repo','ope*/repo','operador/*x','operador/x*','operador/**','operador/*/x','/*','-x/*','.../*'])
    assert.throws(()=>remoteConfig({...L,ZANA_GITHUB_REPOS:bad}),/invalid repository/,bad);
  assert.deepEqual(remoteConfig({...L,ZANA_GITHUB_REPOS:'a/*,b/c'}).repos,['a/*','b/c']);
  // Un patrón que no pasó la validación no cubre nada, aunque llegue al matcher.
  for(const raw of [['\u212A/*'],[['kit/*']],['*'],[null],'kit/*',undefined])
    assert.equal(repoAllowed({repos:raw},'k/a')||repoAllowed({repos:raw},'kit/a'),false,JSON.stringify(raw));
  // Sin lista no se permite nada.
  assert.equal(repoAllowed(remoteConfig(L),'operador/a'),false);
});

test('checks por repo: un override vale para un repo cubierto por owner/* y no para otra cuenta',()=>{
  const policy={workflow:'zana-python.yml',requiredChecks:['pytest']};
  const parsed=parseRepoChecks(JSON.stringify({'Operador/Backend':policy}),['operador/*']);
  assert.deepEqual(parsed['operador/backend'],policy);
  assert.throws(()=>parseRepoChecks(JSON.stringify({'otro/backend':policy}),['operador/*']),/INVALID_REPO_CHECKS/);
  assert.throws(()=>parseRepoChecks(JSON.stringify({'operador/*':policy}),['operador/*']),/INVALID_REPO_CHECKS/);
  assert.throws(()=>parseRepoChecks(JSON.stringify({'Operador/Api':policy,'operador/api':policy}),['operador/*']),/INVALID_REPO_CHECKS/);
  assert.throws(()=>parseRepoChecks(JSON.stringify({'operadorx/api':policy}),['operador/*']),/INVALID_REPO_CHECKS/);
  const c=remoteConfig({...L,ZANA_GITHUB_REPOS:'operador/*',ZANA_REPO_CHECKS_JSON:JSON.stringify({'operador/api':policy})});
  assert.deepEqual(c.repoChecks['operador/api'],policy);
});

test('misión: con o/* arranca en cualquier repo de la cuenta y se niega en otra',async()=>{
  // Antes de levantar el fixture: si la configuración no se acepta, el test falla aquí.
  assert.doesNotThrow(()=>remoteConfig({...L,ZANA_GITHUB_REPOS:'o/*'}));
  const f=await remoteFixture({envExtra:{ZANA_GITHUB_REPOS:'o/*'}});
  try{
    const author=await f.session();
    const denied=await f.call('zana_mission_init',{spec:f.spec,github:{repo:'x/r',base:'main'}},author);
    assert.match(denied.error,/REPO_NOT_ALLOWED/);
    assert.equal(denied.error.includes('ZANA_GITHUB_REPOS'),true);
    const weird=await f.call('zana_mission_init',{spec:f.spec,github:{repo:'o/../r',base:'main'}},author);
    assert.match(weird.error,/REPO_NOT_ALLOWED/);
    // Un repo de la cuenta que nadie anotó: la misión se abre igual.
    const init=await f.call('zana_mission_init',{spec:f.spec,github:{repo:'O/otro-proyecto',base:'main'}},author);
    assert.equal(init.error,undefined,init.error);
    assert.match((await f.call('zana_mission_init',{spec:f.spec,github:{repo:'o/r\n',base:'main'}},author)).error,/REPO_NOT_ALLOWED: "o\/r\\n"/);
  }finally{await f.cleanup();}
});
