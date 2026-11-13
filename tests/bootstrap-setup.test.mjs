import test from 'node:test';
import assert from 'node:assert/strict';
import {GitHubApiError} from '../src/github-api.mjs';
import {requestBootstrap,readOperation,saveOperation,bootstrapStatus} from '../src/bootstrap-request.mjs';
import {runBootstrapSetup} from '../src/bootstrap-setup.mjs';
import {planFixture,T0} from './helpers/plan-fixture.mjs';

const REPO={id:77,full_name:'acme/gestor',private:true,default_branch:'trunk',owner:{login:'acme'}};
const protection=()=>({required_status_checks:{strict:true,checks:[{context:'zana/4r'}]},enforce_admins:{enabled:true},
  required_pull_request_reviews:{required_approving_review_count:1,dismiss_stale_reviews:true,require_last_push_approval:true},
  required_conversation_resolution:{enabled:true},allow_force_pushes:{enabled:false},allow_deletions:{enabled:false}});
function operation(state='DONE',repository={id:77,fullName:'acme/gestor',private:true,defaultBranch:'trunk'}){
  const f=planFixture({approved:true});
  const r=requestBootstrap(f.db,{...f.at,expectedVersion:f.w.version,owner:'acme',name:'gestor',visibility:'private',
    allowed:()=>true,now:T0});
  const op=readOperation(f.db,{clientId:f.client,operationId:r.operationId});
  saveOperation(f.db,{...op,state,repository,updatedAt:new Date(T0).toISOString()});
  return {f,operationId:r.operationId};
}
function clients(opts={}){
  const calls=[],state={permission:opts.permission??'admin',protection:opts.protection??protection(),invited:false};
  const github={configured:true,calls,async repo(){calls.push(['REPO']);if(opts.repoError)throw opts.repoError;return opts.repo??REPO;},
    async request(method,path,{body,withStatus}={}){
      calls.push([method,path,body]);
      if(opts.networkPath===path)throw new GitHubApiError(502,'GitHub unreachable');
      if(path.endsWith('/permission'))return opts.roleName?{role_name:opts.roleName}:{permission:state.permission};
      if(method==='PUT'&&path.includes('/collaborators/')){state.invited=true;return null;}
      if(method==='GET'&&path.includes('/branches/')&&path.endsWith('/protection')){
        if(opts.getProtectionError&&!state.applied)throw opts.getProtectionError;
        if(opts.protectionMissing&&!state.applied)throw new GitHubApiError(404,'Not Found');
        return state.protection;
      }
      if(method==='PUT'&&path.includes('/branches/')&&path.endsWith('/protection')){
        if(opts.putProtectionError)throw opts.putProtectionError;
        if(opts.protection403)throw new GitHubApiError(403,'Upgrade to GitHub Pro to use protected branches');
        state.applied=true;state.protection=opts.afterProtection??actualGitHubGet;return null;
      }
      if(method==='GET'&&path.includes('/contents/.github/workflows/')){
        if(opts.workflowError)throw opts.workflowError;
        if(opts.workflow===false)throw new GitHubApiError(404,'Not Found');
        return withStatus?{status:200,data:{type:'file'}}:{type:'file'};
      }
      throw new Error('unexpected '+method+' '+path);
    }};
  const reviewer={configured:opts.reviewerConfigured!==false,calls,async request(method,path){
    calls.push(['R:'+method,path]);
    if(method==='GET'){
      const page=Number(new URLSearchParams(path.split('?')[1]).get('page')??1);
      return opts.invitationPages?.[page-1]??opts.invitations??(state.invited?[{id:9,repository:{id:77},inviter:{login:'acme'}}]:[]);
    }
    if(method==='PATCH'){state.permission='push';return null;}
    throw new Error('unexpected reviewer '+method+' '+path);
  }};
  return {github,reviewer,calls,state};
}
const run=(t,c,extra={})=>runBootstrapSetup({rw:fn=>fn(t.f.db),rr:fn=>fn(t.f.db),github:c.github,reviewer:c.reviewer,
  reviewerLogin:'review-bot',workflow:'zana-checks.yml',clientId:t.f.client,operationId:t.operationId,now:()=>T0,...extra});

test('rechaza operación no DONE, repositorio cambiado y revisora ausente',async()=>{
  const a=operation('AWAITING_AUTHORIZATION'),b=operation(),c=operation();
  try{
    await assert.rejects(run(a,clients()),/SETUP_NOT_READY/);
    await assert.rejects(run(b,clients({repo:{...REPO,id:88}})),/SETUP_REPO_CHANGED/);
    await assert.rejects(run(c,clients({reviewerConfigured:false})),/SETUP_REVIEWER_MISSING/);
  }finally{a.f.db.close();b.f.db.close();c.f.db.close();}
});

test('valida nombre, dueño, workflow y role_name del repositorio',async()=>{
  const a=operation(),b=operation(),c=operation(),d=operation();
  try{
    await assert.rejects(run(a,clients({repo:{...REPO,full_name:'acme/otro'}})),/SETUP_REPO_CHANGED/);
    await assert.rejects(run(b,clients({repo:{...REPO,owner:{login:'otro'}}})),/SETUP_REPO_CHANGED/);
    await assert.rejects(run(c,clients(),{workflow:'../x.yml'}),/SETUP_WORKFLOW_INVALID/);
    const cd=clients({permission:'read',roleName:'write'});assert.equal((await run(d,cd)).setup.reviewer,'WRITE');
    assert.equal(cd.calls.some(x=>x[0]==='PUT'&&x[1].includes('/collaborators/')),false);
  }finally{a.f.db.close();b.f.db.close();c.f.db.close();d.f.db.close();}
});

test('revisora existente evita invitación y una nueva acepta solo la invitación exacta',async()=>{
  const a=operation(),b=operation();
  try{
    const ca=clients({permission:'push'});await run(a,ca);
    assert.equal(ca.calls.some(x=>x[0]==='PUT'&&x[1].includes('/collaborators/')),false);
    assert.equal(ca.calls.some(x=>x[0]==='R:PATCH'),false);
    const cb=clients({permission:'read',invitations:[{id:8,repository:{id:99},inviter:{login:'acme'}},{id:9,repository:{id:77},inviter:{login:'acme'}}]});
    await run(b,cb);
    assert.ok(cb.calls.some(x=>x[0]==='R:PATCH'&&x[1].endsWith('/9')));
  }finally{a.f.db.close();b.f.db.close();}
});

test('ignora invitación de otro repo con el mismo nombre',async()=>{
  const t=operation(),c=clients({permission:'read',invitations:[{id:8,repository:{id:99,full_name:'acme/gestor'},inviter:{login:'acme'}}]});
  try{await assert.rejects(run(t,c),/SETUP_REVIEWER_FAILED/);}
  finally{t.f.db.close();}
});

test('aplica y verifica protección exacta sobre la rama default',async()=>{
  const t=operation(),c=clients({permission:'admin',protectionMissing:true});
  try{
    const r=await run(t,c),put=c.calls.find(x=>x[0]==='PUT'&&x[1].includes('/branches/trunk/protection'));
    assert.deepEqual(put[2],{required_status_checks:{strict:true,checks:[{context:'zana/4r'}]},enforce_admins:true,
      required_pull_request_reviews:{required_approving_review_count:1,dismiss_stale_reviews:true,require_last_push_approval:true},
      restrictions:null,required_conversation_resolution:true,allow_force_pushes:false,allow_deletions:false});
    assert.equal(r.setup.protection,'APPLIED');
  }finally{t.f.db.close();}
});

test('protección divergente queda MISMATCH y 403 de plan queda UNAVAILABLE sin cortar workflow',async()=>{
  const a=operation(),b=operation();
  try{
    const ca=clients({protectionMissing:true,afterProtection:{...protection(),allow_deletions:{enabled:true}}});
    await assert.rejects(run(a,ca),/SETUP_PROTECTION_MISMATCH/);
    assert.equal(bootstrapStatus(a.f.db,{clientId:a.f.client,operationId:a.operationId,now:T0}).setup.protection,'MISMATCH');
    const cb=clients({protectionMissing:true,protection403:true,workflow:true});
    const r=await run(b,cb);
    assert.deepEqual([r.setup.protection,r.setup.workflow],['UNAVAILABLE','PRESENT']);
  }finally{a.f.db.close();b.f.db.close();}
});

test('workflow PRESENT y MISSING, setup null antes y segunda corrida sin escrituras',async()=>{
  const a=operation(),b=operation();
  try{
    assert.equal(bootstrapStatus(a.f.db,{clientId:a.f.client,operationId:a.operationId,now:T0}).setup,null);
    const ca=clients({permission:'admin'}),first=await run(a,ca);
    assert.equal(first.setup.workflow,'PRESENT');
    const writes=ca.calls.filter(x=>['PUT','PATCH','R:PATCH'].includes(x[0])).length;
    await run(a,ca);
    assert.equal(ca.calls.filter(x=>['PUT','PATCH','R:PATCH'].includes(x[0])).length,writes);
    const cb=clients({permission:'admin',workflow:false});
    assert.equal((await run(b,cb)).setup.workflow,'MISSING');
  }finally{a.f.db.close();b.f.db.close();}
});

test('error de red se guarda acotado en lastError y se relanza',async()=>{
  const t=operation(),path='/repos/acme/gestor/collaborators/review-bot/permission';
  try{
    await assert.rejects(run(t,clients({networkPath:path})),/SETUP_GITHUB_ERROR/);
    const s=bootstrapStatus(t.f.db,{clientId:t.f.client,operationId:t.operationId,now:T0}).setup;
    assert.match(s.lastError,/SETUP_GITHUB_ERROR/);assert.ok(s.lastError.length<=200);
  }finally{t.f.db.close();}
});


// Reproducciones documentadas en el review 4R del PR #71.
const actualGitHubGet={
  url:'x',
  required_status_checks:{strict:true,contexts:['zana/4r'],checks:[{context:'zana/4r',app_id:null}]},
  required_pull_request_reviews:{dismiss_stale_reviews:true,require_code_owner_reviews:false,
    require_last_push_approval:true,required_approving_review_count:1},
  required_signatures:{enabled:false},enforce_admins:{enabled:true},
  required_linear_history:{enabled:false},allow_force_pushes:{enabled:false},
  allow_deletions:{enabled:false},block_creations:{enabled:false},
  required_conversation_resolution:{enabled:true},lock_branch:{enabled:false},
  allow_fork_syncing:{enabled:false}
};

test('REPRO 4R: GET real ya correcto no debe hacer PUT',async()=>{
  const t=operation(),c=clients({protection:actualGitHubGet,afterProtection:actualGitHubGet});
  try{
    const r=await run(t,c);
    assert.equal(r.setup.protection,'APPLIED');
    assert.equal(c.calls.some(x=>x[0]==='PUT'&&x[1].endsWith('/protection')),false);
  }finally{t.f.db.close();}
});
test('REPRO 4R: 403 de plan en GET produce UNAVAILABLE y revisa workflow',async()=>{
  const t=operation(),c=clients({getProtectionError:new GitHubApiError(403,
    'GitHub HTTP 403: Upgrade to GitHub Pro or make this repository public to enable this feature.')});
  try{
    const result=await run(t,c);
    assert.deepEqual([result.setup.protection,result.setup.workflow],['UNAVAILABLE','PRESENT']);
  }finally{t.f.db.close();}
});
test('REPRO 4R: fallo previo no inventa MISMATCH ni MISSING',async()=>{
  const t=operation(),c=clients({networkPath:'/repos/acme/gestor/collaborators/review-bot/permission'});
  try{
    await assert.rejects(run(t,c),/SETUP_GITHUB_ERROR/);
    const setup=bootstrapStatus(t.f.db,{clientId:t.f.client,operationId:t.operationId,now:T0}).setup;
    assert.notEqual(setup.protection,'MISMATCH');
    assert.notEqual(setup.workflow,'MISSING');
  }finally{t.f.db.close();}
});


test('GET acepta checks en contexts, y rechaza bandera enabled ausente',async()=>{
  const a=operation(),b=operation();
  try{
    const ca=clients({protection:{...actualGitHubGet,required_status_checks:{strict:true,contexts:['zana/4r']}}});
    await run(a,ca);
    assert.equal(ca.calls.some(x=>x[0]==='PUT'&&x[1].endsWith('/protection')),false);
    const cb=clients({protection:{...actualGitHubGet,allow_deletions:undefined}});
    await run(b,cb);
    assert.equal(cb.calls.some(x=>x[0]==='PUT'&&x[1].endsWith('/protection')),true);
  }finally{a.f.db.close();b.f.db.close();}
});

test('GET protección: 403 no-plan y 5xx propagan error sin inventar protección',async()=>{
  for(const [code,message] of [[403,'Resource not accessible by integration'],[502,'GitHub unavailable']]){
    const t=operation(),c=clients({getProtectionError:new GitHubApiError(code,message)});
    try{
      await assert.rejects(run(t,c),/SETUP_GITHUB_ERROR/);
      const setup=bootstrapStatus(t.f.db,{clientId:t.f.client,operationId:t.operationId,now:T0}).setup;
      assert.equal(setup.reviewer,'WRITE');
      assert.equal(setup.protection,null);
      assert.equal(setup.workflow,null);
      assert.match(setup.lastError,/SETUP_GITHUB_ERROR/);
    }finally{t.f.db.close();}
  }
});

test('PUT protección 403 sin upgrade no se clasifica UNAVAILABLE',async()=>{
  const t=operation(),c=clients({protectionMissing:true,
    putProtectionError:new GitHubApiError(403,'Resource not accessible by integration')});
  try{
    await assert.rejects(run(t,c),/SETUP_GITHUB_ERROR/);
    const setup=bootstrapStatus(t.f.db,{clientId:t.f.client,operationId:t.operationId,now:T0}).setup;
    assert.equal(setup.protection,null);
    assert.match(setup.lastError,/SETUP_GITHUB_ERROR/);
  }finally{t.f.db.close();}
});

test('error no 404 al leer workflow conserva resultados ya verificados',async()=>{
  const t=operation(),c=clients({workflowError:new GitHubApiError(503,'Server Error')});
  try{
    await assert.rejects(run(t,c),/SETUP_GITHUB_ERROR/);
    const setup=bootstrapStatus(t.f.db,{clientId:t.f.client,operationId:t.operationId,now:T0}).setup;
    assert.deepEqual([setup.reviewer,setup.protection,setup.workflow],['WRITE','APPLIED',null]);
    assert.match(setup.lastError,/SETUP_GITHUB_ERROR/);
  }finally{t.f.db.close();}
});

test('invitaciones paginadas hasta encontrar repo+invitador exactos',async()=>{
  const t=operation();
  const other=Array.from({length:100},(_,i)=>({id:i+100,repository:{id:100+i},inviter:{login:'acme'}}));
  const c=clients({permission:'read',invitationPages:[other,[{id:9,repository:{id:77},inviter:{login:'acme'}}]]});
  try{
    await run(t,c);
    assert.ok(c.calls.some(x=>x[0]==='R:GET'&&x[1].includes('per_page=100&page=2')));
    assert.ok(c.calls.some(x=>x[0]==='R:PATCH'&&x[1].endsWith('/9')));
  }finally{t.f.db.close();}
});

test('rechaza invitador distinto y lista de invitaciones inválida',async()=>{
  const a=operation(),b=operation();
  try{
    const ca=clients({permission:'read',invitations:[{id:9,repository:{id:77},inviter:{login:'otro'}}]});
    await assert.rejects(run(a,ca),/SETUP_REVIEWER_FAILED/);
    assert.equal(ca.calls.some(x=>x[0]==='R:PATCH'),false);
    await assert.rejects(run(b,clients({permission:'read',invitations:{invalid:true}})),/SETUP_INVITATIONS_INVALID/);
  }finally{a.f.db.close();b.f.db.close();}
});

test('operación que cambia durante setup guarda SETUP_REPO_CHANGED en lastError',async()=>{
  const t=operation(),c=clients();
  const original=c.github.request.bind(c.github);
  let changed=false;
  c.github.request=async(...args)=>{
    if(!changed&&args[1].endsWith('/permission')){
      changed=true;
      const op=readOperation(t.f.db,{clientId:t.f.client,operationId:t.operationId});
      saveOperation(t.f.db,{...op,repository:{...op.repository,id:88}});
    }
    return original(...args);
  };
  try{
    await assert.rejects(run(t,c),/SETUP_REPO_CHANGED/);
    const s=bootstrapStatus(t.f.db,{clientId:t.f.client,operationId:t.operationId,now:T0}).setup;
    assert.match(s.lastError,/SETUP_REPO_CHANGED/);
  }finally{t.f.db.close();}
});

test('cliente ajeno no puede leer ni alterar setup',async()=>{
  const t=operation(),c=clients();
  try{
    await assert.rejects(run(t,c,{clientId:'otro-cliente'}),/BOOTSTRAP_NOT_FOUND/);
    assert.equal(bootstrapStatus(t.f.db,{clientId:t.f.client,operationId:t.operationId,now:T0}).setup,null);
  }finally{t.f.db.close();}
});

test('rama default vacía se rechaza sin construir ruta incompleta',async()=>{
  const t=operation(),c=clients({repo:{...REPO,default_branch:''}});
  try{
    await assert.rejects(run(t,c),/SETUP_BRANCH_MISSING/);
    assert.equal(c.calls.some(x=>String(x[1]).includes('/branches//protection')),false);
  }finally{t.f.db.close();}
});

test('dos ejecuciones intercaladas: la vieja no pisa workflow ni error de la nueva',async()=>{
  const t=operation(),slow=clients({workflow:false}),fast=clients();
  let resume,signal;
  const paused=new Promise(resolve=>{signal=resolve;});
  slow.github.repo=async()=>{signal();await new Promise(resolve=>{resume=resolve;});return REPO;};
  try{
    const old=run(t,slow);
    await paused;
    const fresh=await run(t,fast);
    assert.equal(fresh.setup.workflow,'PRESENT');
    resume();
    await old;
    const latest=bootstrapStatus(t.f.db,{clientId:t.f.client,operationId:t.operationId,now:T0}).setup;
    assert.equal(latest.workflow,'PRESENT');
    assert.equal(latest.lastError,null);
    assert.equal(latest.runSeq,2);
  }finally{t.f.db.close();}
});
