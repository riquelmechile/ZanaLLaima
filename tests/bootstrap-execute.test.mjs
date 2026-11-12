import test from 'node:test';
import assert from 'node:assert/strict';
import {GitHubApiError} from '../src/github-api.mjs';
import {decidePlanApproval,describePlanApproval} from '../src/plan-approval.mjs';
import {requestBootstrap,bootstrapStatus,bootstrapAuthorized} from '../src/bootstrap-request.mjs';
import {runBootstrap,reconcileBootstrap} from '../src/bootstrap-execute.mjs';
import {planFixture,T0} from './helpers/plan-fixture.mjs';

const allowed=repo=>repo.toLowerCase().startsWith('acme/');
// GitHub de mentira: lo justo para crear y consultar un repositorio.
function github({login='acme',existing=null,create}={}){
  const calls=[];
  const made=body=>({id:77,full_name:login+'/'+body.name,private:body.private,description:body.description,html_url:'https://github.test/'+login+'/'+body.name,
    default_branch:'main',created_at:new Date(T0).toISOString(),owner:{login}});
  return {calls,posts:()=>calls.filter(x=>x[0]==='POST'),
    async request(method,path,{body}={}){
      calls.push([method,path,body]);
      if(method==='GET'&&path==='/user')return {login};
      if(method==='POST'&&path==='/user/repos')return create?create(body,made):made(body);
      throw new GitHubApiError(404,'GitHub HTTP 404');
    },
    async repo(repo){calls.push(['GET','/repos/'+repo]);
      const found=typeof existing==='function'?existing(repo):existing;
      if(!found)throw new GitHubApiError(404,'GitHub HTTP 404: Not Found');return found;}};
}
// Operación pedida y, si se indica, autorizada por el operador.
function setup({authorized=true,gh=github()}={}){
  const f=planFixture({approved:true});
  const r=requestBootstrap(f.db,{...f.at,expectedVersion:f.w.version,owner:'acme',name:'gestor',visibility:'private',allowed,now:T0});
  if(authorized)decidePlanApproval(f.db,{approvalId:r.authorization.approvalId,decision:'allow',passwordOk:true,now:T0});
  const rw=async fn=>fn(f.db),at={clientId:f.client,operationId:r.operationId};
  const deps={rw,rr:rw,github:gh,allowed,now:()=>T0+60_000,...at};
  return {f,r,at,gh,deps,run:(extra={})=>runBootstrap({...deps,...extra}),reconcile:(extra={})=>reconcileBootstrap({...deps,...extra}),
    status:()=>bootstrapStatus(f.db,{...at,now:T0+60_000}),authorizedNow:()=>bootstrapAuthorized(f.db,{...at,now:T0+60_000})};
}

test('crea el repositorio una sola vez y gasta la autorización',async()=>{
  const t=setup();
  try{
    const done=await t.run();
    assert.deepEqual({state:done.state,reused:done.reused,auth:done.authorization.status,repo:done.created},
      {state:'DONE',reused:false,auth:'CONSUMED',repo:{id:77,fullName:'acme/gestor',private:true,htmlUrl:'https://github.test/acme/gestor',defaultBranch:'main'}});
    const [[,,{description,...body}]]=t.gh.posts();
    assert.deepEqual(body,{name:'gestor',private:true,auto_init:true});
    assert.match(description,new RegExp('^Creado por ZanaLLaima \\(operación '+t.r.operationId+', intento [0-9a-f-]{36}\\)$'));
    assert.equal(t.authorizedNow(),false,'una autorización vale para un intento');
    const again=await t.run();
    assert.deepEqual([again.state,again.reused],['DONE',true]);
    assert.equal(t.gh.posts().length,1,'repetir la ejecución no vuelve a crear');
    await assert.rejects(t.reconcile(),/NOTHING_TO_RECONCILE/);
    await assert.rejects(t.run({clientId:'oauth-other'}),/BOOTSTRAP_NOT_FOUND/);
  }finally{t.f.db.close();}
});

test('sin autorización, con otra cuenta, fuera de la lista o con el nombre ocupado no crea ni gasta nada',async()=>{
  const cases=[
    [setup({authorized:false}),{},/AUTHORIZATION_REQUIRED/,false],
    [setup({gh:github({login:'otra'})}),{},/OWNER_MISMATCH/,true],
    [setup(),{allowed:()=>false},/REPO_NOT_ALLOWED/,true],
    [setup({gh:github({existing:{id:5,full_name:'acme/gestor'}})}),{},/REPO_ALREADY_EXISTS/,true],
  ];
  for(const [t,extra,error,stillAuthorized] of cases){
    try{
      await assert.rejects(t.run(extra),error);
      assert.equal(t.gh.posts().length,0);
      assert.deepEqual([t.status().state,t.authorizedNow()],['AWAITING_AUTHORIZATION',stillAuthorized]);
    }finally{t.f.db.close();}
  }
});

test('un rechazo claro de GitHub guarda la causa y exige una autorización nueva',async()=>{
  const gh=github({create:()=>{throw new GitHubApiError(422,'GitHub HTTP 422: name already exists on this account\u0007');}});
  const t=setup({gh});
  try{
    await assert.rejects(t.run(),/CREATE_REJECTED: GitHub HTTP 422: name already exists/);
    const st=t.status();
    assert.deepEqual([st.state,st.authorization.status],['AWAITING_AUTHORIZATION','CONSUMED']);
    assert.match(st.lastError,/^GitHub HTTP 422: name already exists on this account ?$/);
    await assert.rejects(t.run(),/AUTHORIZATION_REQUIRED/);
    assert.equal(gh.posts().length,1,'no se reintenta a ciegas');
    const renewed=requestBootstrap(t.f.db,{...t.f.at,expectedVersion:t.f.w.version,owner:'acme',name:'gestor',visibility:'private',allowed,now:T0+120_000});
    assert.deepEqual([renewed.operationId,renewed.authorization.status],[t.r.operationId,'PENDING']);
  }finally{t.f.db.close();}
});

test('un resultado incierto nunca se reintenta: se reconcilia contra GitHub',async()=>{
  for(const failure of [new GitHubApiError(502,'GitHub unreachable'),new GitHubApiError(429,'GitHub HTTP 429'),new Error('socket hang up')]){
    let existing=null;
    const gh=github({create:()=>{throw failure;},existing:repo=>typeof existing==='function'?existing(repo):existing});
    const t=setup({gh});
    try{
      await assert.rejects(t.run(),/OUTCOME_UNKNOWN/);
      assert.equal(t.status().state,'UNCERTAIN');
      await assert.rejects(t.run(),/RECONCILIATION_REQUIRED/);
      assert.equal(gh.posts().length,1);
      // GitHub no responde: sigue incierto.
      existing=()=>{throw new GitHubApiError(502,'GitHub unreachable');};
      await assert.rejects(t.reconcile(),/GitHub unreachable/);
      assert.equal(t.status().state,'UNCERTAIN');
      // El repositorio sí quedó creado por este intento: se adopta.
      existing={id:91,full_name:'acme/gestor',private:true,html_url:'https://github.test/acme/gestor',default_branch:'main',
        description:gh.posts()[0][2].description,created_at:new Date(T0+61_000).toISOString(),owner:{login:'acme'}};
      const adopted=await t.reconcile();
      assert.deepEqual([adopted.state,adopted.created.id],['DONE',91]);
      assert.equal(gh.posts().length,1);
    }finally{t.f.db.close();}
  }
});

test('la reconciliación no adopta un repositorio ajeno ni inventa uno que no existe',async()=>{
  const old=description=>({id:9,full_name:'acme/gestor',private:true,description,created_at:'2020-01-01T00:00:00Z',owner:{login:'acme'}});
  const publicOne=id=>({...old(id),private:false,created_at:new Date(T0+61_000).toISOString()});
  // Mismo nombre, fecha, visibilidad y operación, pero de otro intento: no lleva la marca de este.
  const foreign=mark=>({...old(mark.replace(/intento .*/,'intento 99999999-9999-4999-8999-999999999999)')),created_at:new Date(T0+61_000).toISOString()});
  for(const [make,error] of [[old,/REPO_ALREADY_EXISTS/],[publicOne,/REPO_ALREADY_EXISTS/],[foreign,/REPO_ALREADY_EXISTS/],[()=>null,null]]){
    let existing=null;
    const gh=github({create:()=>{throw new GitHubApiError(502,'GitHub unreachable');},existing:()=>existing});
    const t=setup({gh});
    try{
      await assert.rejects(t.run(),/OUTCOME_UNKNOWN/);
      existing=make(gh.posts()[0][2].description);
      // Recién hecho el intento todavía no se puede saber: GitHub puede estar terminando de crear.
      if(!error){
        await assert.rejects(t.reconcile(),/RECONCILE_TOO_EARLY/);
        assert.equal(t.status().state,'UNCERTAIN','reconciliar pronto no libera la operación');
      }
      const later={now:()=>T0+60_000+120_000};
      if(error)await assert.rejects(t.reconcile(later),error);
      else assert.equal((await t.reconcile(later)).state,'AWAITING_AUTHORIZATION');
      const st=t.status();
      assert.deepEqual([st.state,st.created,st.authorization.status],['AWAITING_AUTHORIZATION',null,'CONSUMED']);
      assert.ok(st.lastError);
    }finally{t.f.db.close();}
  }
});

test('una respuesta de GitHub sin identidad verificable queda incierta; dos ejecuciones a la vez crean una sola vez',async()=>{
  const odd=setup({gh:github({create:(body,made)=>({...made(body),full_name:'acme/otro'})})});
  try{
    await assert.rejects(odd.run(),/OUTCOME_UNKNOWN/);
    assert.equal(odd.status().state,'UNCERTAIN');
  }finally{odd.f.db.close();}
  const t=setup();
  try{
    const results=await Promise.allSettled([t.run(),t.run(),t.run()]);
    assert.equal(t.gh.posts().length,1);
    assert.equal(results.filter(x=>x.status==='fulfilled').length>=1,true);
    assert.equal(t.status().state,'DONE');
  }finally{t.f.db.close();}
});

test('una autorización de formato antiguo, sin plan aprobado, se muestra cerrada en vez de fallar',()=>{
  const t=setup();
  try{
    const key='zana:approval:'+t.r.authorization.approvalId;
    const row=JSON.parse(t.f.db.prepare('SELECT value FROM metadata WHERE key=?').get(key).value);
    delete row.planApprovalId;
    t.f.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(row),key);
    decidePlanApproval(t.f.db,{approvalId:t.f.planApprovalId,decision:'revoke',passwordOk:false,now:T0});
    assert.equal(describePlanApproval(t.f.db,{approvalId:t.r.authorization.approvalId,now:T0}).status,'SUPERSEDED');
    assert.equal(t.authorizedNow(),false);
  }finally{t.f.db.close();}
});

// Ronda de corrección tras la revisión 4R.
test('un 4xx con el repositorio creado se adopta; el circuito abierto no cuenta como intento; la reserva revalida',async()=>{
  let created=null;
  const gh=github({create:(body,made)=>{created=made(body);throw new GitHubApiError(422,'GitHub HTTP 422: Repository creation failed.');},existing:()=>created});
  const partial=setup({gh});
  try{
    // Antes de crear el nombre está libre; después del 422 el repositorio existe con la marca del intento.
    const done=await partial.run();
    assert.deepEqual([done.state,done.created.fullName,done.lastError],['DONE','acme/gestor',null]);
  }finally{partial.f.db.close();}
  const open=setup({gh:github({create:()=>{throw new GitHubApiError(503,'GitHub REST circuit open until 2026-11-11T12:01:30.000Z after 5 failures');}})});
  try{
    await assert.rejects(open.run(),/CREATE_REJECTED: GitHub REST circuit open/);
    assert.equal(open.status().state,'AWAITING_AUTHORIZATION','no salió ninguna petición: no hay nada que reconciliar');
  }finally{open.f.db.close();}
  const t=setup();
  try{
    // La operación pasa a apuntar a la autorización del plan entre la comprobación y la reserva.
    const key='zana:bootstrap:'+t.r.operationId;
    const real=t.gh.request.bind(t.gh);
    t.gh.request=async(method,path,options)=>{
      if(method==='GET'&&path==='/user'){
        const row=JSON.parse(t.f.db.prepare('SELECT value FROM metadata WHERE key=?').get(key).value);
        t.f.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify({...row,approvalId:t.f.planApprovalId}),key);
      }
      return real(method,path,options);
    };
    await assert.rejects(t.run(),/AUTHORIZATION_REQUIRED/);
    assert.equal(t.gh.posts().length,0,'la reserva vuelve a comprobar que la autorización sea de esta operación');
  }finally{t.f.db.close();}
});

test('un reconciliador o una ejecución obsoletos no pisan un intento posterior',async()=>{
  const gh=github({create:()=>{throw new GitHubApiError(502,'GitHub HTTP 502');}}),t=setup({gh});
  const late={now:()=>T0+200_000},renew=()=>{
    const r=requestBootstrap(t.f.db,{...t.f.at,expectedVersion:t.f.w.version,owner:'acme',name:'gestor',visibility:'private',allowed,now:T0+200_000});
    decidePlanApproval(t.f.db,{approvalId:r.authorization.approvalId,decision:'allow',passwordOk:true,now:T0+200_000});
  };
  try{
    await assert.rejects(t.run(),/OUTCOME_UNKNOWN/); // intento A: incierto
    let open;const gate=new Promise(ok=>{open=ok;});
    const slow={repo:async repo=>{await gate;return gh.repo(repo);}};
    const stale=t.reconcile({...late,github:slow}); // lee el intento A y queda esperando a GitHub
    await new Promise(setImmediate);
    assert.equal((await t.reconcile(late)).state,'AWAITING_AUTHORIZATION');
    renew();
    // Intento B: su POST queda en vuelo mientras llegan los resultados viejos de A.
    let fly;gh.request=(request=>async(m,p,o)=>{if(m==='POST')await new Promise(ok=>{fly=ok;});return request(m,p,o);})(gh.request.bind(gh));
    const second=t.run(late);
    while(!fly)await new Promise(setImmediate);
    open();
    await assert.rejects(stale,/NOTHING_TO_RECONCILE/);
    assert.equal(t.status().state,'UNCERTAIN','el resultado viejo de A no reabre el intento B');
    fly();await assert.rejects(second,/OUTCOME_UNKNOWN/);
    const marks=gh.posts().map(x=>x[2].description);
    assert.equal(marks.length,2);assert.notEqual(marks[0],marks[1],'cada intento lleva su propia marca');
  }finally{t.f.db.close();}
});

test('una ejecución que vuelve tarde no escribe sobre el intento que la reemplazó',async()=>{
  let hold=true,land;
  const gh=github({create:async(body,made)=>{if(!hold)throw new GitHubApiError(502,'GitHub HTTP 502');
    hold=false;await new Promise(ok=>{land=ok;});return made(body);}}),t=setup({gh}),late={now:()=>T0+200_000};
  try{
    const first=t.run(); // intento A: su POST queda en vuelo
    while(!land)await new Promise(setImmediate);
    assert.equal((await t.reconcile(late)).state,'AWAITING_AUTHORIZATION');
    const r=requestBootstrap(t.f.db,{...t.f.at,expectedVersion:t.f.w.version,owner:'acme',name:'gestor',visibility:'private',allowed,now:T0+200_000});
    decidePlanApproval(t.f.db,{approvalId:r.authorization.approvalId,decision:'allow',passwordOk:true,now:T0+200_000});
    await assert.rejects(t.run(late),/OUTCOME_UNKNOWN/); // intento B: incierto
    land();await assert.rejects(first,/OUTCOME_UNKNOWN/);
    assert.deepEqual([t.status().state,t.status().created],['UNCERTAIN',null],'A no cierra el intento B con su resultado');
  }finally{t.f.db.close();}
});
