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
const disabled=value=>value===false||value?.enabled===false;
function protectionMatches(value){
  const required=value?.required_status_checks,review=value?.required_pull_request_reviews;
  const checks=Array.isArray(required?.checks)?required.checks.map(x=>x?.context):required?.contexts;
  return required?.strict===true&&Array.isArray(checks)&&checks.length===1&&checks[0]==='zana/4r'&&
    enabled(value?.enforce_admins)&&review?.required_approving_review_count===1&&review?.dismiss_stale_reviews===true&&
    review?.require_last_push_approval===true&&enabled(value?.required_conversation_resolution)&&
    (value?.restrictions==null)&&disabled(value?.allow_force_pushes)&&disabled(value?.allow_deletions);
}
const upgradeError=error=>error?.status===403&&
  /upgrade\s+to\s+github\s+(?:pro|team|enterprise)|(?:upgrade|paid)\s+(?:your\s+)?plan/i.test(String(error.message));
const is404=error=>error?.status===404;
const errorText=error=>{
  const message=text(error instanceof Error?error.message:String(error));
  return error?.code&&!message.startsWith(error.code+': ')?text(error.code+': '+message):message;
};
const sameRepo=(found,op)=>Number.isSafeInteger(found?.id)&&found.id===op.repository?.id&&
  String(found.full_name??'').toLowerCase()===String(op.repository?.fullName??'').toLowerCase()&&
  String(found.owner?.login??'').toLowerCase()===String(op.intent?.owner??'').toLowerCase();

export async function runBootstrapSetup({rw,rr,github,reviewer,reviewerLogin,workflow,clientId,operationId,now=()=>Date.now()}){
  const at={clientId,operationId},status=()=>rr(db=>bootstrapStatus(db,{...at,now:now()}));
  const initial=await rr(db=>readOperation(db,at));
  if(initial.state!=='DONE')fail('SETUP_NOT_READY','La operación debe estar DONE');
  if(!reviewerLogin||!reviewer?.configured)fail('SETUP_REVIEWER_MISSING','Falta la identidad o el cliente GitHub de la revisora');
  const repo=String(initial.repository?.fullName??''),owner=String(initial.intent?.owner??'');
  const workflowName=typeof workflow==='function'?workflow(repo):workflow;
  if(!/^[A-Za-z0-9._-]{1,100}\.ya?ml$/.test(String(workflowName)))
    fail('SETUP_WORKFLOW_INVALID','El workflow configurado no es un nombre de archivo válido');
  const checkedAt=()=>new Date(now()).toISOString();
  // Una ejecución vieja no debe sobrescribir un dato comprobado por una ejecución posterior.
  const runSeq=await rw(db=>{
    const current=readOperation(db,at);
    if(current.state!=='DONE'||current.repository?.id!==initial.repository?.id)
      fail('SETUP_REPO_CHANGED','La operación o su repositorio cambió');
    const prior=current.setup??{reviewer:null,protection:null,workflow:null,checkedAt:null,lastError:null};
    const seq=(prior.runSeq??0)+1;
    saveOperation(db,{...current,setup:{...prior,runSeq:seq},updatedAt:checkedAt()});
    return seq;
  });
  // El mensaje preciso solo pertenece a la ejecución actual, nunca a una corrida anterior.
  let currentDetailedError=null;
  const save=fields=>rw(db=>{
    const current=readOperation(db,at);
    if(current.state!=='DONE'||current.repository?.id!==initial.repository?.id)
      fail('SETUP_REPO_CHANGED','La operación o su repositorio cambió');
    if(current.setup?.runSeq!==runSeq)return;
    const verified=['reviewer','protection','workflow'].some(field=>Object.hasOwn(fields,field));
    const priorDates=current.setup?.checkedAt;
    const dates=priorDates&&typeof priorDates==='object'?{...priorDates}:
      {reviewer:null,protection:null,workflow:null};
    if(verified)for(const field of ['reviewer','protection','workflow'])if(Object.hasOwn(fields,field))dates[field]=checkedAt();
    const setup={...current.setup,...fields,checkedAt:dates};
    saveOperation(db,{...current,setup,updatedAt:checkedAt()});
  });
  const raise=async error=>{
    const wrapped=error?.code?error:Object.assign(new Error('SETUP_GITHUB_ERROR: '+errorText(error)),{code:'SETUP_GITHUB_ERROR'});
    // Incluso si cambió el repositorio, registrar el error sin alterar los checks previos.
    await rw(db=>{
      const current=readOperation(db,at);
      if(current.setup?.runSeq!==runSeq)return;
      const precise=currentDetailedError?.startsWith(wrapped.code+': ');
      saveOperation(db,{...current,setup:{...current.setup,
        lastError:precise?currentDetailedError:errorText(wrapped)},updatedAt:checkedAt()});
    });
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
      let invitation=null;
      for(let page=1;page<=10;page++){
        const invitations=await reviewer.request('GET','/user/repository_invitations?per_page=100&page='+page);
        if(!Array.isArray(invitations))fail('SETUP_INVITATIONS_INVALID','GitHub devolvió invitaciones inválidas');
        invitation=invitations.find(item=>item?.repository?.id===found.id&&
          String(item?.inviter?.login??'').toLowerCase()===owner.toLowerCase());
        if(invitation||invitations.length<100)break;
      }
      if(invitation)await reviewer.request('PATCH','/user/repository_invitations/'+enc(invitation.id));
      if(!await permission()){
        currentDetailedError='SETUP_REVIEWER_FAILED: la revisora no obtuvo Write';
        await save({reviewer:'FAILED',lastError:currentDetailedError});
        fail('SETUP_REVIEWER_FAILED','La revisora no obtuvo Write sobre el repositorio');
      }
    }
    await save({reviewer:'WRITE',lastError:null});

    const branch=String(found.default_branch??initial.repository?.defaultBranch??'').trim();
    if(!branch)fail('SETUP_BRANCH_MISSING','El repositorio no tiene rama por defecto');
    const protectionPath=base+'/branches/'+enc(branch)+'/protection';
    let current=null,unavailable=false;
    try{current=await github.request('GET',protectionPath);}
    catch(error){
      if(upgradeError(error)){unavailable=true;await save({protection:'UNAVAILABLE',lastError:text(error.message)});}
      else if(!is404(error))throw error;
    }
    if(!unavailable&&!protectionMatches(current)){
      try{await github.request('PUT',protectionPath,{body:protectionBody()});}
      catch(error){
        if(!upgradeError(error))throw error;
        unavailable=true;
        await save({protection:'UNAVAILABLE',lastError:text(error.message)});
      }
      if(!unavailable){
        const verified=await github.request('GET',protectionPath);
        if(!protectionMatches(verified)){
          currentDetailedError='SETUP_PROTECTION_MISMATCH: GitHub devolvió otra protección';
          await save({protection:'MISMATCH',lastError:currentDetailedError});
          fail('SETUP_PROTECTION_MISMATCH','La protección verificada no coincide');
        }
        await save({protection:'APPLIED',lastError:null});
      }
    }else if(!unavailable)await save({protection:'APPLIED',lastError:null});

    try{
      await github.request('GET',base+'/contents/.github/workflows/'+enc(workflowName));
      await save({workflow:'PRESENT'});
    }catch(error){
      if(!is404(error))throw error;
      await save({workflow:'MISSING'});
    }
    return status();
  }catch(error){return raise(error);}
}
