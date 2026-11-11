// Página del operador para aprobar, rechazar o revocar un plan:
// /operator/approve?aid=…  Es la única vía que aprueba. Pide la contraseña del
// operador (la misma del alta OAuth), exige Origin del propio servidor, limita
// intentos por dirección y por solicitud, y no usa cookies: sin contraseña no
// hay autoridad ambiente. Muestra el plan completo que cubre el digest.
import {readForm,field} from './oauth.mjs';
import {APPROVAL_ID} from './plan-approval.mjs';

const esc=s=>String(s).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
const CLOSED={APPROVED:'Este plan ya fue aprobado.',DENIED:'Este plan fue rechazado.',REVOKED:'La aprobación de este plan fue revocada.',
  EXPIRED:'La solicitud caducó. Pide una nueva desde ChatGPT.',
  LOCKED:'Solicitud bloqueada por intentos fallidos. Pide una nueva desde ChatGPT.',
  SUPERSEDED:'El plan cambió o el proyecto se archivó después de pedir la aprobación. Pide una nueva desde ChatGPT.',
  REPLACED:'Esta solicitud fue reemplazada por una más nueva.'};
// Errores esperados: código → [estado HTTP, texto]. Cualquier otro sube al
// servidor HTTP, que lo registra y responde 500.
const MISSING=[404,'No existe esa solicitud.'],INVALID=[400,'Solicitud inválida.'];
const ERRORS={APPROVAL_NOT_FOUND:MISSING,WORKSPACE_NOT_FOUND:MISSING,INVALID_DECISION:INVALID,BAD_FORM:INVALID,
  RATE:[429,'Demasiados intentos. Espera una hora.'],ORIGIN:[403,'Solicitud no permitida.'],
  APPROVAL_EXPIRED:[409,CLOSED.EXPIRED],APPROVAL_LOCKED:[409,CLOSED.LOCKED],
  APPROVAL_NOT_PENDING:[409,'Esta solicitud ya fue decidida.'],
  APPROVAL_NOT_APPROVED:[409,'Esta solicitud no tiene una aprobación vigente.']};
// Limitador propio, por hora: no comparte cupo con el de OAuth, y solo gasta
// una entrada cuando la solicitud existe. Lleno, rechaza direcciones nuevas.
function limiter(max=1024,windowMs=3600_000){
  const seen=new Map();
  return (key,limit,now=Date.now())=>{
    const row=seen.get(key);
    if(row&&now-row.since<=windowMs)return ++row.count<=limit;
    if(seen.size>=max)for(const [k,v] of seen)if(now-v.since>windowMs)seen.delete(k);
    if(seen.size>=max)return false;
    seen.set(key,{count:1,since:now});
    return true;
  };
}
function send(res,status,title,inner){
  res.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'same-origin',
    'x-content-type-options':'nosniff',
    'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});
  res.end('<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'+
    '<title>ZanaLLaima · '+esc(title)+'</title><style>body{font:16px system-ui;max-width:640px;margin:6vh auto;padding:20px}'+
    'code,li{word-break:break-word}input,button{font:inherit;padding:8px;margin:4px 0}input{width:100%;box-sizing:border-box}'+
    '.box{border:1px solid #888;border-radius:8px;padding:12px;margin:12px 0}</style><h1>'+esc(title)+'</h1>'+inner+'</html>');
}
// Todo lo que entra al digest se muestra: idea, respuestas, cada alternativa
// con sus fuentes y cada hito con sus dependencias.
function planHtml(p,digest){
  const item=(k,v)=>'<br><em>'+k+':</em> '+esc(v);
  return '<div class="box"><p><strong>Idea:</strong> '+esc(p.idea)+'</p><p><strong>Respuestas:</strong></p><ul>'+
    Object.entries(p.answers).map(([k,v])=>'<li><strong>'+esc(k)+':</strong> '+esc(v)+'</li>').join('')+
    '</ul><p><strong>Alternativas comparadas:</strong></p><ul>'+p.alternatives.map(a=>
      '<li><strong>'+esc(a.id)+(a.id===p.selectedId?' (la elegida)':'')+':</strong> '+esc(a.technology)+
      item('Por qué',a.rationale)+item('Ventajas',a.benefits)+item('Costos',a.tradeoffs)+
      item('Fuentes',a.sources.map(s=>s.title+' · '+s.url+' ('+s.checkedOn+')').join('; '))+'</li>').join('')+
    '</ul><p><strong>Hitos:</strong></p><ol>'+p.milestones.map(m=>'<li><strong>'+esc(m.id)+':</strong> '+esc(m.objective)+
      item('Se acepta con',m.acceptance)+(m.dependsOn.length?item('Depende de',m.dependsOn.join(', ')):'')+'</li>').join('')+
    '</ol><p><strong>Digest del plan:</strong> <code>'+esc(digest)+'</code></p></div>';
}
function form(view,host,note=''){
  return '<p>Estás en <strong>'+esc(host)+'</strong>. Escribe la contraseña solo si esa es la dirección de tu servidor.</p>'+
    planHtml(view.plan,view.planDigest)+
    '<p>Aprobar el plan no crea repositorios, no fusiona y no despliega: cada una de esas acciones pide su propia autorización.</p>'+
    (note?'<p><strong>'+esc(note)+'</strong></p>':'')+
    '<form method="post"><label>Contraseña del operador<input type="password" name="password" autocomplete="current-password"></label>'+
    '<button name="decision" value="allow">Aprobar este plan</button> <button name="decision" value="deny">Rechazar</button></form>'+
    '<p>Vence: '+esc(view.expiresAt)+'. Intentos restantes: '+esc(view.attemptsLeft)+'.</p>';
}
const REVOKE='<form method="post"><button name="decision" value="revoke">Revocar la aprobación</button></form>';

// approvals: {describe(approvalId), decide({approvalId,decision,passwordOk,from})}.
export function createOperatorPage({oauth,approvals}){
  const host=new URL(oauth.issuer).host,allowed=limiter();
  const stop=code=>{throw Object.assign(new Error(code),{code});};
  // El formulario solo se muestra si la solicitud sigue abierta sobre el plan vigente.
  const show=(res,status,view,note)=>view.status==='PENDING'&&view.plan?send(res,status,'Aprobar plan',form(view,host,note)):
    send(res,status,'Solicitud cerrada','<p>'+esc(CLOSED[view.status]??'Solicitud no disponible.')+'</p>'+
      (view.revocable?'<p>Digest: <code>'+esc(view.planDigest)+'</code></p>'+
        (view.status==='APPROVED'?'':'<p>La aprobación de ese plan sigue guardada: si el proyecto vuelve a ese mismo plan, vuelve a valer.</p>')+REVOKE:''));
  return async function handle(req,res){
    const raw=String(req.url??''),cut=raw.indexOf('?');
    if((cut<0?raw:raw.slice(0,cut))!=='/operator/approve')return false;
    const aid=new URLSearchParams(cut<0?'':raw.slice(cut+1)).get('aid')??'',who=oauth.identity(req);
    try{
      if(req.method!=='GET'&&req.method!=='POST'){res.writeHead(405,{allow:'GET, POST'});res.end();return true;}
      if(req.method==='POST'){
        const origin=String(req.headers.origin??'');
        if(origin!==oauth.issuer&&!((origin===''||origin==='null')&&req.headers['sec-fetch-site']==='same-origin'))stop('ORIGIN');
      }
      if(!APPROVAL_ID.test(aid))stop('APPROVAL_NOT_FOUND');
      const view=await approvals.describe(aid); // lanza APPROVAL_NOT_FOUND antes de tocar el limitador
      if(req.method==='GET'){
        if(!allowed('view:'+who,120))stop('RATE');
        show(res,200,view);
        return true;
      }
      if(!allowed('post:'+who,30))stop('RATE');
      if(String(req.headers['content-type']??'').split(';')[0].trim()!=='application/x-www-form-urlencoded')stop('BAD_FORM');
      const payload=await readForm(req).catch(()=>stop('BAD_FORM')),decision=field(payload,'decision');
      if(!['allow','deny','revoke'].includes(decision))stop('INVALID_DECISION');
      const result=await approvals.decide({approvalId:aid,decision,from:who,
        passwordOk:decision==='allow'&&oauth.operatorPassword(field(payload,'password'))});
      if(result.denied){
        if(result.status==='LOCKED')send(res,403,'Solicitud bloqueada','<p>Contraseña incorrecta. '+esc(CLOSED.LOCKED)+'</p>');
        else show(res,403,await approvals.describe(aid),'Contraseña incorrecta.');
      }else if(result.status==='APPROVED')
        send(res,200,'Plan aprobado','<p>Plan aprobado. Digest: <code>'+esc(result.planDigest)+'</code></p><p>Vuelve a ChatGPT para continuar.</p>');
      else if(result.status==='DENIED')send(res,200,'Plan rechazado','<p>Plan rechazado. No se aprobó nada.</p>');
      else if(result.status==='REVOKED')send(res,200,'Aprobación revocada','<p>Aprobación revocada. El plan ya no está aprobado.</p>');
      else send(res,409,'Solicitud cerrada','<p>'+esc(CLOSED[result.status]??'Solicitud no disponible.')+'</p>');
    }catch(error){
      const known=ERRORS[error?.code];
      if(!known)throw error;
      send(res,known[0],'Solicitud no disponible','<p>'+esc(known[1])+'</p>');
    }
    return true;
  };
}
