import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const check=(ok,msg)=>{if(!ok)throw new Error(msg)};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pathSafe=p=>typeof p==='string'&&p.length>0&&p.length<=240
  &&!p.startsWith('/')&&!p.includes('\\')&&p.split('/').every(x=>x&&x!=='.'&&x!=='..');

export async function operatorPublicKey(path=process.env.ZANA_OPERATOR_PUBLIC_KEY_PATH){
  check(typeof path==='string'&&path.length>0,'Operator public key is not configured');
  const pem=await readFile(resolve(path),'utf8');
  const key=createPublicKey(pem);
  check(key.asymmetricKeyType==='ed25519','Operator key must be Ed25519');
  const fingerprint=createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex');
  return {key,fingerprint};
}

export function verifySignedAction(envelope,mission,operatorKey,at=Date.now()){
  check(envelope&&typeof envelope==='object'&&envelope.payload&&
    typeof envelope.payload==='object'&&!Array.isArray(envelope.payload),
    'Invalid signed operator action');
  const p=envelope.payload;
  check(['GRANT_WRITE','REVOKE_WRITE','RECONCILE_WRITE'].includes(p.kind),
    'Invalid operator action kind');
  check(p.missionId===mission.id && UUID.test(p.nonce),'Wrong mission or invalid nonce');
  check(typeof p.issuedAt==='string'&&typeof p.expiresAt==='string',
    'Operator action needs issuedAt and expiresAt');
  const issued=Date.parse(p.issuedAt),expiry=Date.parse(p.expiresAt);
  check(Number.isFinite(issued)&&Number.isFinite(expiry)&&
    issued<=at+60000 && issued>=at-1800000 && expiry>at && expiry>issued &&
    expiry-issued<=1800000,'Operator action expired or exceeds 30 minutes');
  check(typeof envelope.signature==='string' &&
    /^[A-Za-z0-9+/]{86}==$/.test(envelope.signature),
    'Invalid signature encoding');
  const sig=Buffer.from(envelope.signature,'base64');
  check(sig.length===64 && sig.toString('base64')===envelope.signature,
    'Invalid signature length');
  check(verify(null,Buffer.from(JSON.stringify(p),'utf8'),operatorKey,sig),
    'Invalid operator signature');
  if(p.kind==='GRANT_WRITE'){
    check(mission.authorization?.writesAllowed===true,'Mission did not request writes');
    check(Array.isArray(p.paths)&&p.paths.length>0&&p.paths.length<=32&&
      p.paths.every(pathSafe),'Invalid permitted paths');
    check(p.paths.every(x=>mission.authorization.allowedPaths.some(root=>
      x===root||x.startsWith(root+'/'))),'Grant exceeds mission requested paths');
  }
  if(p.kind==='REVOKE_WRITE'){
    check(UUID.test(p.grantId),'Missing grant identifier');
  }
  if(p.kind==='RECONCILE_WRITE'){
    check(typeof p.unitId==='string'&&UUID.test(p.token)&&
      Number.isInteger(p.leaseGeneration)&&p.leaseGeneration>=1,'Invalid reconciliation attempt');
    check(['CONFIRMED_DONE','CONFIRMED_NO_EFFECT'].includes(p.decision),
      'Invalid reconciliation decision');
    check(Array.isArray(p.evidence)&&p.evidence.length>=1&&p.evidence.length<=20&&
      p.evidence.every(x=>typeof x==='string'&&x.trim().length>=8&&x.length<=2000),
      'Operator reconciliation evidence is required');
  }
  return p;
}

export function verifyStoredGrant(envelope,mission,operatorKey,at=Date.now()){
  try {
    const p=verifySignedAction(envelope,mission,operatorKey,at);
    if(p.kind!=='GRANT_WRITE')return null;
    return {valid:true,id:p.nonce,expiresAt:p.expiresAt,paths:p.paths};
  }catch{return null;}
}
