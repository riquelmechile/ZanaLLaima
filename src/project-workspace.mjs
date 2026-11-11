// Borradores de proyecto aislados por cliente OAuth, en la misma SQLite.
// No guarda aprobaciones, credenciales ni permisos para crear repositorios.
import {randomUUID} from 'node:crypto';
import {startDiscovery,answerDiscovery} from './project-discovery.mjs';
import {validateBootstrapPlan} from './project-bootstrap.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREFIX='zana:workspace:';
const MAX_BYTES=60000;
const fail=(code,msg)=>{const e=new Error(code+': '+msg);e.code=code;throw e;};
const validActor=clientId=>typeof clientId==='string'&&clientId.length>=3&&clientId.length<=200;
const view=row=>({workspaceId:row.workspaceId,version:row.version,
  brief:row.brief,plan:row.plan,createdAt:row.createdAt,updatedAt:row.updatedAt});
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
  const now=new Date().toISOString(),workspaceId=randomUUID();
  const row={schema:'zana.workspace.v1',workspaceId,ownerClient:clientId,version:0,
    brief:startDiscovery(idea),plan:null,createdAt:now,updatedAt:now};
  db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(key(workspaceId),safe(row));
  return view(row);
}
export function getProjectWorkspace(db,args){return view(readRaw(db,args));}
export function updateProjectWorkspace(db,{clientId,workspaceId,expectedVersion,answers,plan}){
  const row=readRaw(db,{clientId,workspaceId});
  if(!Number.isSafeInteger(expectedVersion)||expectedVersion!==row.version)
    fail('STALE_REVISION','Otro cambio actualizó el borrador');
  if((answers===undefined)===(plan===undefined))
    fail('INVALID_WORKSPACE_UPDATE','Enviar respuestas o plan, pero no ambos');
  if(answers!==undefined){
    row.brief=answerDiscovery(row.brief,answers);
    row.plan=null; // cualquier nueva respuesta invalida el plan anterior
  }else{
    validateBootstrapPlan(plan);
    const brief=plan.brief,current=row.brief;
    const norm=o=>JSON.stringify(Object.entries(o).sort(([a],[b])=>a.localeCompare(b)));
    if(brief.idea!==current.idea||brief.revision!==current.revision||
      norm(brief.answers)!==norm(current.answers))
      fail('PLAN_BRIEF_MISMATCH','El plan no corresponde al briefing vigente');
    row.plan=plan;
  }
  row.version++;row.updatedAt=new Date().toISOString();
  db.prepare('UPDATE metadata SET value=? WHERE key=?').run(safe(row),key(workspaceId));
  return view(row);
}
