// Preparación de cuatro lentes 4R; no reclama tickets ni publica aprobaciones.
// Nunca identifica un contexto nuevo con una identidad GitHub autorizada.
import {createHash} from 'node:crypto';
const SHA=/^[0-9a-f]{40}$/;
export const REVIEW_LENSES=Object.freeze(['risk','readability','reliability','resilience']);
const dig=s=>createHash('sha256').update(s).digest('hex');
const fail=(c,m)=>{const e=new Error(c+': '+m);e.code=c;throw e;};
const str=(s,min=1,max=100000)=>typeof s==='string'&&s.trim().length>=min&&s.length<=max;
const own=o=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&
  [Object.prototype,null].includes(Object.getPrototypeOf(o));
const serial=x=>JSON.stringify(x);

// La conversación revisora obtiene el diff completo mediante el mecanismo
// existente y entrega a cada lente únicamente los insumos acordados.
export function buildFourReviewPackets({ticket,repo,prNumber,sha,baseSha,spec,diff,checks,prBody,skills}){
  if(!str(ticket,8,100)||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)||
    !Number.isSafeInteger(prNumber)||prNumber<1||!SHA.test(sha)||!SHA.test(baseSha))
    fail('INVALID_REVIEW_TARGET','Ticket, repositorio, PR o SHA inválidos');
  if(!str(spec,1,30000)||!str(diff,1,1800000)||!str(prBody,1,50000)||
    !own(checks)||!str(checks.state)||!own(skills))
    fail('INVALID_REVIEW_INPUT','Falta evidencia concreta para 4R');
  if(checks.state!=='SUCCESS'||checks.sha!==sha)
    fail('CHECKS_NOT_GREEN','Los checks no acreditan el SHA completo');
  const keys=Object.keys(skills);
  if(keys.length!==4||keys.some(x=>!REVIEW_LENSES.includes(x))||
    REVIEW_LENSES.some(x=>!str(skills[x],20,64000)))
    fail('INCOMPLETE_REVIEW_SKILLS','Se necesitan exactamente los cuatro lentes');
  const common={ticket,repo,prNumber,sha,baseSha,spec,diff,checks,prBody};
  return REVIEW_LENSES.map(lens=>{
    const payload={...common,lens,skill:skills[lens]};
    return Object.freeze({...payload,payloadHash:dig(serial(payload))});
  });
}

export function validateReviewFindingPacket(packet,{lens,payloadHash,sha,findings,evidence}){
  if(!own(packet)||!REVIEW_LENSES.includes(packet.lens)||packet.lens!==lens||
    packet.sha!==sha||packet.payloadHash!==payloadHash)
    fail('STALE_REVIEW_PACKET','La respuesta no corresponde al paquete firmado por huella');
  const {payloadHash:known,...payload}=packet;
  if(dig(serial(payload))!==known)fail('REVIEW_PACKET_TAMPERED','Contenido alterado');
  if(!Array.isArray(findings)||findings.length>50||!Array.isArray(evidence)||
    evidence.length<1||evidence.length>20)fail('INVALID_FINDINGS','Faltan hallazgos o evidencia');
  if(findings.some(x=>!own(x)||!['BLOCKER','CRITICAL','WARNING','SUGGESTION'].includes(x.severity)||
    !str(x.location,3,260)||!str(x.evidence,3,4000))||evidence.some(x=>!str(x,3,2000)))
    fail('INVALID_FINDINGS','Cada hallazgo requiere gravedad, ubicación y evidencia');
  return true;
}

// Backend: el único origen de autoridad es una verificación inyectada por el
// servidor; un paquete o respuesta del modelo no puede suministrar este callback.
export async function verifyIndependentReview({authorSession,reviewSession,ticketCreatedAt,
  reviewerClientRequired=false},verifyActor){
  if(!own(authorSession)||!own(reviewSession)||!str(authorSession.id)||!str(reviewSession.id)||
    authorSession.id===reviewSession.id||reviewSession.wrote!==false)
    fail('REVIEWER_NOT_INDEPENDENT','Misma sesión autora o revisión con escrituras');
  const ticketTime=Date.parse(ticketCreatedAt),reviewTime=Date.parse(reviewSession.createdAt);
  if(!Number.isFinite(ticketTime)||!Number.isFinite(reviewTime)||reviewTime<=ticketTime)
    fail('REVIEWER_PREDATES_TICKET','La sesión revisora no es posterior al ticket');
  if(reviewerClientRequired&&(!str(reviewSession.clientId)||reviewSession.clientId===authorSession.clientId))
    fail('SAME_CLIENT','Se exige otro cliente OAuth');
  if(typeof verifyActor!=='function')fail('VERIFIER_REQUIRED','Falta verificación confiable del backend');
  if(await verifyActor({authorSessionId:authorSession.id,reviewSessionId:reviewSession.id})!==true)
    fail('ACTOR_NOT_VERIFIED','El backend no pudo verificar el aislamiento del revisor');
  return Object.freeze({verified:true,canPublish:false,
    note:'Un contexto independiente verificado no equivale a veredicto 4R; usar zana_review_finalize en la sesión revisora.'});
}
