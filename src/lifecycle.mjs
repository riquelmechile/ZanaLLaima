import { grantPermits, missionSummary } from './core.mjs';
import { budgetOf, budgetExpired, remainingStarts } from './budget.mjs';

const check=(ok,msg)=>{if(!ok)throw new Error(msg)};
const stamp=()=>new Date().toISOString();
const find=(m,id)=>m.units.find(x=>x.id===id);

export function heartbeatUnit(m,{unitId,token,leaseGeneration,leaseSeconds},grant=null){
  check((m.status||'ACTIVE')==='ACTIVE','Mission not active');
  check(!budgetExpired(m),'Mission time budget exhausted');
  const limit=budgetOf(m);
  const seconds=leaseSeconds??Math.min(300,limit.maxLeaseSeconds);
  check(Number.isInteger(seconds)&&seconds>=5&&seconds<=limit.maxLeaseSeconds,
    'Heartbeat exceeds mission lease budget');
  const u=find(m,unitId);
  check(u?.status==='RUNNING' && u.run?.token===token
    && u.run?.leaseGeneration===leaseGeneration,'Invalid or stale heartbeat');
  check(u.run.expiresAt && Date.parse(u.run.expiresAt)>Date.now(),
    'Lease expired; reconciliation required');
  check(grantPermits(u,grant),'Effective write permission missing or revoked');
  // Heartbeats renew leases but never shorten a still-valid reservation.
  // The immutable mission deadline remains the absolute upper bound.
  const oldExpiry=Date.parse(u.run.expiresAt);
  const deadline=limit.deadlineAt?Date.parse(limit.deadlineAt):Infinity;
  u.run.heartbeatAt=stamp();
  u.run.expiresAt=new Date(Math.min(deadline,
    Math.max(oldExpiry,Date.now()+seconds*1000))).toISOString();
  m.revision++;
  return {unitId,leaseGeneration,expiresAt:u.run.expiresAt};
}

export function expireUnits(m,at=Date.now()){
  check(['ACTIVE','CANCELLING'].includes(m.status||'ACTIVE'),'Mission not active');
  const changed=[];
  for(const u of m.units){
    if(u.status!=='RUNNING')continue;
    if(u.run?.expiresAt && Date.parse(u.run.expiresAt)>at)continue;
    if(u.effect==='WRITE'){
      u.status='OUTCOME_UNKNOWN';
      u.run.uncertainty={reason:'LEASE_EXPIRED_WRITE',since:stamp()};
    }else u.status='EXPIRED';
    changed.push({unitId:u.id,status:u.status,generation:u.run?.leaseGeneration});
  }
  if(changed.length)m.revision++;
  return changed;
}

export function retryRead(m,unitId){
  check((m.status||'ACTIVE')==='ACTIVE','Mission not active');
  const u=find(m,unitId);
  check(u?.effect==='READ' && ['EXPIRED','FAILED'].includes(u.status),
    'Only expired or failed READ work can be retried');
  check((u.attempts||0)<budgetOf(m).maxUnitAttempts,'Retry limit reached');
  check(remainingStarts(m)>0,'Mission work-start budget exhausted');
  u.status='PENDING';u.result=null;m.revision++;
  return missionSummary(m);
}

export function reconcileWrite(m,{unitId,token,leaseGeneration,decision,evidence}){
  check(['ACTIVE','CANCELLING'].includes(m.status||'ACTIVE'),'Mission not active');
  const u=find(m,unitId);
  check(u?.effect==='WRITE' && u.status==='OUTCOME_UNKNOWN',
    'Only an uncertain WRITE can be reconciled');
  check(u.run?.token===token && u.run?.leaseGeneration===leaseGeneration,
    'Stale write reconciliation');
  check(Array.isArray(evidence)&&evidence.length>0&&evidence.length<=20&&
    evidence.every(x=>typeof x==='string'&&x.length>=8&&x.length<=2000),
    'Actual operator evidence required');
  check(decision==='CONFIRMED_DONE'||decision==='CONFIRMED_NO_EFFECT','Invalid decision');
  // An exhausted uncertain write can still be reconciled as definitively
  // non-executed. Record a terminal failure rather than leaving it stuck.
  const retryPossible=(u.attempts||0)<budgetOf(m).maxUnitAttempts&&remainingStarts(m)>0;
  u.run.reconciliation={decision,evidence,recordedAt:stamp(),assurance:'OPERATOR_ATTESTED'};
  if(decision==='CONFIRMED_DONE'){
    u.status='DONE';
    u.result={success:true,summary:'Uncertain WRITE reconciled by operator',
      evidence,recordedAt:stamp(),assurance:'OPERATOR_ATTESTED'};
  }else if(m.status==='CANCELLING')u.status='CANCELLED';
  else if(retryPossible){u.status='PENDING';u.result=null;}
  else{
    u.status='FAILED';
    u.result={success:false,summary:'Write confirmed to have no effect; retry budget exhausted',
      evidence,recordedAt:stamp(),assurance:'OPERATOR_ATTESTED'};
  }
  if(m.status==='CANCELLING' && m.units.every(x=>!['RUNNING','OUTCOME_UNKNOWN'].includes(x.status)))
    m.status='CANCELLED';
  m.revision++;return missionSummary(m);
}

export function revokeRunningWrites(m){
  const changed=[];
  for(const u of m.units){
    if(u.status==='RUNNING'&&u.effect==='WRITE'){
      u.status='OUTCOME_UNKNOWN';
      u.run.uncertainty={reason:'WRITE_GRANT_REVOKED',since:stamp()};
      changed.push(u.id);
    }
  }
  if(changed.length)m.revision++;
  return changed;
}

export function cancelMission(m){
  check((m.status||'ACTIVE')==='ACTIVE','Mission not active');
  for(const u of m.units){
    if(u.status==='RUNNING' && u.effect==='WRITE'){
      u.status='OUTCOME_UNKNOWN';
      u.run.uncertainty={reason:'MISSION_CANCELLED_WRITE',since:stamp()};
    }else if(!['DONE','OUTCOME_UNKNOWN'].includes(u.status))u.status='CANCELLED';
  }
  m.status=m.units.some(x=>x.status==='OUTCOME_UNKNOWN')?'CANCELLING':'CANCELLED';
  m.revision++;return missionSummary(m);
}

export function closeMission(m){
  check((m.status||'ACTIVE')==='ACTIVE','Mission not active');
  check(m.units.length>0&&m.units.every(x=>x.status==='DONE'),
    'All units must complete successfully before closing');
  check(!m.review?.lenses?.some(x=>x.state==='RUNNING'),
    'Complete or invalidate active review before closing');
  m.status='CLOSED';m.closedAt=stamp();m.revision++;
  return missionSummary(m);
}
