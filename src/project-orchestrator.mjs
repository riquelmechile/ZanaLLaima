// Coordinador de hitos durable por serialización; no crea modelos ni subagentes.
// Un backend autorizado persiste las revisiones y comprueba evidencia GitHub.
import {validateBootstrapPlan} from './project-bootstrap.mjs';
const SHA=/^[0-9a-f]{40}$/;
const ID=/^[a-z][a-z0-9-]{0,47}$/;
const MISSION_ID=/^(?:[a-z][a-z0-9-]{0,47}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const fail=(code,msg)=>{const e=new Error(code+': '+msg);e.code=code;throw e;};
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const copy=x=>structuredClone(x);
const check=state=>{
  if(state?.schema!=='zana.project-run.v1'||typeof state.planDigest!=='string'||
    !Number.isSafeInteger(state.revision)||!Array.isArray(state.milestones)||
    !['ACTIVE','READY_TO_DELIVER','CANCELLED'].includes(state.status))fail('INVALID_PROJECT','Estado de proyecto inválido');
  return state;
};
const replace=(state,id,update)=>{
  const v=copy(state);v.revision++;
  v.milestones=v.milestones.map(m=>m.id===id?{...m,...update}:m);
  v.status=v.milestones.every(m=>m.status==='DONE')?'READY_TO_DELIVER':'ACTIVE';
  return freeze(v);
};
export function initializeProjectRun(plan,{projectId,approvedDigest}={}){
  validateBootstrapPlan(plan);
  if(typeof projectId!=='string'||!/^zp_[0-9a-f]{16}$/.test(projectId))fail('INVALID_PROJECT','Project ID inválido');
  if(approvedDigest!==plan.digest)fail('APPROVAL_REQUIRED','El backend no confirmó la huella del plan');
  return freeze({schema:'zana.project-run.v1',projectId,planDigest:plan.digest,revision:0,
    status:'ACTIVE',milestones:plan.milestones.map(({id,dependsOn,objective,acceptance})=>({
      id,dependsOn:[...dependsOn],objective,acceptance,status:'PENDING',missionId:null,headSha:null}))});
}
export function readyMilestones(state){
  check(state);if(state.status!=='ACTIVE')return [];
  const done=new Set(state.milestones.filter(m=>m.status==='DONE').map(m=>m.id));
  // El harness actual solo admite una misión de código viva por instancia.
  if(state.milestones.some(m=>m.status==='RUNNING'))return [];
  return state.milestones.filter(m=>m.status==='PENDING'&&m.dependsOn.every(d=>done.has(d)))
    .map(m=>({id:m.id,objective:m.objective,acceptance:m.acceptance}));
}
export function claimMilestone(state,{expectedRevision,milestoneId,missionId,headSha}){
  check(state);
  if(expectedRevision!==state.revision)fail('STALE_REVISION','La revisión del proyecto cambió');
  if(!ID.test(milestoneId)||!MISSION_ID.test(missionId))fail('INVALID_ID','ID de hito o misión inválido');
  if(!SHA.test(headSha))fail('INVALID_SHA','El SHA de base debe ser exacto');
  if(!readyMilestones(state).some(m=>m.id===milestoneId))fail('MILESTONE_NOT_READY','Dependencias o misión activa');
  if(state.milestones.some(m=>m.missionId===missionId||m.attempts?.some(a=>a.missionId===missionId)))
    fail('DUPLICATE_MISSION','La misión ya se utilizó');
  return replace(state,milestoneId,{status:'RUNNING',missionId,headSha});
}
export async function completeMilestone(state,{expectedRevision,milestoneId,missionId,headSha},verify){
  check(state);
  if(expectedRevision!==state.revision)fail('STALE_REVISION','La revisión del proyecto cambió');
  if(state.status!=='ACTIVE')fail('INVALID_STATE','Un proyecto cancelado no puede completar hitos');
  const milestone=state.milestones.find(m=>m.id===milestoneId);
  if(!milestone||milestone.status!=='RUNNING'||milestone.missionId!==missionId)
    fail('MILESTONE_NOT_RUNNING','No corresponde a la misión en ejecución');
  if(!SHA.test(headSha))fail('INVALID_SHA','SHA final inválido');
  if(typeof verify!=='function')fail('VERIFIER_REQUIRED','Verificador GitHub del backend obligatorio');
  const evidence=await verify({missionId,milestoneId,headSha,planDigest:state.planDigest});
  if(evidence?.sha!==headSha||evidence?.ci!=='SUCCESS'||evidence?.review!=='APPROVED'||
    evidence?.merged!==true)fail('EVIDENCE_NOT_READY','CI, 4R o merge sin verificar en SHA exacto');
  return replace(state,milestoneId,{status:'DONE',headSha});
}

 // Recuperación explícita del hito cuyo trabajo dejó de existir; no se
 // autodeclara cancelado mediante una respuesta de GPT. El backend verifica
 // el cierre de la misión y que ninguna unidad continúa con permisos vivos.
export async function releaseMilestone(state,{expectedRevision,milestoneId,missionId,reason},verifyMission){
  check(state);
  if(expectedRevision!==state.revision)fail('STALE_REVISION','La revisión del proyecto cambió');
  if(state.status!=='ACTIVE')fail('INVALID_STATE','Proyecto no recuperable');
  const milestone=state.milestones.find(m=>m.id===milestoneId);
  if(!milestone||milestone.status!=='RUNNING'||milestone.missionId!==missionId)
    fail('MILESTONE_NOT_RUNNING','La misión no corresponde al hito en curso');
  if(typeof reason!=='string'||reason.trim().length<8)fail('INVALID_REASON','Motivo requerido');
  if(typeof verifyMission!=='function')fail('VERIFIER_REQUIRED','Se requiere evidencia de la misión desde backend');
  const evidence=await verifyMission({missionId,milestoneId,projectId:state.projectId});
  if(evidence?.missionId!==missionId||!['CANCELLED','REVIEW_ROUNDS_EXHAUSTED'].includes(evidence?.status)||
    evidence.activeUnits!==false)
    fail('RECOVERY_NOT_ALLOWED','La misión no está terminada o conserva unidades activas');
  return replace(state,milestoneId,{status:'PENDING',missionId:null,headSha:null,
    attempts:[...(milestone.attempts??[]),{missionId,reason:reason.trim().slice(0,300)}]});
}

export function cancelProjectRun(state,{expectedRevision,reason}){
  check(state);
  if(expectedRevision!==state.revision)fail('STALE_REVISION','La revisión del proyecto cambió');
  if(state.status!=='ACTIVE')fail('INVALID_STATE','Solo se cancela un proyecto activo');
  if(typeof reason!=='string'||reason.trim().length<8)fail('INVALID_REASON','Motivo requerido');
  return freeze({...copy(state),revision:state.revision+1,status:'CANCELLED',reason:reason.trim().slice(0,300)});
}
