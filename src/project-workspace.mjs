// Borradores de proyecto aislados por cliente OAuth, en la misma SQLite.
// No guarda aprobaciones, credenciales ni permisos para crear repositorios.
import {randomUUID} from 'node:crypto';
import {startDiscovery,answerDiscovery} from './project-discovery.mjs';
import {canonicalPlan} from './project-bootstrap.mjs';
import {redactStored,envSecrets} from './redact.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREFIX='zana:workspace:';
const MAX_BYTES=60000;
const MAX_WORKSPACES_PER_CLIENT=50;
const redactValue=value=>typeof value==='string'?redactStored(value,envSecrets()):
  Array.isArray(value)?value.map(redactValue):
  value&&typeof value==='object'?Object.fromEntries(
    Object.entries(value).map(([k,v])=>[k,redactValue(v)])):value;
const different=(a,b)=>JSON.stringify(a)!==JSON.stringify(b);
const fail=(code,msg)=>{const e=new Error(code+': '+msg);e.code=code;throw e;};
const validActor=clientId=>typeof clientId==='string'&&clientId.length>=3&&clientId.length<=200;
const view=row=>{
  const brief=redactValue(row.brief),plan=redactValue(row.plan);
  // Legacy rows may contain secrets: never echo them, or a plan whose
  // content changed but whose digest still describes the unredacted version.
  return {workspaceId:row.workspaceId,version:row.version,brief,
    plan:different(plan,row.plan)?null:plan,
    createdAt:row.createdAt,updatedAt:row.updatedAt,
    archivedAt:row.archivedAt??null};
};
const safe=v=>{
  const size=Buffer.byteLength(JSON.stringify(v));
  if(size>MAX_BYTES)fail('WORKSPACE_TOO_LARGE','El borrador supera el límite permitido');
  return JSON.stringify(v);
};
const key=id=>PREFIX+id;
function readRaw(db,{workspaceId,clientId}){
  if(!UUID.test(String(workspaceId))||!validActor(clientId))
    fail('WORKSPACE_NOT_FOUND','Identificador o conexión inválidos');
  const entry=db.prepare('SELECT value FROM metadata WHERE key=?').get(key(workspaceId));
  if(!entry)fail('WORKSPACE_NOT_FOUND','No existe un borrador accesible');
  let row;
  try{row=JSON.parse(entry.value);}catch{fail('WORKSPACE_CORRUPT','El borrador almacenado es ilegible');}
  if(row?.ownerClient!==clientId)fail('WORKSPACE_NOT_FOUND','No existe un borrador accesible');
  if(row?.schema!=='zana.workspace.v1'||row.workspaceId!==workspaceId||
    !Number.isSafeInteger(row.version)||row.version<0)
    fail('WORKSPACE_CORRUPT','Metadatos del borrador inválidos');
  return row;
}
export function createProjectWorkspace(db,{clientId,idea}){
  if(!validActor(clientId))fail('WORKSPACE_ACTOR_REQUIRED','Se requiere un cliente OAuth autenticado');
  // Hard quota includes archived rows; no unlimited accumulation from model loops.
  const count=db.prepare(`SELECT COUNT(*) AS n FROM metadata
    WHERE key LIKE 'zana:workspace:%' AND
    (CASE WHEN json_valid(value) THEN json_extract(value,'$.ownerClient') END)=?`).get(clientId)?.n??0;
  if(count>=MAX_WORKSPACES_PER_CLIENT)fail('WORKSPACE_QUOTA_EXCEEDED','Máximo 50 borradores por cliente OAuth');
  const brief=startDiscovery(redactValue(idea));
  const now=new Date().toISOString(),workspaceId=randomUUID();
  const row={schema:'zana.workspace.v1',workspaceId,ownerClient:clientId,version:0,
    brief,plan:null,createdAt:now,updatedAt:now};
  db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(key(workspaceId),safe(row));
  return view(row);
}
export function getProjectWorkspace(db,args){return view(readRaw(db,args));}
export function updateProjectWorkspace(db,{clientId,workspaceId,expectedVersion,answers,plan}){
  const row=readRaw(db,{clientId,workspaceId});
  if(!Number.isSafeInteger(expectedVersion)||expectedVersion!==row.version)
    fail('STALE_REVISION','Otro cambio actualizó el borrador');
  if(row.archivedAt)fail('WORKSPACE_ARCHIVED','Restaura el proyecto antes de editarlo');
  if((answers===undefined)===(plan===undefined))
    fail('INVALID_WORKSPACE_UPDATE','Enviar respuestas o plan, pero no ambos');
  if(answers!==undefined){
    row.brief=answerDiscovery(row.brief,redactValue(answers));
    row.plan=null; // cualquier nueva respuesta invalida el plan anterior
  }else{
    // Nunca reescribir un plan firmado tras redactar: cambiaría su digest.
    // Debe regenerarse a partir de un brief ya saneado.
    if(different(plan,redactValue(plan)))fail('WORKSPACE_SECRET_DETECTED','Regenera el plan sin credenciales');
    // Se guarda la forma canónica: variantes equivalentes (espacios, NFC, forma
    // de una URL) comparten digest y no deben quedar almacenadas tal cual.
    const canonical=canonicalPlan(plan);
    // El chequeo de secretos también corre sobre lo que de verdad se guarda.
    if(different(canonical,redactValue(canonical)))fail('WORKSPACE_SECRET_DETECTED','Regenera el plan sin credenciales');
    const brief=canonical.brief,current=row.brief;
    const norm=o=>JSON.stringify(Object.entries(o).sort(([a],[b])=>a.localeCompare(b)));
    if(brief.idea!==current.idea||brief.revision!==current.revision||
      norm(brief.answers)!==norm(current.answers))
      fail('PLAN_BRIEF_MISMATCH','El plan no corresponde al briefing vigente');
    row.plan=canonical;
  }
  row.version++;row.updatedAt=new Date().toISOString();
  db.prepare('UPDATE metadata SET value=? WHERE key=?').run(safe(row),key(workspaceId));
  return view(row);
}

// Página ordenada por UUID: no devuelve respuestas ni planes completos.
// La búsqueda filtra por identidad OAuth dentro de SQLite antes de devolver
// metadatos. Una fila corrupta de otro cliente nunca altera su respuesta.
export function listProjectWorkspaces(db,{clientId,limit=10,cursor=null,includeArchived=false}={}){
  if(!validActor(clientId))fail('WORKSPACE_ACTOR_REQUIRED','Se requiere un cliente OAuth autenticado');
  if(!Number.isInteger(limit)||limit<1||limit>30||typeof includeArchived!=='boolean')
    fail('INVALID_WORKSPACE_LIST','Parámetros de lista inválidos');
  if(cursor!==null&&!UUID.test(String(cursor)))fail('INVALID_CURSOR','Cursor inválido');
  const rows=db.prepare(`SELECT key,value FROM metadata
    WHERE key LIKE 'zana:workspace:%' AND key > ?
      AND (CASE WHEN json_valid(value) THEN json_extract(value,'$.ownerClient') END)=?
      AND (?=1 OR (CASE WHEN json_valid(value) THEN json_extract(value,'$.archivedAt') END) IS NULL)
    ORDER BY key LIMIT ?`).all(cursor?key(cursor):PREFIX,clientId,includeArchived?1:0,limit+1);
  const visible=rows.slice(0,limit).map(entry=>{
    let row;try{row=JSON.parse(entry.value);}catch{fail('WORKSPACE_CORRUPT','Borrador propio ilegible');}
    if(row?.schema!=='zana.workspace.v1'||!UUID.test(String(row.workspaceId))||
      key(row.workspaceId)!==entry.key||row.ownerClient!==clientId||
      !Number.isSafeInteger(row.version)||row.version<0||
      typeof row.brief?.idea!=='string'||typeof row.updatedAt!=='string')
      fail('WORKSPACE_CORRUPT','Borrador propio inválido');
    return {workspaceId:row.workspaceId,version:row.version,idea:redactValue(row.brief.idea),
      briefStatus:row.brief.status,planDigest:row.plan?.digest??null,
      archivedAt:row.archivedAt??null,updatedAt:row.updatedAt};
  });
  return {items:visible,nextCursor:rows.length>limit?visible.at(-1).workspaceId:null};
}

// Archivado reversible, con control optimista y sin eliminar datos.
export function setProjectWorkspaceArchived(db,{clientId,workspaceId,expectedVersion,archived}){
  const row=readRaw(db,{clientId,workspaceId});
  if(!Number.isSafeInteger(expectedVersion)||expectedVersion!==row.version)
    fail('STALE_REVISION','Otro cambio actualizó el borrador');
  if(typeof archived!=='boolean')fail('INVALID_WORKSPACE_UPDATE','archived debe ser booleano');
  if(Boolean(row.archivedAt)===archived)return view(row);
  row.archivedAt=archived?new Date().toISOString():null;
  row.version++;row.updatedAt=new Date().toISOString();
  db.prepare('UPDATE metadata SET value=? WHERE key=?').run(safe(row),key(workspaceId));
  return view(row);
}
