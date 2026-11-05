import {inScope} from './paths.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {transact,statePath} from './store.mjs';
import {grantPermits} from './core.mjs';
import {budgetOf} from './budget.mjs';
import {atomicWorkspaceEffect,inspectPreimage,validateWriteRequest} from './write-effect.mjs';

const ensure=(ok,message)=>{if(!ok)throw Error('Write effect rejected: '+message);};
const hash=value=>createHash('sha256').update(value).digest('hex');

function permitted(m,ctx,{unitId,token,leaseGeneration,path},status='RUNNING'){
  ensure(m?.status==='ACTIVE','Mission is not active');
  const unit=m.units.find(u=>u.id===unitId);
  ensure(unit?.effect==='WRITE'&&unit.status===status,'WRITE claim not in required state');
  ensure(unit.run?.token===token&&unit.run?.leaseGeneration===leaseGeneration,
    'Stale token or leaseGeneration');
  ensure(Date.parse(unit.run?.expiresAt)>Date.now(),'Lease expired');
  ensure(grantPermits(unit,ctx.writeGrant),'Operator grant absent, expired, or revoked');
  ensure(inScope(path,unit.paths),'Path outside authorized unit scope');
  ensure(inScope(path,ctx.writeGrant?.paths),'Path outside signed operator grant');
  ensure(unit.run?.pathAnchors?.anchors,'No verified workspace anchors captured at reservation');
  return unit;
}

export async function applyWriteEffect(args,file=statePath(),hooks={}){
  const {unitId,token,leaseGeneration,path,content,deleteFile=false,
    expectedPreSha256}=args??{};
  // Everything is rejected before any intent is persisted whenever possible.
  ensure(typeof unitId==='string'&&typeof token==='string'&&
    Number.isSafeInteger(leaseGeneration)&&leaseGeneration>=1,'Invalid claim identity');

  // Transaction #1 persists a *durable uncertain intent* before the effect.
  // A crash after any subsequent filesystem operation cannot erase it.
  let intent;
  await transact(async(m,ctx)=>{
    ensure(m,'No active mission');
    const request=validateWriteRequest({path,content,deleteFile,expectedPreSha256},
      budgetOf(m).maxResultBytes);
    const u=permitted(m,ctx,{unitId,token,leaseGeneration,path});
    ensure(!u.run.effectIntent&&!u.run.effectReceipt,
      'Write effect already attempted; never replay without signed reconciliation');
    const existing=await inspectPreimage({path,
      root:u.run.pathAnchors.workspaceRoot,anchors:u.run.pathAnchors.anchors});
    ensure(expectedPreSha256===undefined||expectedPreSha256===existing.hash,
      'expectedPreSha256 differs; no effect attempted');
    ensure(!deleteFile||existing.exists,'Cannot delete missing file');
    const grantId=ctx.writeGrant?.id;
    ensure(typeof grantId==='string'&&grantId.length>0,
      'Signed operator grant identity required');
    const id=randomUUID();
    intent={effectId:id,grantId,path,operation:request.operation,
      preSha256:existing.hash,expectedPostSha256:deleteFile?null:hash(Buffer.from(content,'utf8')),
      bytes:request.bytes,claimedAt:new Date().toISOString()};
    u.run.effectIntent={...intent,status:'INTENT_DURABLE'};
    u.run.uncertainty={reason:'EFFECT_INTENT_COMMITTED',since:intent.claimedAt};
    u.status='OUTCOME_UNKNOWN';m.revision++;
    return m;
  },file);
  // Optional internal fault-injection hook. It never runs under the SQLite lock
  // and is not exposed as an MCP argument.
  if(hooks?.afterIntent)await hooks.afterIntent({...intent});

  // Transaction #2 serializes the actual effect with revocation and receipt.
  // SQLite rolls back the receipt on crash, but the earlier uncertain intent
  // remains committed. No unsafe automatic replay is ever permitted.
  let receipt;
  await transact(async(m,ctx)=>{
    ensure(m,'Mission missing after intent');
    const u=permitted(m,ctx,{unitId,token,leaseGeneration,path},'OUTCOME_UNKNOWN');
    ensure(ctx.writeGrant?.id===intent.grantId&&
      u.run.effectIntent?.grantId===intent.grantId,
      'Original signed operator grant was revoked or replaced after intent');
    ensure(u.run.effectIntent?.effectId===intent.effectId&&
      u.run.effectIntent.status==='INTENT_DURABLE',
      'Write intent changed before effect');
    const effect=await atomicWorkspaceEffect({
      path,content,deleteFile,
      expectedPreSha256:intent.preSha256,
      root:u.run.pathAnchors.workspaceRoot,
      anchors:u.run.pathAnchors.anchors,
      beforeEffect:()=>{
        ensure(Date.parse(u.run.expiresAt)>Date.now(),'Lease expired immediately before effect');
        ensure(Date.parse(ctx.writeGrant?.expiresAt)>Date.now(),
          'Operator grant expired immediately before effect');
      },
    });
    ensure(effect.postSha256===intent.expectedPostSha256,
      'Postimage hash does not match reserved intention');
    if(hooks?.afterEffect)await hooks.afterEffect(effect);
    receipt={effectId:intent.effectId,path,preSha256:effect.preSha256,
      postSha256:effect.postSha256,preMode:effect.preMode,postMode:effect.postMode,
      bytes:effect.bytes,
      appliedAt:effect.appliedAt,operation:effect.operation,
      assurance:effect.assurance};
    u.run.effectReceipt=receipt;
    u.run.effectIntent={...intent,status:'RECEIPTED'};
    delete u.run.uncertainty;
    u.status='RUNNING';
    m.revision++;
    return m;
  },file);
  return {unitId,leaseGeneration,...receipt,approval:'SIGNED_OPERATOR_SCOPE_VERIFIED',
    note:'The host must not write directly; this receipt is not OS isolation proof.'};
}
