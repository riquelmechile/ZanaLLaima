// Página del operador para aprobar o rechazar un plan: /operator/approve?aid=…
// Es la única vía que aprueba. Pide la contraseña del operador (la misma del
// alta OAuth), exige Origin del propio servidor, limita intentos por dirección
// y por solicitud, y no usa cookies: sin contraseña no hay autoridad ambiente.
import {readForm,field} from './oauth.mjs';
import {APPROVAL_ID} from './plan-approval.mjs';

const esc=s=>String(s).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
// Errores esperados; cualquier otro sube al servidor HTTP, que lo registra y responde 500.
const STATUS={NOT_FOUND:404,WORKSPACE_NOT_FOUND:404,RATE:429,ORIGIN:403,INVALID_DECISION:400,BAD_FORM:400,
  EXPIRED:409,LOCKED:409,NOT_PENDING:409};
const CLOSED={APPROVED:'Este plan ya fue aprobado.',DENIED:'Este plan fue rechazado.',
  EXPIRED:'La solicitud caducó. Pide una nueva desde ChatGPT.',
  LOCKED:'Solicitud bloqueada por intentos fallidos. Pide una nueva desde ChatGPT.',
  SUPERSEDED:'El plan cambió o el proyecto se archivó después de pedir la aprobación. Pide una nueva desde ChatGPT.',
  REPLACED:'Esta solicitud fue reemplazada por una más nueva.'};
function send(res,status,title,inner){
  res.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer',
    'x-content-type-options':'nosniff',
    'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});
  res.end('<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'+
    '<title>ZanaLLaima · '+esc(title)+'</title><style>body{font:16px system-ui;max-width:560px;margin:6vh auto;padding:20px}'+
    'code{word-break:break-all}input,button{font:inherit;padding:8px;margin:4px 0}input{width:100%;box-sizing:border-box}'+
    '.box{border:1px solid #888;border-radius:8px;padding:12px;margin:12px 0}</style><h1>'+esc(title)+'</h1>'+inner+'</html>');
}
function form(view,host,note=''){
  const p=view.plan;
  return '<p>Estás en <strong>'+esc(host)+'</strong>. Escribe la contraseña solo si esa es la dirección de tu servidor.</p>'+
    '<div class="box"><p><strong>Idea:</strong> '+esc(p.idea)+'</p><p><strong>Tecnología elegida:</strong> '+esc(p.selected.technology)+
    ' ('+esc(p.selected.id)+')</p><p><strong>Hitos:</strong></p><ol>'+
    p.milestones.map(m=>'<li><strong>'+esc(m.id)+':</strong> '+esc(m.objective)+'<br><em>Se acepta con:</em> '+esc(m.acceptance)+'</li>').join('')+
    '</ol><p><strong>Digest del plan:</strong> <code>'+esc(view.planDigest)+'</code></p></div>'+
    '<p>Aprobar el plan no crea repositorios, no fusiona y no despliega: cada una de esas acciones pide su propia autorización.</p>'+
    (note?'<p><strong>'+esc(note)+'</strong></p>':'')+
    '<form method="post"><label>Contraseña del operador<input type="password" name="password" autocomplete="current-password"></label>'+
    '<button name="decision" value="allow">Aprobar este plan</button> <button name="decision" value="deny">Rechazar</button></form>'+
    '<p>Vence: '+esc(view.expiresAt)+'. Intentos restantes: '+esc(view.attemptsLeft)+'.</p>';
}

// approvals: {describe(approvalId), decide({approvalId,decision,passwordOk})}.
export function createOperatorPage({oauth,approvals}){
  const host=new URL(oauth.issuer).host;
  const stop=code=>{throw Object.assign(new Error(code),{code});};
  // El formulario solo se muestra si la solicitud sigue abierta sobre el plan vigente.
  const show=(res,status,view,note)=>view.status==='PENDING'&&view.plan?send(res,status,'Aprobar plan',form(view,host,note)):
    send(res,status,'Solicitud cerrada','<p>'+esc(CLOSED[view.status]??'Solicitud no disponible.')+'</p>');
  return async function handle(req,res){
    const url=new URL(req.url??'','http://internal');
    if(url.pathname!=='/operator/approve')return false;
    const aid=url.searchParams.get('aid')??'',who=oauth.identity(req);
    try{
      if(req.method!=='GET'&&req.method!=='POST'){res.writeHead(405,{allow:'GET, POST'});res.end();return true;}
      if(!APPROVAL_ID.test(aid))stop('NOT_FOUND');
      if(req.method==='GET'){
        try{oauth.throttled('approve-view:'+who,120);}catch{stop('RATE');}
        show(res,200,await approvals.describe(aid));
        return true;
      }
      const origin=String(req.headers.origin??'');
      if(origin!==oauth.issuer&&!((origin===''||origin==='null')&&req.headers['sec-fetch-site']==='same-origin'))stop('ORIGIN');
      try{oauth.throttled('approve:'+who,30);}catch{stop('RATE');}
      const payload=await readForm(req).catch(()=>stop('BAD_FORM')),decision=field(payload,'decision');
      if(!['allow','deny'].includes(decision))stop('INVALID_DECISION');
      const result=await approvals.decide({approvalId:aid,decision,
        passwordOk:decision==='allow'&&oauth.operatorPassword(field(payload,'password'))});
      if(result.denied){
        if(result.status==='LOCKED')send(res,403,'Solicitud bloqueada','<p>Contraseña incorrecta. '+esc(CLOSED.LOCKED)+'</p>');
        else show(res,403,await approvals.describe(aid),'Contraseña incorrecta.');
      }else if(result.status==='APPROVED')
        send(res,200,'Plan aprobado','<p>Plan aprobado. Digest: <code>'+esc(result.planDigest)+'</code></p><p>Vuelve a ChatGPT para continuar.</p>');
      else if(result.status==='DENIED')send(res,200,'Plan rechazado','<p>Plan rechazado. No se aprobó nada.</p>');
      else send(res,409,'Solicitud cerrada','<p>'+esc(CLOSED[result.status]??'Solicitud no disponible.')+'</p>');
    }catch(error){
      const code=String(error?.code??'').replace(/^APPROVAL_/,''),status=STATUS[code];
      if(!status)throw error;
      const text={404:'No existe esa solicitud.',429:'Demasiados intentos. Espera una hora.',403:'Solicitud no permitida.',
        409:CLOSED[code]??'Esta solicitud ya fue decidida.'}[status]??'Solicitud inválida.';
      send(res,status,'Solicitud no disponible','<p>'+esc(text)+'</p>');
    }
    return true;
  };
}
