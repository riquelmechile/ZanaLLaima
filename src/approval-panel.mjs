import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {getProjectWorkspace} from './project-workspace.mjs';
import {canonicalPlan,prepareBootstrap} from './project-bootstrap.mjs';
import {requestPlanApproval,decidePlanApproval} from './plan-approval.mjs';
import {requestBootstrap,bootstrapAuthorized} from './bootstrap-request.mjs';

const PREFIX='zana:panel:',TTL=15*60_000,DAY=86400_000,MAX_DAY=20,MAX_FAILURES=6;
const ID=/^[A-Za-z0-9_-]{43}$/;
const fail=(code,message)=>{const error=new Error(code+': '+message);error.code=code;throw error;};
const iso=value=>new Date(value).toISOString();
const digest=value=>createHash('sha256').update(value).digest('hex');
const save=(db,row)=>db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
  .run(PREFIX+row.panelId,JSON.stringify(row));
const valid=row=>row?.schema==='zana.panel.v1'&&ID.test(String(row.panelId));

function ownRows(db,clientId){
  return db.prepare(`SELECT value FROM metadata WHERE key LIKE 'zana:panel:%'
    AND (CASE WHEN json_valid(value) THEN json_extract(value,'$.ownerClient') END)=?`).all(clientId)
    .map(entry=>{try{return JSON.parse(entry.value);}catch{return null;}}).filter(valid);
}
function read(db,clientId,panelId){
  const entry=ID.test(String(panelId))?db.prepare('SELECT value FROM metadata WHERE key=?').get(PREFIX+panelId):null;
  let row=null;try{row=entry?JSON.parse(entry.value):null;}catch{}
  if(!valid(row)||row.panelId!==panelId||row.ownerClient!==clientId)fail('PANEL_NOT_FOUND','No existe ese panel');
  return row;
}
function panelView(row,plan=null){
  return {panelId:row.panelId,workspaceId:row.workspaceId,version:row.version,planDigest:row.planDigest,
    intent:row.intent,status:row.status,failures:row.failures,createdAt:row.createdAt,expiresAt:row.expiresAt,
    decidedAt:row.decidedAt,result:row.result,plan};
}
function currentPlan(db,row){
  try{
    const ws=getProjectWorkspace(db,{clientId:row.ownerClient,workspaceId:row.workspaceId});
    if(ws.version!==row.version||ws.archivedAt||!ws.plan)return null;
    const plan=canonicalPlan(ws.plan);return plan.digest===row.planDigest?plan:null;
  }catch{return null;}
}
function transaction(db,work){
  let began=false;
  try{db.exec('BEGIN IMMEDIATE');began=true;const result=work();db.exec('COMMIT');return result;}
  catch(error){if(began)try{db.exec('ROLLBACK');}catch{}throw error;}
}

export function requestApprovalPanel(db,{clientId,workspaceId,expectedVersion,owner,name,visibility='private',allowed,now=Date.now()}){
  const ws=getProjectWorkspace(db,{clientId,workspaceId});
  if(expectedVersion!==ws.version)fail('STALE_REVISION','Pide el panel sobre la versión vigente del proyecto');
  if(ws.archivedAt)fail('WORKSPACE_ARCHIVED','Restaura el proyecto antes de pedir el panel');
  if(!ws.plan)fail('PLAN_REQUIRED','Guarda un plan antes de pedir el panel');
  const plan=canonicalPlan(ws.plan),prepared=prepareBootstrap(plan,{owner,name,visibility});
  const repository=owner+'/'+name;
  if(typeof allowed!=='function'||allowed(repository)!==true)
    fail('REPO_NOT_ALLOWED',JSON.stringify(repository)+' no está permitido por ZANA_GITHUB_REPOS');
  const retained=[];
  for(const old of ownRows(db,clientId)){
    if(now-Date.parse(old.createdAt)>=2*DAY)db.prepare('DELETE FROM metadata WHERE key=?').run(PREFIX+old.panelId);
    else retained.push(old);
  }
  if(retained.filter(old=>now-Date.parse(old.createdAt)<DAY).length>=MAX_DAY)
    fail('PANEL_RATE_EXCEEDED','Máximo '+MAX_DAY+' paneles por día');
  const nonce=randomBytes(32).toString('base64url');
  const row={schema:'zana.panel.v1',panelId:randomBytes(32).toString('base64url'),ownerClient:clientId,
    workspaceId,version:ws.version,planDigest:plan.digest,
    intent:{owner,name,visibility,digest:prepared.digest},nonceHash:digest(nonce),status:'PENDING',failures:0,
    createdAt:iso(now),expiresAt:iso(now+TTL),decidedAt:null,result:null};
  for(const old of retained)if(old.workspaceId===workspaceId&&old.status==='PENDING')
    save(db,{...old,status:'REPLACED',decidedAt:iso(now)});
  save(db,row);
  return {panel:panelView(row,plan),nonce};
}

export function approvalPanelStatus(db,{clientId,panelId,now=Date.now()}){
  let row;try{row=read(db,clientId,panelId);}catch{return null;}
  const status=row.status==='PENDING'&&now>=Date.parse(row.expiresAt)?'EXPIRED':row.status;
  return panelView({...row,status},currentPlan(db,row));
}

export function decideApprovalPanel(db,{clientId,panelId,decision,nonce,allowed,now=Date.now()}){
  return transaction(db,()=>{
    const row=read(db,clientId,panelId);
    const finish=(status,extra={})=>{const next={...row,status,decidedAt:iso(now),...extra};save(db,next);return panelView(next,currentPlan(db,next));};
    if(row.status!=='PENDING')fail('PANEL_NOT_PENDING','Este panel ya no admite decisiones');
    if(now>=Date.parse(row.expiresAt))return finish('EXPIRED');
    if(row.failures>=MAX_FAILURES)return finish('LOCKED');
    if(!['allow','deny'].includes(decision))fail('INVALID_DECISION','La decisión debe ser allow o deny');
    const supplied=digest(typeof nonce==='string'?nonce:'');
    if(!timingSafeEqual(Buffer.from(row.nonceHash,'hex'),Buffer.from(supplied,'hex'))){
      const failures=row.failures+1,status=failures>=MAX_FAILURES?'LOCKED':'PENDING';
      const next={...row,failures,status};save(db,next);
      return {status,denied:true,attemptsLeft:MAX_FAILURES-failures};
    }
    if(decision==='deny')return finish('DENIED');
    const ws=getProjectWorkspace(db,{clientId,workspaceId:row.workspaceId});
    let plan=null;try{plan=ws.plan?canonicalPlan(ws.plan):null;}catch{}
    if(ws.version!==row.version||ws.archivedAt||plan?.digest!==row.planDigest)return finish('SUPERSEDED');
    const repository=row.intent.owner+'/'+row.intent.name;
    if(typeof allowed!=='function'||allowed(repository)!==true)
      fail('REPO_NOT_ALLOWED',JSON.stringify(repository)+' no está permitido por ZANA_GITHUB_REPOS');
    const planRequest=requestPlanApproval(db,{clientId,workspaceId:row.workspaceId,expectedVersion:row.version,now});
    if(planRequest.status!=='APPROVED')decidePlanApproval(db,{approvalId:planRequest.approvalId,decision:'allow',passwordOk:true,now});
    const bootstrap=requestBootstrap(db,{clientId,workspaceId:row.workspaceId,expectedVersion:row.version,
      owner:row.intent.owner,name:row.intent.name,visibility:row.intent.visibility,allowed,now});
    if(bootstrap.authorization.status!=='APPROVED')decidePlanApproval(db,{approvalId:bootstrap.authorization.approvalId,decision:'allow',passwordOk:true,now});
    const authorized=bootstrapAuthorized(db,{clientId,operationId:bootstrap.operationId,now});
    if(!authorized)fail('PANEL_BOOTSTRAP_UNAUTHORIZED','El bootstrap no quedó autorizado atómicamente');
    const result={operationId:bootstrap.operationId,repository:bootstrap.repository,
      visibility:row.intent.visibility,bootstrapAuthorized:true};
    return finish('APPROVED',{result});
  });
}
