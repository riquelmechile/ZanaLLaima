// Solicitud de bootstrap: el intento de crear un repositorio para un plan ya
// aprobado, guardado junto a su autorización del operador. Aquí no se crea
// nada en GitHub: eso es de la ejecución, que consulta bootstrapAuthorized.
import {getProjectWorkspace} from './project-workspace.mjs';
import {canonicalPlan,prepareBootstrap,validateBootstrapIntent} from './project-bootstrap.mjs';
import {approvedPlan,requestRepositoryApproval,approvalState} from './plan-approval.mjs';

const PREFIX='zana:bootstrap:',DAY_MS=86400_000;
const OPERATION=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(code,msg)=>{const e=new Error(code+': '+msg);e.code=code;throw e;};
export const saveOperation=(db,op)=>db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
  .run(PREFIX+op.operationId,JSON.stringify(op));
const valid=op=>op?.schema==='zana.bootstrap-op.v1'&&OPERATION.test(String(op.operationId));
const ownOps=(db,clientId)=>db.prepare(`SELECT value FROM metadata WHERE key LIKE 'zana:bootstrap:%'
  AND (CASE WHEN json_valid(value) THEN json_extract(value,'$.ownerClient') END)=?`).all(clientId)
  .map(x=>JSON.parse(x.value)).filter(valid);
export function readOperation(db,{clientId,operationId}){
  const entry=OPERATION.test(String(operationId))?db.prepare('SELECT value FROM metadata WHERE key=?').get(PREFIX+operationId):null;
  let op=null;
  try{op=entry?JSON.parse(entry.value):null;}catch{}
  if(!valid(op)||op.operationId!==operationId||op.ownerClient!==clientId)fail('BOOTSTRAP_NOT_FOUND','No existe esa operación de bootstrap');
  return op;
}
const repoOf=intent=>intent.owner+'/'+intent.name;
function view(op,authorization){
  const open=['PENDING','APPROVED'].includes(authorization.status);
  return {operationId:op.operationId,state:op.state,repository:repoOf(op.intent),visibility:op.intent.visibility,
    planDigest:op.intent.planDigest,intentDigest:op.intent.digest,
    // created: el repositorio ya creado; lastError: por qué falló el último intento.
    created:op.repository??null,lastError:op.lastError??null,
    setup:op.setup??null,
    authorization:{status:authorization.status,approvalId:open?authorization.approvalId:null,
      expiresAt:open?authorization.expiresAt:null}};
}

// allowed(repo) lo entrega el servidor desde ZANA_GITHUB_REPOS.
export function requestBootstrap(db,{clientId,workspaceId,expectedVersion,owner,name,visibility='private',allowed,now=Date.now()}){
  const ws=getProjectWorkspace(db,{clientId,workspaceId});
  if(expectedVersion!==ws.version)fail('STALE_REVISION','Pide el repositorio sobre la versión vigente del proyecto');
  const plan=approvedPlan(db,{clientId,workspaceId}),planDigest=plan?.planDigest;
  if(!plan)fail('PLAN_NOT_APPROVED','El operador debe aprobar el plan vigente antes de pedir su repositorio');
  const intent=prepareBootstrap(canonicalPlan(ws.plan),{owner,name,visibility});
  const repo=repoOf(intent);
  if(typeof allowed!=='function'||allowed(repo)!==true)fail('REPO_NOT_ALLOWED',JSON.stringify(repo)+' no está permitido por ZANA_GITHUB_REPOS');
  const ops=ownOps(db,clientId);
  // Una operación sin ejecutar se borra a los dos días de su último uso.
  const idle=x=>x.state==='AWAITING_AUTHORIZATION'&&now-Date.parse(x.updatedAt)>=2*DAY_MS;
  for(const old of ops)if(idle(old))db.prepare('DELETE FROM metadata WHERE key=?').run(PREFIX+old.operationId);
  // Ese repositorio ya se creó o tiene un intento en curso para este proyecto: se devuelve esa operación, sin pedir otra autorización.
  const started=ops.find(x=>x.workspaceId===workspaceId&&x.state!=='AWAITING_AUTHORIZATION'&&repoOf(x.intent).toLowerCase()===repo.toLowerCase());
  if(started)return view(started,approvalState(db,{clientId,approvalId:started.approvalId,now})??{status:'EXPIRED'});
  const same=x=>x.workspaceId===workspaceId&&x.state==='AWAITING_AUTHORIZATION'&&!idle(x)&&
    x.intent.planDigest===planDigest&&repoOf(x.intent).toLowerCase()===repo.toLowerCase()&&x.intent.visibility===intent.visibility;
  const op=ops.find(same)??{schema:'zana.bootstrap-op.v1',operationId:intent.operationId,ownerClient:clientId,workspaceId,
    intent,state:'AWAITING_AUTHORIZATION',approvalId:null,repository:null,createdAt:new Date(now).toISOString()};
  const authorization=requestRepositoryApproval(db,{clientId,workspaceId,plan,now,
    subject:{operationId:op.operationId,intentDigest:op.intent.digest,repo:repoOf(op.intent),visibility:op.intent.visibility}});
  saveOperation(db,{...op,approvalId:authorization.approvalId,updatedAt:new Date(now).toISOString()});
  return view(op,authorization);
}

export function bootstrapStatus(db,{clientId,operationId,now=Date.now()}){
  const op=readOperation(db,{clientId,operationId});
  return view(op,approvalState(db,{clientId,approvalId:op.approvalId,now})??{status:'EXPIRED'});
}

// Lo que consulta la ejecución antes de crear: la autorización del operador
// sigue vigente y es de este intento exacto y de este plan.
export function bootstrapAuthorized(db,{clientId,operationId,now=Date.now()}){
  try{
    const op=readOperation(db,{clientId,operationId});
    validateBootstrapIntent(op.intent);
    const a=approvalState(db,{clientId,approvalId:op.approvalId,now});
    return a?.status==='APPROVED'&&a.effect==='CREATE_REPOSITORY'&&a.subject?.operationId===op.operationId&&
      a.subject.intentDigest===op.intent.digest&&a.planDigest===op.intent.planDigest&&
      a.subject.repo===repoOf(op.intent)&&a.subject.visibility===op.intent.visibility;
  }catch{return false;}
}
