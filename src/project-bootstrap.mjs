// Bootstrap administrativo, inyectable en el backend; no es una herramienta MCP.
// Ninguna afirmación del modelo autoriza una creación ni un reintento incierto.
import {createHash,randomUUID} from 'node:crypto';
import {draftProjectPlan} from './project-discovery.mjs';

const REPO_PART=/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$/;
const SHA=/^[0-9a-f]{64}$/;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(code,message)=>{const error=new Error(code+': '+message);error.code=code;throw error;};
const own=(o,keys)=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&
  [Object.prototype,null].includes(Object.getPrototypeOf(o))&&Object.keys(o).every(k=>keys.includes(k));
const validPart=value=>typeof value==='string'&&REPO_PART.test(value)&&!['.','..'].includes(value)&&!value.endsWith('.lock');

export function validateBootstrapPlan(plan){
  if(!own(plan,['schema','brief','alternatives','selectedId','milestones','digest','approval'])||
    plan.schema!=='zana.project-plan.v1'||!SHA.test(plan.digest)||plan.approval!=='PENDING_AUTHENTICATED_USER')
    fail('INVALID_PLAN','Se requiere un plan Discovery íntegro y sin aprobación declarada');
  if(!own(plan.brief,['idea','answers','revision']))fail('INVALID_PLAN','Brief inválido');
  const recalculated=draftProjectPlan({brief:{...plan.brief,schema:'zana.discovery.v1',status:'READY_FOR_PLAN'},
    alternatives:plan.alternatives,selectedId:plan.selectedId,milestones:plan.milestones});
  if(recalculated.digest!==plan.digest)fail('PLAN_TAMPERED','El digest no corresponde al contenido');
  return plan.digest;
}

export function prepareBootstrap(plan,{owner,name,visibility='private',provider='github'}={}){
  const planDigest=validateBootstrapPlan(plan);
  if(provider!=='github')fail('UNSUPPORTED_PROVIDER','Proveedor no autorizado para creación');
  if(!validPart(owner)||!validPart(name))fail('INVALID_REPOSITORY','Propietario o repositorio inválido');
  if(!['private','public'].includes(visibility))fail('INVALID_VISIBILITY','Visibilidad inválida');
  const intent={schema:'zana.bootstrap.v1',operationId:randomUUID(),
    planDigest,provider,owner,name,visibility,defaultBranch:'main'};
  return Object.freeze({...intent,digest:hash(intent),status:'AWAITING_AUTHORIZATION'});
}

export function validateBootstrapIntent(intent){
  if(!own(intent,['schema','operationId','planDigest','provider','owner','name','visibility','defaultBranch','digest','status'])||
    intent.schema!=='zana.bootstrap.v1'||intent.provider!=='github'||intent.defaultBranch!=='main'||
    intent.status!=='AWAITING_AUTHORIZATION'||!SHA.test(intent.planDigest)||!SHA.test(intent.digest)||
    !/^[0-9a-f-]{36}$/i.test(intent.operationId)||!validPart(intent.owner)||!validPart(intent.name)||
    !['private','public'].includes(intent.visibility))fail('INVALID_INTENT','Intento bootstrap inválido');
  const {digest,status,...body}=intent;
  if(hash(body)!==digest)fail('INTENT_TAMPERED','El intento fue alterado');
  return true;
}

// Exclusivo del proceso autenticado: todos los callbacks deben provenir del
// servidor y el ledger ha de persistir cada transición antes del efecto.
export async function executeBootstrap(intent,{authorize,reserve,markUncertain,createRepository,commit}={}){
  validateBootstrapIntent(intent);
  if([authorize,reserve,markUncertain,createRepository,commit].some(f=>typeof f!=='function'))
    fail('BACKEND_UNAVAILABLE','Faltan servicios autenticados y persistentes');
  const approved=await authorize({digest:intent.digest,planDigest:intent.planDigest,
    operation:'create_repository',repo:intent.owner+'/'+intent.name,visibility:intent.visibility});
  if(approved!==true)fail('AUTHORIZATION_REQUIRED','No existe consentimiento verificado por el backend');
  const slot=await reserve({operationId:intent.operationId,digest:intent.digest});
  if(slot?.digest!==intent.digest)fail('RESERVATION_MISMATCH','La reserva tiene otro digest');
  if(slot.state==='DONE')return Object.freeze({state:'DONE',repository:slot.repository,reused:true});
  if(slot.state!=='RESERVED')fail('RECONCILIATION_REQUIRED','Intento previo con resultado incierto');
  // Registrar durablemente UNCERTAIN antes del efecto remoto: nunca reintentar
  // ciegamente POST /user/repos tras un timeout o caída.
  await markUncertain({operationId:intent.operationId,digest:intent.digest});
  let repository;
  try{repository=await createRepository({owner:intent.owner,name:intent.name,
    private:intent.visibility==='private',operationId:intent.operationId});}
  catch{fail('OUTCOME_UNKNOWN','Reconciliar el ID del repositorio antes de otro intento');}
  if(!Number.isSafeInteger(repository?.id)||repository.id<1||
    repository.full_name?.toLowerCase()!==(intent.owner+'/'+intent.name).toLowerCase())
    fail('OUTCOME_UNKNOWN','Respuesta GitHub sin identidad verificable; reconciliar');
  try{await commit({operationId:intent.operationId,digest:intent.digest,repository});}
  catch{fail('OUTCOME_UNKNOWN','Repositorio creado pero resultado local no confirmado; reconciliar');}
  return Object.freeze({state:'DONE',repository,reused:false,
    needsOperatorSetup:['branch-protection','workflow-ci','allowlist-repo']});
}
