import {GitHubApiError} from './github-api.mjs';

const METHODS=new Set(['GET','POST','PUT','PATCH','DELETE']);
const INVITATIONS=/^\/user\/repository_invitations(?:\/\d+)?$/;
const CONTROL=/[\u0000-\u001f\u007f]/;

export function validateGithubAdmin(input){
  if(!METHODS.has(input.method))throw new Error('METHOD: método GitHub no permitido');
  const path=String(input.path??'');
  if(path.length>2000||!path.startsWith('/')||path.startsWith('//')||path.includes('..')||
     path.includes('\\')||CONTROL.test(path)||/^https?:/i.test(path))
    throw new Error('PATH: ruta REST GitHub inválida');
  if(input.accept!==undefined&&!/^application\/vnd\.github[^\r\n]*$/i.test(input.accept))
    throw new Error('ACCEPT: solo application/vnd.github*');
  if(input.body!==undefined){
    if(!input.body||Array.isArray(input.body)||typeof input.body!=='object')throw new Error('BODY: se requiere un objeto JSON');
    if(Buffer.byteLength(JSON.stringify(input.body),'utf8')>1_048_576)throw new Error('BODY: máximo 1 MB');
  }
  const identity=input.identity??'owner';
  if(identity==='reviewer'){
    const allowed=input.method==='GET'&&path.split('?')[0]==='/user/repository_invitations'||
      ['PATCH','DELETE'].includes(input.method)&&/^\/user\/repository_invitations\/\d+$/.test(path.split('?')[0]);
    if(!allowed)throw new Error('REVIEWER_SCOPE: la revisora solo administra sus invitaciones');
  }
  return {...input,path,identity};
}
const bounded=data=>{
  const json=JSON.stringify(data);
  return Buffer.byteLength(json,'utf8')<=64_000?{data}:{data:json.slice(0,64_000),truncated:true};
};
export async function githubAdminRequest(raw,clients){
  const input=validateGithubAdmin(raw);
  const api=clients[input.identity];
  try{
    const {status,data}=await api.request(input.method,input.path,{body:input.body,accept:input.accept,withStatus:true});
    return {status,...bounded(data)};
  }catch(error){
    const status=error instanceof GitHubApiError?error.status:502;
    return {status,data:{message:error instanceof Error?error.message:String(error)},error:true};
  }
}
export function githubAdminAudit(input,status){
  return {method:input?.method,path:String(input?.path??'').split('?')[0],status:status??null,identity:input?.identity??'owner'};
}
