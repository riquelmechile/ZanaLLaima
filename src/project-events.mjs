// Sobre HMAC local para avisos del proyecto. No implementa aún el transporte
// MCP Events del anfitrión. Un evento nunca concede permisos de escritura.
import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
const SHA=/^[0-9a-f]{40}$/;
const TYPES=Object.freeze(['CI_FINISHED','REVIEW_READY','CHANGES_REQUESTED','MISSION_DONE','APPROVAL_NEEDED']);
const fail=(c,m)=>{const e=new Error(c+': '+m);e.code=c;throw e;};
const sign=(payload,key)=>createHmac('sha256',key).update(JSON.stringify(payload)).digest('hex');
const secretOk=s=>typeof s==='string'&&Buffer.byteLength(s)>=32;

export function createProjectEvent({type,projectId,missionId=null,sha=null,at=new Date().toISOString(),payload={}},secret){
  if(!secretOk(secret))fail('EVENT_SECRET_REQUIRED','El servidor necesita una clave propia');
  if(!TYPES.includes(type)||!/^zp_[0-9a-f]{16}$/.test(projectId)||
    missionId!==null&&(typeof missionId!=='string'||missionId.length>128)||
    sha!==null&&!SHA.test(sha)||Number.isNaN(Date.parse(at))||
    payload===null||typeof payload!=='object'||Array.isArray(payload)||
    Buffer.byteLength(JSON.stringify(payload))>4096)
    fail('INVALID_EVENT','Evento mal formado');
  const event={schema:'zana.project-event.v1',eventId:randomUUID(),type,projectId,missionId,sha,at,payload};
  return Object.freeze({...event,signature:sign(event,secret)});
}

export async function verifyProjectEvent(event,secret,{now=Date.now(),maxAgeMs=300000,consume}={}){
  if(!secretOk(secret)||!event||typeof event!=='object'||Array.isArray(event))
    fail('INVALID_EVENT','Evento o clave inválidos');
  const {signature,...payload}=event;
  if(payload.schema!=='zana.project-event.v1'||!TYPES.includes(payload.type)||
    typeof payload.eventId!=='string'||!SHA.test(String(signature))&&
    !/^[0-9a-f]{64}$/.test(String(signature)))fail('INVALID_EVENT','Formato o firma inválidos');
  const expected=Buffer.from(sign(payload,secret),'hex'),received=Buffer.from(signature,'hex');
  if(received.length!==expected.length||!timingSafeEqual(received,expected))
    fail('INVALID_SIGNATURE','Firma incorrecta');
  const time=Date.parse(payload.at);
  if(!Number.isFinite(time)||!Number.isFinite(now)||!Number.isInteger(maxAgeMs)||maxAgeMs<1||
    Math.abs(now-time)>maxAgeMs)fail('EVENT_EXPIRED','Fuera de ventana o fecha inválida');
  if(typeof consume!=='function')fail('EVENT_DEDUP_REQUIRED','Se requiere deduplicación atómica');
  const fresh=await consume({eventId:payload.eventId,projectId:payload.projectId,expiresAt:time+maxAgeMs});
  if(fresh!==true)fail('EVENT_DUPLICATE','Evento ya procesado o no registrado');
  return Object.freeze({eventId:payload.eventId,type:payload.type,projectId:payload.projectId,
    missionId:payload.missionId,sha:payload.sha,notificationOnly:true});
}
