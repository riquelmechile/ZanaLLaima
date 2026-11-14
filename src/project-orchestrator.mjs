// El servidor verifica cada parte: CI en SHA exacto, 4R y merge.
// La aceptación conjunta del hito la declara el orquestador con final:true; este módulo no la comprueba.
import {canonicalPlan} from './project-bootstrap.mjs';
const SHA=/^[0-9a-f]{40}$/, DIGEST=/^[0-9a-f]{64}$/, PROJECT_ID=/^zp_[0-9a-f]{16}$/;
const sha=x=>typeof x==='string'&&SHA.test(x);
const ID=/^[a-z][a-z0-9-]{0,47}$/;
const MISSION_ID=/^(?:[a-z][a-z0-9-]{0,47}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const REPO=/^[\w.-]+\/[\w.-]+$/;
const fail=(code,msg)=>{const e=new Error(code+': '+msg);e.code=code;throw e;};
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const own=(v,allowed,required=allowed)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&
  [Object.prototype,null].includes(Object.getPrototypeOf(v))&&Object.keys(v).every(k=>allowed.includes(k))&&required.every(k=>Object.hasOwn(v,k));
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const time=x=>{if(!iso(x))fail('INVALID_TIME','Hora ISO UTC inválida');};
const clean=x=>x.replace(/[\p{Cc}\p{Cf}]/gu,'').replace(/\s+/g,' ').trim();
const validReason=x=>typeof x==='string'&&x===clean(x)&&x.length>=8&&x.length<=300;
const guard=x=>{if(!x)fail('INVALID_PROJECT','Estado de proyecto inválido');};
const reason=x=>{const v=typeof x==='string'?clean(x):'';if(v.length<8||v.length>300)fail('INVALID_REASON','Motivo de 8 a 300 caracteres requerido');return v;};
const revision=(s,n)=>{validateRun(s);if(n!==undefined&&n!==s.revision)fail('STALE_REVISION','La revisión cambió');};
const active=s=>{if(s.status!=='ACTIVE')fail('RUN_NOT_ACTIVE','La corrida no está activa');};
const same=(a,b)=>a.toLowerCase()===b.toLowerCase();
const missionUsed=(s,id)=>s.outsidePlan.some(x=>same(x.missionId,id))||s.milestones.some(m=>
  m.running&&same(m.running.missionId,id)||m.parts.some(p=>same(p.missionId,id))||m.attempts.some(a=>same(a.missionId,id)));
const uniquePart=(s,pr,merge)=>{if(s.milestones.some(m=>m.parts.some(p=>p.prNumber===pr||p.mergeCommitSha===merge)))
  fail('DUPLICATE_PR','PR o merge ya acreditado');};
const unique=(s,id)=>{if(missionUsed(s,id))fail('DUPLICATE_MISSION','La misión ya se utilizó');};
const identity=id=>{if(typeof id!=='string'||!MISSION_ID.test(id))fail('INVALID_ID','Identificador de misión inválido');};
const evidenceOk=(e,head,merge)=>{if(!own(e,['sha','ci','review','merged','mergeCommitSha'])||e.sha!==head||e.ci!=='SUCCESS'||e.review!=='APPROVED'||e.merged!==true||e.mergeCommitSha!==merge)
  fail('EVIDENCE_NOT_READY','Falta evidencia CI, 4R o merge en SHA exacto');};
const partArgs=(pr,head,merge,at)=>{if(!Number.isSafeInteger(pr)||pr<1)fail('INVALID_PR','Número de PR inválido');
  if(!sha(head)||!sha(merge))fail('INVALID_SHA','SHA inválido');time(at);};
const bump=(s,now,edit)=>{time(now);const v=structuredClone(s);edit(v);v.revision++;v.updatedAt=now;
  if(v.status!=='CANCELLED')v.status=v.milestones.every(m=>m.status==='DONE')?'READY_TO_DELIVER':'ACTIVE';
  validateRun(v);return freeze(v);};
const change=(s,id,now,edit)=>bump(s,now,v=>{const m=v.milestones.find(x=>x.id===id);edit(m);});
export function validateRun(s){
  guard(own(s,['schema','projectId','repo','base','ownerClient','workspaceId','planDigest','revision','status','reason','milestones','outsidePlan','createdAt','updatedAt'],
    ['schema','projectId','repo','base','ownerClient','workspaceId','planDigest','revision','status','milestones','outsidePlan','createdAt','updatedAt']));
  guard(s.schema==='zana.project-run.v2'&&typeof s.projectId==='string'&&PROJECT_ID.test(s.projectId)&&
    typeof s.repo==='string'&&REPO.test(s.repo)&&typeof s.base==='string'&&s.base.length>0&&
    typeof s.ownerClient==='string'&&s.ownerClient.length>0&&typeof s.workspaceId==='string'&&s.workspaceId.length>0&&
    typeof s.planDigest==='string'&&DIGEST.test(s.planDigest)&&Number.isSafeInteger(s.revision)&&s.revision>=0&&
    iso(s.createdAt)&&iso(s.updatedAt)&&['ACTIVE','READY_TO_DELIVER','CANCELLED'].includes(s.status));
  guard(s.status==='CANCELLED'?validReason(s.reason):!Object.hasOwn(s,'reason'));
  guard(Array.isArray(s.milestones)&&s.milestones.length>0&&s.milestones.length<=200&&
    Array.isArray(s.outsidePlan)&&s.outsidePlan.length<=50);
  const ids=new Set(),used=new Set(),prs=new Set(),merges=new Set(),dependencyMap=new Map();let running=0;
  const add=id=>{guard(typeof id==='string'&&MISSION_ID.test(id)&&!used.has(id.toLowerCase()));used.add(id.toLowerCase());};
  for(const m of s.milestones){
    guard(own(m,['id','dependsOn','objective','acceptance','status','parts','running','attempts'])&&
      typeof m.id==='string'&&ID.test(m.id)&&!ids.has(m.id)&&Array.isArray(m.dependsOn)&&
      typeof m.objective==='string'&&m.objective.length>0&&typeof m.acceptance==='string'&&m.acceptance.length>0&&
      ['PENDING','RUNNING','PARTIAL','DONE'].includes(m.status)&&Array.isArray(m.parts)&&m.parts.length<=50&&
      Array.isArray(m.attempts)&&m.attempts.length<=20);
    ids.add(m.id);dependencyMap.set(m.id,m.dependsOn);
    guard(m.running===null||own(m.running,['missionId','final','baseSha','at']));
    if(m.running!==null){running++;add(m.running.missionId);
      guard(typeof m.running.final==='boolean'&&sha(m.running.baseSha)&&iso(m.running.at));}
    for(const p of m.parts){guard(own(p,['missionId','prNumber','headSha','mergeCommitSha','final','at'])&&
      Number.isSafeInteger(p.prNumber)&&p.prNumber>0&&sha(p.headSha)&&sha(p.mergeCommitSha)&&
      typeof p.final==='boolean'&&iso(p.at)&&!prs.has(p.prNumber)&&!merges.has(p.mergeCommitSha));
      prs.add(p.prNumber);merges.add(p.mergeCommitSha);add(p.missionId);}
    for(const a of m.attempts){guard(own(a,['missionId','reason','prNumber','at'])&&validReason(a.reason)&&
      (a.prNumber===null||Number.isSafeInteger(a.prNumber)&&a.prNumber>0)&&iso(a.at));add(a.missionId);}
    const n=m.parts.length,hasRunning=m.running!==null,final=m.parts.at(-1)?.final===true;
    guard((m.status==='RUNNING')===hasRunning&&(m.status==='DONE')===(final&&!hasRunning)&&
      m.parts.slice(0,-1).every(p=>!p.final)&&(!hasRunning||!final));
    if(m.status==='PENDING')guard(!n&&!hasRunning);
    if(m.status==='PARTIAL')guard(n>0&&!hasRunning&&!final);
  }
  guard(running<=1&&(s.status!=='CANCELLED'||running===0));
  for(const [id,deps] of dependencyMap)guard(deps.every(d=>typeof d==='string'&&ids.has(d)&&d!==id)&&new Set(deps).size===deps.length);
  const statuses=new Map(s.milestones.map(m=>[m.id,m.status]));
  for(const m of s.milestones)if(m.status!=='PENDING')guard(m.dependsOn.every(d=>statuses.get(d)==='DONE'));
  // Kahn iterativo: también limita el trabajo en planes con muchas dependencias.
  const left=new Map([...dependencyMap].map(([id,deps])=>[id,deps.length]));
  const children=new Map([...ids].map(id=>[id,[]]));
  for(const [id,deps] of dependencyMap)for(const d of deps)children.get(d).push(id);
  const queue=[...ids].filter(id=>left.get(id)===0);
  for(let i=0;i<queue.length;i++)for(const child of children.get(queue[i])){
    left.set(child,left.get(child)-1);if(left.get(child)===0)queue.push(child);
  }
  guard(queue.length===ids.size);
  for(const x of s.outsidePlan){guard(own(x,['missionId','reason','at'])&&validReason(x.reason)&&iso(x.at));add(x.missionId);}
  if(s.status!=='CANCELLED')guard((s.status==='READY_TO_DELIVER')===s.milestones.every(m=>m.status==='DONE'));
  return s;
}
export function initializeProjectRun(plan,options){
  const {projectId,approvedDigest,repo,base,ownerClient,workspaceId,now}=options??{};
  const p=canonicalPlan(plan);
  if(typeof projectId!=='string'||!PROJECT_ID.test(projectId))fail('INVALID_ID','Project ID inválido');
  if(approvedDigest!==p.digest)fail('APPROVAL_REQUIRED','El digest del plan no está aprobado');
  if(typeof repo!=='string'||!REPO.test(repo))fail('INVALID_REPO','Repositorio inválido');
  if([base,ownerClient,workspaceId].some(x=>typeof x!=='string'||!x.length))fail('INVALID_ID','Metadatos del proyecto inválidos');
  time(now);
  const s={schema:'zana.project-run.v2',projectId,repo,base,ownerClient,workspaceId,planDigest:p.digest,revision:0,status:'ACTIVE',
    milestones:p.milestones.map(({id,dependsOn,objective,acceptance})=>({id,dependsOn:[...dependsOn],objective,acceptance,status:'PENDING',parts:[],running:null,attempts:[]})),
    outsidePlan:[],createdAt:now,updatedAt:now};validateRun(s);return freeze(s);
}
export function readyMilestones(s){
  validateRun(s);if(s.status!=='ACTIVE'||s.milestones.some(m=>m.running))return freeze([]);
  const done=new Set(s.milestones.filter(m=>m.status==='DONE').map(m=>m.id));
  return [...s.milestones.filter(m=>m.status==='PARTIAL'),...s.milestones.filter(m=>m.status==='PENDING'&&m.dependsOn.every(d=>done.has(d)))]
    .map(m=>freeze({id:m.id,objective:m.objective,acceptance:m.acceptance,status:m.status,parts:m.parts.length,attempts:structuredClone(m.attempts)}));
}
export function claimMilestone(s,options){
  const {expectedRevision,milestoneId,missionId,final,baseSha,now}=options??{};
  revision(s,expectedRevision);active(s);
  if(typeof milestoneId!=='string'||!ID.test(milestoneId))fail('INVALID_ID','Hito inválido');identity(missionId);
  if(!sha(baseSha))fail('INVALID_SHA','SHA de base inválido');
  if(typeof final!=='boolean')fail('INVALID_FINAL','El indicador final debe ser booleano');
  if(!readyMilestones(s).some(m=>m.id===milestoneId))fail('MILESTONE_NOT_READY','Hito no disponible');
  unique(s,missionId);return change(s,milestoneId,now,m=>{m.status='RUNNING';m.running={missionId,final,baseSha,at:now};});
}
export function recordOutsidePlan(s,options){
  const {expectedRevision,missionId,reason:why,now}=options??{};
  revision(s,expectedRevision);active(s);identity(missionId);const text=reason(why);unique(s,missionId);
  return bump(s,now,v=>{v.outsidePlan=[...v.outsidePlan,{missionId,reason:text,at:now}].slice(-50);});
}
export function completePart(s,options){
  const {expectedRevision,missionId,prNumber,headSha,mergeCommitSha,evidence,now}=options??{};
  revision(s,expectedRevision);active(s);identity(missionId);const m=s.milestones.find(x=>x.running?.missionId===missionId);
  if(!m)fail('MILESTONE_NOT_RUNNING','No hay misión ejecutándose');
  if(m.parts.length>=50)fail('TOO_MANY_PARTS','El hito alcanzó 50 partes');
  partArgs(prNumber,headSha,mergeCommitSha,now);uniquePart(s,prNumber,mergeCommitSha);evidenceOk(evidence,headSha,mergeCommitSha);
  return change(s,m.id,now,x=>{x.parts.push({missionId,prNumber,headSha,mergeCommitSha,final:x.running.final,at:now});
    x.status=x.running.final?'DONE':'PARTIAL';x.running=null;});
}
export function attachPart(s,options){
  const {expectedRevision,milestoneId,missionId,prNumber,headSha,mergeCommitSha,final,evidence,now}=options??{};
  revision(s,expectedRevision);active(s);identity(missionId);
  if(typeof final!=='boolean')fail('INVALID_FINAL','El indicador final debe ser booleano');
  if(!readyMilestones(s).some(m=>m.id===milestoneId))fail('MILESTONE_NOT_READY','Hito no disponible');
  if(s.milestones.find(m=>m.id===milestoneId).parts.length>=50)fail('TOO_MANY_PARTS','El hito alcanzó 50 partes');
  const recycled=s.milestones.find(m=>m.id===milestoneId)?.attempts.some(a=>same(a.missionId,missionId));
  if(!recycled)unique(s,missionId);
  partArgs(prNumber,headSha,mergeCommitSha,now);uniquePart(s,prNumber,mergeCommitSha);evidenceOk(evidence,headSha,mergeCommitSha);
  return change(s,milestoneId,now,m=>{if(recycled)m.attempts=m.attempts.filter(a=>!same(a.missionId,missionId));m.parts.push({missionId,prNumber,headSha,mergeCommitSha,final,at:now});m.status=final?'DONE':'PARTIAL';});
}
export function releaseMilestone(s,options){
  const {expectedRevision,missionId,reason:why,prNumber=null,now}=options??{};
  revision(s,expectedRevision);active(s);identity(missionId);const m=s.milestones.find(x=>x.running?.missionId===missionId);
  if(!m)fail('MILESTONE_NOT_RUNNING','No hay misión ejecutándose');
  const text=reason(why);if(prNumber!==null&&(!Number.isSafeInteger(prNumber)||prNumber<1))fail('INVALID_PR','PR inválido');
  return change(s,m.id,now,x=>{x.attempts=[...x.attempts,{missionId,reason:text,prNumber,at:now}].slice(-20);
    x.running=null;x.status=x.parts.length?'PARTIAL':'PENDING';});
}
export function cancelProjectRun(s,options){
  const {expectedRevision,reason:why,now}=options??{};
  revision(s,expectedRevision);if(s.status!=='ACTIVE')fail('INVALID_STATE','Solo se cancela una corrida activa');
  const text=reason(why);return bump(s,now,v=>{for(const m of v.milestones)if(m.running){
    m.attempts=[...m.attempts,{missionId:m.running.missionId,reason:('Corrida cancelada: '+text).slice(0,300),prNumber:null,at:now}].slice(-20);
    m.running=null;m.status=m.parts.length?'PARTIAL':'PENDING';
  }v.status='CANCELLED';v.reason=text;});
}
