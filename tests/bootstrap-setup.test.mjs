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
        if(opts.protectionMissing&&!state.applied)throw new GitHubApiError(404,'Not Found');
        return state.protection;
      }
      if(method==='PUT'&&path.includes('/branches/')&&path.endsWith('/protection')){
        if(opts.protection403)throw new GitHubApiError(403,'Upgrade to GitHub Pro to use protected branches');
        state.applied=true;state.protection=opts.afterProtection??body;return null;
      }
      if(method==='GET'&&path.includes('/contents/.github/workflows/')){
        if(opts.workflow===false)throw new GitHubApiError(404,'Not Found');
        return withStatus?{status:200,data:{type:'file'}}:{type:'file'};
      }
      throw new Error('unexpected '+method+' '+path);
    }};
  const reviewer={configured:opts.reviewerConfigured!==false,calls,async request(method,path){
    calls.push(['R:'+method,path]);
    if(method==='GET')return opts.invitations??(state.invited?[{id:9,repository:{id:77},inviter:{login:'acme'}}]:[]);
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
