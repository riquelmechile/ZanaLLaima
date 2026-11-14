// El servidor verifica cada parte: CI en SHA exacto, 4R y merge.
// La aceptación conjunta del hito la declara el orquestador con final:true; este módulo no la comprueba.
import {validateBootstrapPlan} from './project-bootstrap.mjs';
const SHA=/^[0-9a-f]{40}$/, DIGEST=/^[0-9a-f]{64}$/;
const ID=/^[a-z][a-z0-9-]{0,47}$/;
const MISSION_ID=/^(?:[a-z][a-z0-9-]{0,47}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const REPO=/^[\w.-]+\/[\w.-]+$/;
const fail=(code,msg)=>{const e=new Error(code+': '+msg);e.code=code;throw e;};
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const own=(v,allowed,required=allowed)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&
  [Object.prototype,null].includes(Object.getPrototypeOf(v))&&Object.keys(v).every(k=>allowed.includes(k))&&required.every(k=>Object.hasOwn(v,k));
const iso=x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(x)&&Number.isFinite(Date.parse(x));
const guard=x=>{if(!x)fail('INVALID_PROJECT','Estado de proyecto inválido');};
const reason=x=>{if(typeof x!=='string'||x.trim().length<8||x.trim().length>300)fail('INVALID_REASON','Motivo de 8 a 300 caracteres requerido');return x.trim();};
const revision=(s,n)=>{validateRun(s);if(n!==undefined&&n!==s.revision)fail('STALE_REVISION','La revisión cambió');};
const active=s=>{if(s.status!=='ACTIVE')fail('RUN_NOT_ACTIVE','La corrida no está activa');};
const missionUsed=(s,id)=>s.outsidePlan.some(x=>x.missionId===id)||s.milestones.some(m=>
  m.running?.missionId===id||m.parts.some(p=>p.missionId===id)||m.attempts.some(a=>a.missionId===id));
const unique=(s,id)=>{if(missionUsed(s,id))fail('DUPLICATE_MISSION','La misión ya se utilizó');};
const identity=id=>{if(typeof id!=='string'||!MISSION_ID.test(id))fail('INVALID_ID','Identificador de misión inválido');};
const evidenceOk=(e,head,merge)=>{if(e?.sha!==head||e?.ci!=='SUCCESS'||e?.review!=='APPROVED'||e?.merged!==true||e?.mergeCommitSha!==merge)
  fail('EVIDENCE_NOT_READY','Falta evidencia CI, 4R o merge en SHA exacto');};
const partArgs=(pr,head,merge,at)=>{if(!Number.isSafeInteger(pr)||pr<1)fail('INVALID_PROJECT','Número de PR inválido');
  if(!SHA.test(head)||!SHA.test(merge))fail('INVALID_SHA','SHA inválido');guard(iso(at));};
const bump=(s,now,edit)=>{guard(iso(now));const v=structuredClone(s);edit(v);v.revision++;v.updatedAt=now;
  if(v.status!=='CANCELLED')v.status=v.milestones.every(m=>m.status==='DONE')?'READY_TO_DELIVER':'ACTIVE';
  validateRun(v);return freeze(v);};
const change=(s,id,now,edit)=>bump(s,now,v=>{const m=v.milestones.find(x=>x.id===id);edit(m);});
export function validateRun(s){
  guard(own(s,['schema','projectId','repo','base','ownerClient','workspaceId','planDigest','revision','status','reason','milestones','outsidePlan','createdAt','updatedAt'],
    ['schema','projectId','repo','base','ownerClient','workspaceId','planDigest','revision','status','milestones','outsidePlan','createdAt','updatedAt']));
  guard(s.schema==='zana.project-run.v2'&&/^zp_[0-9a-f]{16}$/.test(s.projectId)&&REPO.test(s.repo)&&
    typeof s.base==='string'&&s.base.length>0&&typeof s.ownerClient==='string'&&s.ownerClient.length>0&&
    typeof s.workspaceId==='string'&&s.workspaceId.length>0&&DIGEST.test(s.planDigest)&&
    Number.isSafeInteger(s.revision)&&s.revision>=0&&iso(s.createdAt)&&iso(s.updatedAt)&&
    ['ACTIVE','READY_TO_DELIVER','CANCELLED'].includes(s.status));
  guard(s.status==='CANCELLED'?typeof s.reason==='string'&&s.reason.trim().length>=8&&s.reason.trim().length<=300:!Object.hasOwn(s,'reason'));
  guard(Array.isArray(s.milestones)&&s.milestones.length>0&&Array.isArray(s.outsidePlan)&&s.outsidePlan.length<=50);
  const ids=new Set(), used=new Set(), dependencyMap=new Map();let running=0;
  const add=id=>{guard(typeof id==='string'&&MISSION_ID.test(id)&&!used.has(id));used.add(id);};
  for(const m of s.milestones){
    guard(own(m,['id','dependsOn','objective','acceptance','status','parts','running','attempts'])&&
      typeof m.id==='string'&&ID.test(m.id)&&!ids.has(m.id)&&Array.isArray(m.dependsOn)&&
      typeof m.objective==='string'&&m.objective.length>0&&typeof m.acceptance==='string'&&m.acceptance.length>0&&
      ['PENDING','RUNNING','PARTIAL','DONE'].includes(m.status)&&Array.isArray(m.parts)&&Array.isArray(m.attempts)&&m.attempts.length<=20);
    ids.add(m.id);dependencyMap.set(m.id,m.dependsOn);
    guard(m.running===null||own(m.running,['missionId','final','baseSha','at']));
    if(m.running!==null){running++;add(m.running.missionId);guard(typeof m.running.final==='boolean'&&SHA.test(m.running.baseSha)&&iso(m.running.at));}
    for(const p of m.parts){guard(own(p,['missionId','prNumber','headSha','mergeCommitSha','final','at'])&&
      Number.isSafeInteger(p.prNumber)&&p.prNumber>0&&SHA.test(p.headSha)&&SHA.test(p.mergeCommitSha)&&
      typeof p.final==='boolean'&&iso(p.at));add(p.missionId);}
    for(const a of m.attempts){guard(own(a,['missionId','reason','prNumber','at'])&&typeof a.reason==='string'&&
      a.reason.trim().length>=8&&a.reason.trim().length<=300&&(a.prNumber===null||
      Number.isSafeInteger(a.prNumber)&&a.prNumber>0)&&iso(a.at));add(a.missionId);}
    const n=m.parts.length, hasRunning=m.running!==null, final=m.parts.at(-1)?.final===true;
    guard((m.status==='RUNNING')===hasRunning&&(m.status==='DONE')===(final&&!hasRunning)&&
      m.parts.slice(0,-1).every(p=>!p.final)&&(!hasRunning||!final));
    if(m.status==='PENDING')guard(!n&&!hasRunning);
    if(m.status==='PARTIAL')guard(n>0&&!hasRunning&&!final);
  }
  guard(running<=1);
  for(const [id,deps] of dependencyMap)guard(deps.every(d=>typeof d==='string'&&ids.has(d)&&d!==id)&&new Set(deps).size===deps.length);
  const seen=new Set(), visiting=new Set();
  const walk=id=>{guard(!visiting.has(id));if(seen.has(id))return;visiting.add(id);
    dependencyMap.get(id).forEach(walk);visiting.delete(id);seen.add(id);};
  for(const id of ids)walk(id);
  for(const x of s.outsidePlan){guard(own(x,['missionId','reason','at'])&&typeof x.reason==='string'&&
    x.reason.trim().length>=8&&x.reason.trim().length<=300&&iso(x.at));add(x.missionId);}
  if(s.status!=='CANCELLED')guard((s.status==='READY_TO_DELIVER')===s.milestones.every(m=>m.status==='DONE'));
  return s;
}
export function initializeProjectRun(plan,{projectId,approvedDigest,repo,base,ownerClient,workspaceId,now}={}){
  validateBootstrapPlan(plan);
  if(typeof projectId!=='string'||!/^zp_[0-9a-f]{16}$/.test(projectId))fail('INVALID_PROJECT','Project ID inválido');
  if(approvedDigest!==plan.digest)fail('APPROVAL_REQUIRED','El digest del plan no está aprobado');
  const s={schema:'zana.project-run.v2',projectId,repo,base,ownerClient,workspaceId,planDigest:plan.digest,revision:0,status:'ACTIVE',
    milestones:plan.milestones.map(({id,dependsOn,objective,acceptance})=>({id,dependsOn:[...dependsOn],objective,acceptance,status:'PENDING',parts:[],running:null,attempts:[]})),
    outsidePlan:[],createdAt:now,updatedAt:now};validateRun(s);return freeze(s);
}
export function readyMilestones(s){
  validateRun(s);if(s.status!=='ACTIVE'||s.milestones.some(m=>m.running))return [];
  const done=new Set(s.milestones.filter(m=>m.status==='DONE').map(m=>m.id));
  return [...s.milestones.filter(m=>m.status==='PARTIAL'),...s.milestones.filter(m=>m.status==='PENDING'&&m.dependsOn.every(d=>done.has(d)))]
    .map(m=>({id:m.id,objective:m.objective,acceptance:m.acceptance,status:m.status,parts:m.parts.length,attempts:structuredClone(m.attempts)}));
}
export function claimMilestone(s,{expectedRevision,milestoneId,missionId,final,baseSha,now}={}){
  revision(s,expectedRevision);active(s);
  if(typeof milestoneId!=='string'||!ID.test(milestoneId))fail('INVALID_ID','Hito inválido');identity(missionId);
  if(!SHA.test(baseSha))fail('INVALID_SHA','SHA de base inválido');
  if(typeof final!=='boolean')fail('INVALID_FINAL','El indicador final debe ser booleano');
  if(!readyMilestones(s).some(m=>m.id===milestoneId))fail('MILESTONE_NOT_READY','Hito no disponible');
  unique(s,missionId);return change(s,milestoneId,now,m=>{m.status='RUNNING';m.running={missionId,final,baseSha,at:now};});
}
export function recordOutsidePlan(s,{expectedRevision,missionId,reason:why,now}={}){
  revision(s,expectedRevision);active(s);identity(missionId);const text=reason(why);unique(s,missionId);
  return bump(s,now,v=>{v.outsidePlan=[...v.outsidePlan,{missionId,reason:text,at:now}].slice(-50);});
}
export function completePart(s,{expectedRevision,missionId,prNumber,headSha,mergeCommitSha,evidence,now}={}){
  revision(s,expectedRevision);active(s);const m=s.milestones.find(x=>x.running?.missionId===missionId);
  if(!m)fail('MILESTONE_NOT_RUNNING','No hay misión ejecutándose');
  partArgs(prNumber,headSha,mergeCommitSha,now);evidenceOk(evidence,headSha,mergeCommitSha);
  return change(s,m.id,now,x=>{x.parts.push({missionId,prNumber,headSha,mergeCommitSha,final:x.running.final,at:now});
    x.status=x.running.final?'DONE':'PARTIAL';x.running=null;});
}
export function attachPart(s,{expectedRevision,milestoneId,missionId,prNumber,headSha,mergeCommitSha,final,evidence,now}={}){
  revision(s,expectedRevision);active(s);identity(missionId);
  if(typeof final!=='boolean')fail('INVALID_FINAL','El indicador final debe ser booleano');
  if(!readyMilestones(s).some(m=>m.id===milestoneId))fail('MILESTONE_NOT_READY','Hito no disponible');
  unique(s,missionId);partArgs(prNumber,headSha,mergeCommitSha,now);evidenceOk(evidence,headSha,mergeCommitSha);
  return change(s,milestoneId,now,m=>{m.parts.push({missionId,prNumber,headSha,mergeCommitSha,final,at:now});m.status=final?'DONE':'PARTIAL';});
}
export function releaseMilestone(s,{expectedRevision,missionId,reason:why,prNumber=null,now}={}){
  revision(s,expectedRevision);active(s);const m=s.milestones.find(x=>x.running?.missionId===missionId);
  if(!m)fail('MILESTONE_NOT_RUNNING','No hay misión ejecutándose');
  const text=reason(why);if(prNumber!==null&&(!Number.isSafeInteger(prNumber)||prNumber<1))fail('INVALID_PROJECT','PR inválido');
  return change(s,m.id,now,x=>{x.attempts=[...x.attempts,{missionId,reason:text,prNumber,at:now}].slice(-20);
    x.running=null;x.status=x.parts.length?'PARTIAL':'PENDING';});
}
export function cancelProjectRun(s,{expectedRevision,reason:why,now}={}){
  revision(s,expectedRevision);if(s.status!=='ACTIVE')fail('INVALID_STATE','Solo se cancela una corrida activa');
  const text=reason(why);return bump(s,now,v=>{v.status='CANCELLED';v.reason=text;});
}
