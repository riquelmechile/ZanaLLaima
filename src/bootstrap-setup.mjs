import {bootstrapStatus,readOperation,saveOperation} from './bootstrap-request.mjs';

const fail=(code,msg)=>{const error=new Error(code+': '+msg);error.code=code;throw error;};
const text=(value,max=200)=>String(value??'').replace(/[\p{Cc}\p{Cf}]/gu,'').slice(0,max);
const enc=value=>encodeURIComponent(String(value));
const writePermission=value=>['push','write','maintain','admin'].includes(String(value??'').toLowerCase());
const protectionBody=()=>({
  required_status_checks:{strict:true,checks:[{context:'zana/4r'}]},
  enforce_admins:true,
  required_pull_request_reviews:{required_approving_review_count:1,dismiss_stale_reviews:true,require_last_push_approval:true},
  restrictions:null,
  required_conversation_resolution:true,
  allow_force_pushes:false,
  allow_deletions:false,
});
const enabled=value=>value===true||value?.enabled===true;
function protectionMatches(value){
  const checks=value?.required_status_checks?.checks;
  const review=value?.required_pull_request_reviews;
  return value?.required_status_checks?.strict===true&&Array.isArray(checks)&&checks.length===1&&checks[0]?.context==='zana/4r'&&
    enabled(value?.enforce_admins)&&review?.required_approving_review_count===1&&review?.dismiss_stale_reviews===true&&
    review?.require_last_push_approval===true&&enabled(value?.required_conversation_resolution)&&value?.restrictions===null&&
    !enabled(value?.allow_force_pushes)&&!enabled(value?.allow_deletions);
}
const upgradeError=error=>error?.status===403&&/upgrade|github pro|protected branch/i.test(String(error.message));
const is404=error=>error?.status===404;
const errorText=error=>text((error?.code?error.code+': ':'')+(error instanceof Error?error.message:String(error)));
const sameRepo=(found,op)=>Number.isSafeInteger(found?.id)&&found.id===op.repository?.id&&
  String(found.full_name??'').toLowerCase()===String(op.repository?.fullName??'').toLowerCase()&&
  String(found.owner?.login??'').toLowerCase()===String(op.intent?.owner??'').toLowerCase();

export async function runBootstrapSetup({rw,rr,github,reviewer,reviewerLogin,workflow,clientId,operationId,now=()=>Date.now()}){
  const at={clientId,operationId},status=()=>rr(db=>bootstrapStatus(db,{...at,now:now()}));
  const initial=await rr(db=>readOperation(db,at));
  if(initial.state!=='DONE')fail('SETUP_NOT_READY','La operación debe estar DONE');
  if(!reviewerLogin||!reviewer?.configured)fail('SETUP_REVIEWER_MISSING','Falta la identidad o el cliente GitHub de la revisora');
  if(!/^[A-Za-z0-9._-]{1,100}\.ya?ml$/.test(String(workflow)))
    fail('SETUP_WORKFLOW_INVALID','El workflow configurado no es un nombre de archivo válido');
  const repo=String(initial.repository?.fullName??''),owner=String(initial.intent?.owner??'');
  const checkedAt=()=>new Date(now()).toISOString();
  let setup={reviewer:'FAILED',protection:'MISMATCH',workflow:'MISSING',checkedAt:checkedAt(),lastError:null,...initial.setup};
  const save=fields=>rw(db=>{
    const current=readOperation(db,at);
    if(current.state!=='DONE'||current.repository?.id!==initial.repository?.id)fail('SETUP_REPO_CHANGED','La operación o su repositorio cambió');
    setup={...setup,...fields,checkedAt:checkedAt()};
    saveOperation(db,{...current,setup,updatedAt:checkedAt()});
  });
  const raise=async error=>{
    const wrapped=error?.code?error:Object.assign(new Error('SETUP_GITHUB_ERROR: '+errorText(error)),{code:'SETUP_GITHUB_ERROR'});
    await save({lastError:errorText(wrapped)});
    throw wrapped;
  };
  try{
    const found=await github.repo(repo);
    if(!sameRepo(found,initial))fail('SETUP_REPO_CHANGED','El repositorio creado ya no coincide con la operación');
    const base='/repos/'+repo.split('/').map(enc).join('/');
    const permissionPath=base+'/collaborators/'+enc(reviewerLogin)+'/permission';
    const permission=async()=>{
      const p=await github.request('GET',permissionPath);
      return writePermission(p?.permission)||writePermission(p?.role_name);
    };
    if(!await permission()){
      await github.request('PUT',base+'/collaborators/'+enc(reviewerLogin),{body:{permission:'push'}});
      const invitations=await reviewer.request('GET','/user/repository_invitations');
      const invitation=Array.isArray(invitations)?invitations.find(item=>
        item?.repository?.id===found.id&&String(item?.inviter?.login??'').toLowerCase()===owner.toLowerCase()):null;
      if(invitation)await reviewer.request('PATCH','/user/repository_invitations/'+enc(invitation.id));
      if(!await permission()){
        await save({reviewer:'FAILED',lastError:'SETUP_REVIEWER_FAILED: la revisora no obtuvo Write'});
        fail('SETUP_REVIEWER_FAILED','La revisora no obtuvo Write sobre el repositorio');
      }
    }
    await save({reviewer:'WRITE',lastError:null});

    const branch=String(found.default_branch??initial.repository?.defaultBranch??'');
    const protectionPath=base+'/branches/'+enc(branch)+'/protection';
    let current=null;
    try{current=await github.request('GET',protectionPath);}catch(error){if(!is404(error))throw error;}
    if(!protectionMatches(current)){
      try{await github.request('PUT',protectionPath,{body:protectionBody()});}
      catch(error){
        if(!upgradeError(error))throw error;
        await save({protection:'UNAVAILABLE',lastError:text(error.message)});
        current='UNAVAILABLE';
      }
      if(current!=='UNAVAILABLE'){
        const verified=await github.request('GET',protectionPath);
        if(!protectionMatches(verified)){
          await save({protection:'MISMATCH',lastError:'SETUP_PROTECTION_MISMATCH: GitHub devolvió otra protección'});
          fail('SETUP_PROTECTION_MISMATCH','La protección verificada no coincide');
        }
        await save({protection:'APPLIED',lastError:null});
      }
    }else await save({protection:'APPLIED',lastError:null});

    try{
      await github.request('GET',base+'/contents/.github/workflows/'+enc(workflow),{withStatus:true});
      await save({workflow:'PRESENT'});
    }catch(error){
      if(!is404(error))throw error;
      await save({workflow:'MISSING'});
    }
    return status();
  }catch(error){
    if(['SETUP_NOT_READY','SETUP_REPO_CHANGED','SETUP_REVIEWER_MISSING','SETUP_REVIEWER_FAILED',
      'SETUP_PROTECTION_MISMATCH','SETUP_WORKFLOW_INVALID'].includes(error?.code))throw error;
    return raise(error);
  }
}
