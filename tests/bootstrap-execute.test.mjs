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
  const made=body=>({id:77,full_name:login+'/'+body.name,private:body.private,html_url:'https://github.test/'+login+'/'+body.name,
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
    assert.deepEqual(t.gh.posts(),[['POST','/user/repos',{name:'gestor',private:true,auto_init:true}]]);
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
        created_at:new Date(T0+61_000).toISOString(),owner:{login:'acme'}};
      const adopted=await t.reconcile();
      assert.deepEqual([adopted.state,adopted.created.id],['DONE',91]);
      assert.equal(gh.posts().length,1);
    }finally{t.f.db.close();}
  }
});

test('la reconciliación no adopta un repositorio ajeno ni inventa uno que no existe',async()=>{
  const old={id:9,full_name:'acme/gestor',private:true,created_at:'2020-01-01T00:00:00Z',owner:{login:'acme'}};
  const publicOne={...old,private:false,created_at:new Date(T0+61_000).toISOString()};
  for(const [found,error] of [[old,/REPO_ALREADY_EXISTS/],[publicOne,/REPO_ALREADY_EXISTS/],[null,null]]){
    let existing=null;
    const gh=github({create:()=>{throw new GitHubApiError(502,'GitHub unreachable');},existing:()=>existing});
    const t=setup({gh});
    try{
      await assert.rejects(t.run(),/OUTCOME_UNKNOWN/);
      existing=found;
      if(error)await assert.rejects(t.reconcile(),error);
      else assert.equal((await t.reconcile()).state,'AWAITING_AUTHORIZATION');
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
