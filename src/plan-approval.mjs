// Aprobación del plan de un proyecto, ligada a su digest exacto.
// El modelo solo puede pedirla y consultarla. La decisión entra por la página
// del operador (src/operator-page.mjs) con la contraseña del operador: aquí
// ningún argumento de una tool aprueba nada. Aprobar el plan no concede
// permiso para crear repositorios, fusionar ni desplegar.
import {randomBytes} from 'node:crypto';
import {getProjectWorkspace} from './project-workspace.mjs';
import {canonicalPlan} from './project-bootstrap.mjs';

export const APPROVAL_ID=/^[A-Za-z0-9_-]{43}$/;
const PREFIX='zana:approval:';
const PENDING_TTL_MS=3600_000,DAY_MS=86400_000;
const MAX_REQUESTS_PER_DAY=20,MAX_FAILURES=6;
const fail=(code,msg)=>{const e=new Error(code+': '+msg);e.code=code;throw e;};
const iso=ms=>new Date(ms).toISOString();
const save=(db,row)=>db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
  .run(PREFIX+row.approvalId,JSON.stringify(row));
const drop=(db,row)=>db.prepare('DELETE FROM metadata WHERE key=?').run(PREFIX+row.approvalId);
const valid=row=>row?.schema==='zana.approval.v1'&&APPROVAL_ID.test(String(row.approvalId));
function ownRows(db,clientId){
  return db.prepare(`SELECT value FROM metadata WHERE key LIKE 'zana:approval:%'
    AND (CASE WHEN json_valid(value) THEN json_extract(value,'$.ownerClient') END)=?`).all(clientId)
    .map(x=>JSON.parse(x.value)).filter(valid);
}
function read(db,approvalId){
  if(!APPROVAL_ID.test(String(approvalId)))fail('APPROVAL_NOT_FOUND','No existe esa solicitud');
  const entry=db.prepare('SELECT value FROM metadata WHERE key=?').get(PREFIX+approvalId);
  let row=null;
  try{row=entry?JSON.parse(entry.value):null;}catch{}
  if(!valid(row)||row.approvalId!==approvalId)fail('APPROVAL_NOT_FOUND','No existe esa solicitud');
  return row;
}
// Digest del plan vigente; null si no hay plan o el proyecto está archivado.
const liveDigest=ws=>ws.archivedAt?null:ws.plan?.digest??null;
// Estado de UNA solicitud visto desde fuera. Precedencia: EXPIRED, luego
// LOCKED, luego SUPERSEDED (su plan ya no es el vigente); los estados finales
// (DENIED, REVOKED, REPLACED) se devuelven tal cual.
function effective(row,digest,now){
  if(row.status==='PENDING'&&now>=Date.parse(row.expiresAt))return 'EXPIRED';
  if(row.status==='PENDING'&&row.failures>=MAX_FAILURES)return 'LOCKED';
  if(['PENDING','APPROVED'].includes(row.status)&&row.planDigest!==digest)return 'SUPERSEDED';
  return row.status;
}
const approvedRow=(rows,workspaceId,digest)=>digest===null?null:
  rows.find(x=>x.workspaceId===workspaceId&&x.status==='APPROVED'&&x.planDigest===digest)??null;

export function requestPlanApproval(db,{clientId,workspaceId,expectedVersion,now=Date.now()}){
  const ws=getProjectWorkspace(db,{clientId,workspaceId});
  if(expectedVersion!==ws.version)fail('STALE_REVISION','Pide la aprobación sobre la versión vigente del proyecto');
  if(ws.archivedAt)fail('WORKSPACE_ARCHIVED','Restaura el proyecto antes de pedir su aprobación');
  if(!ws.plan)fail('PLAN_REQUIRED','Guarda un plan en el proyecto antes de pedir su aprobación');
  const planDigest=canonicalPlan(ws.plan).digest;
  let rows=ownRows(db,clientId);
  for(const old of rows.filter(x=>x.status!=='APPROVED'&&now-Date.parse(x.createdAt)>=DAY_MS))drop(db,old);
  rows=rows.filter(x=>x.status==='APPROVED'||now-Date.parse(x.createdAt)<DAY_MS);
  const approved=approvedRow(rows,workspaceId,planDigest);
  if(approved)return {approvalId:approved.approvalId,status:'APPROVED',planDigest,expiresAt:null};
  const mine=rows.filter(x=>x.workspaceId===workspaceId&&x.status==='PENDING');
  const open=mine.find(x=>effective(x,planDigest,now)==='PENDING');
  if(open)return {approvalId:open.approvalId,status:'PENDING',planDigest,expiresAt:open.expiresAt};
  if(rows.filter(x=>now-Date.parse(x.createdAt)<DAY_MS).length>=MAX_REQUESTS_PER_DAY)
    fail('APPROVAL_RATE_EXCEEDED','Máximo '+MAX_REQUESTS_PER_DAY+' solicitudes de aprobación por día');
  for(const old of mine)save(db,{...old,status:'REPLACED'});
  const row={schema:'zana.approval.v1',approvalId:randomBytes(32).toString('base64url'),ownerClient:clientId,
    effect:'PROJECT_PLAN',workspaceId,planDigest,status:'PENDING',failures:0,
    createdAt:iso(now),expiresAt:iso(now+PENDING_TTL_MS),decidedAt:null};
  save(db,row);
  return {approvalId:row.approvalId,status:'PENDING',planDigest,expiresAt:row.expiresAt};
}

// Lo que consumen las fases siguientes: el digest aprobado, o null.
export function approvedPlanDigest(db,{clientId,workspaceId}){
  let ws;
  try{ws=getProjectWorkspace(db,{clientId,workspaceId});}catch{return null;}
  return approvedRow(ownRows(db,clientId),workspaceId,liveDigest(ws))?.planDigest??null;
}

export function planApprovalStatus(db,{clientId,workspaceId,now=Date.now()}){
  const ws=getProjectWorkspace(db,{clientId,workspaceId});
  const digest=liveDigest(ws);
  const rows=ownRows(db,clientId).filter(x=>x.workspaceId===workspaceId)
    .sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
  // Solo cuentan las solicitudes del plan vigente: la decisión sobre otro plan
  // no se le atribuye a este.
  const current=digest===null?[]:rows.filter(x=>x.planDigest===digest&&x.status!=='REPLACED');
  const row=current.find(x=>x.status==='APPROVED')??current.find(x=>x.status==='PENDING')??current[0]??null;
  const status=row?effective(row,digest,now):rows.length?'SUPERSEDED':'NONE';
  const open=['PENDING','APPROVED'].includes(status);
  return {workspaceId,version:ws.version,planDigest:ws.plan?.digest??null,status,
    approvalId:open?row.approvalId:null,expiresAt:status==='PENDING'?row.expiresAt:null,decidedAt:row?.decidedAt??null};
}

// Vista para la página del operador: sin identidad OAuth, y con el plan
// completo (todo lo que cubre el digest) solo cuando el plan vigente es el
// mismo que se pidió aprobar.
export function describePlanApproval(db,{approvalId,now=Date.now()}){
  const row=read(db,approvalId);
  const ws=getProjectWorkspace(db,{clientId:row.ownerClient,workspaceId:row.workspaceId});
  let plan=null;
  try{plan=ws.plan?.digest===row.planDigest?canonicalPlan(ws.plan):null;}catch{}
  return {approvalId,status:effective(row,liveDigest(ws),now),planDigest:row.planDigest,
    expiresAt:row.expiresAt,decidedAt:row.decidedAt,attemptsLeft:Math.max(0,MAX_FAILURES-row.failures),
    // La aprobación guardada se puede retirar aunque su plan ya no sea el vigente.
    revocable:row.status==='APPROVED',
    plan:plan&&{idea:plan.brief.idea,answers:plan.brief.answers,selectedId:plan.selectedId,
      alternatives:plan.alternatives,milestones:plan.milestones}};
}

// passwordOk lo calcula la capa HTTP contra la contraseña del operador; nunca
// llega desde una tool. Una contraseña errada o un plan que ya cambió se
// devuelven (no se lanzan) para que el fallo quede guardado.
export function decidePlanApproval(db,{approvalId,decision,passwordOk,now=Date.now()}){
  const row=read(db,approvalId);
  const out=status=>({status,workspaceId:row.workspaceId,planDigest:row.planDigest});
  // Revocar retira una aprobación ya dada. Como rechazar, va hacia el lado
  // seguro y no pide contraseña: basta el enlace de la solicitud.
  if(decision==='revoke'){
    if(row.status!=='APPROVED')fail('APPROVAL_NOT_APPROVED','Solo se revoca una aprobación vigente');
    save(db,{...row,status:'REVOKED',decidedAt:iso(now)});
    return out('REVOKED');
  }
  if(row.status!=='PENDING')fail('APPROVAL_NOT_PENDING','Esta solicitud ya fue decidida o reemplazada');
  if(now>=Date.parse(row.expiresAt))fail('APPROVAL_EXPIRED','La solicitud caducó; pide una nueva');
  if(row.failures>=MAX_FAILURES)fail('APPROVAL_LOCKED','Solicitud bloqueada por intentos fallidos; pide una nueva');
  if(!['allow','deny'].includes(decision))fail('INVALID_DECISION','La decisión debe ser allow, deny o revoke');
  if(decision==='deny'){
    save(db,{...row,status:'DENIED',decidedAt:iso(now)});
    return out('DENIED');
  }
  if(passwordOk!==true){
    row.failures++;save(db,row);
    return {...out(row.failures>=MAX_FAILURES?'LOCKED':'PENDING'),denied:true,attemptsLeft:MAX_FAILURES-row.failures};
  }
  const ws=getProjectWorkspace(db,{clientId:row.ownerClient,workspaceId:row.workspaceId});
  if(liveDigest(ws)!==row.planDigest){
    save(db,{...row,status:'SUPERSEDED',decidedAt:iso(now)});
    return out('SUPERSEDED');
  }
  for(const old of ownRows(db,row.ownerClient))
    if(old.workspaceId===row.workspaceId&&old.status==='APPROVED')drop(db,old);
  save(db,{...row,status:'APPROVED',decidedAt:iso(now)});
  return out('APPROVED');
}
