// Ejecución del bootstrap: crea en GitHub el repositorio de una operación que
// el operador autorizó. Una autorización vale para un solo intento, y un
// resultado incierto nunca se reintenta: se reconcilia contra GitHub.
//   AWAITING_AUTHORIZATION → RESERVED → UNCERTAIN → DONE
// rw/rr: transacciones de escritura y lectura sobre la base de estado.
// github: cliente con el token de bootstrap (no el de las misiones).
import {executeBootstrap} from './project-bootstrap.mjs';
import {bootstrapAuthorized,bootstrapStatus,readOperation,saveOperation} from './bootstrap-request.mjs';
import {consumeRepositoryApproval} from './plan-approval.mjs';

const SKEW_MS=300_000;
// Margen tras un intento antes de afirmar que no creó nada: GitHub puede
// terminar de crear después de que el cliente cortó por tiempo.
const SETTLE_MS=60_000;
const fail=(code,msg)=>{const e=new Error(code+': '+msg);e.code=code;throw e;};
const iso=ms=>new Date(ms).toISOString();
const text=(v,max=200)=>String(v??'').replace(/[\p{Cc}\p{Cf}]/gu,'').slice(0,max);
const repoOf=intent=>intent.owner+'/'+intent.name;
// La petición no creó nada con certeza: GitHub respondió 4xx (salvo 408 y 429,
// que pueden esconder un resultado), o ni siquiera salió del servidor porque
// el circuito estaba abierto o faltaba el token.
const definite=e=>Number.isInteger(e?.status)&&(e.status>=400&&e.status<500&&![408,429].includes(e.status)||
  e.status===503&&/circuit open|token not configured/.test(String(e.message)));
// Marca que va en la descripción del repositorio: liga el repo al intento que lo creó.
const mark=operationId=>'Creado por ZanaLLaima (operación '+operationId+')';
// El repositorio encontrado es el de esta operación: cuenta, nombre, visibilidad, marca y fecha.
const ours=(found,op,since)=>Boolean(found)&&Number.isSafeInteger(found.id)&&found.id>0&&
  String(found.full_name).toLowerCase()===repoOf(op.intent).toLowerCase()&&
  String(found.owner?.login).toLowerCase()===op.intent.owner.toLowerCase()&&
  found.private===(op.intent.visibility==='private')&&String(found.description??'').includes(mark(op.operationId))&&
  Date.parse(found.created_at)>=since-SKEW_MS;
const slim=r=>({id:r.id,fullName:text(r.full_name),private:r.private===true,htmlUrl:text(r.html_url,300),defaultBranch:text(r.default_branch,100)});
async function lookup(github,repo){
  try{return await github.repo(repo);}
  catch(error){if(error?.status===404)return null;throw error;}
}

export async function runBootstrap({rw,rr,github,allowed,clientId,operationId,now=()=>Date.now()}){
  const at={clientId,operationId};
  const status=()=>rr(db=>bootstrapStatus(db,{...at,now:now()}));
  const stamp=fields=>rw(db=>saveOperation(db,{...readOperation(db,at),...fields,updatedAt:iso(now())}));
  const authorized=()=>rr(db=>bootstrapAuthorized(db,{...at,now:now()}));
  const op=await rr(db=>readOperation(db,at)),repo=repoOf(op.intent);
  if(op.state==='DONE')return {...await status(),reused:true};
  if(op.state!=='AWAITING_AUTHORIZATION')
    fail('RECONCILIATION_REQUIRED','Hay un intento anterior con resultado incierto: usa zana_bootstrap_reconcile');
  if(!await authorized())fail('AUTHORIZATION_REQUIRED','El operador debe autorizar esta creación (zana_bootstrap_request)');
  if(allowed(repo)!==true)fail('REPO_NOT_ALLOWED',JSON.stringify(repo)+' no está permitido por ZANA_GITHUB_REPOS');
  // Comprobaciones sin efecto, antes de gastar la autorización.
  const login=text((await github.request('GET','/user'))?.login,60);
  if(login.toLowerCase()!==op.intent.owner.toLowerCase())
    fail('OWNER_MISMATCH','El token de bootstrap crea repositorios de '+JSON.stringify(login)+', no de '+JSON.stringify(op.intent.owner));
  if(await lookup(github,repo))fail('REPO_ALREADY_EXISTS','Ya existe '+JSON.stringify(repo)+'; elige otro nombre');
  const result=await executeBootstrap(op.intent,{
    authorize:async()=>await authorized()&&allowed(repo)===true,
    // Solo quien hace la transición recibe RESERVED: otra ejecución en curso no crea.
    reserve:()=>rw(db=>{
      const current=readOperation(db,at),digest=current.intent.digest;
      if(current.state==='DONE')return {state:'DONE',digest,repository:current.repository};
      if(current.state!=='AWAITING_AUTHORIZATION')return {state:'BUSY',digest};
      // Dentro de la misma transacción: la autorización sigue siendo de esta operación exacta.
      if(!bootstrapAuthorized(db,{...at,now:now()}))fail('AUTHORIZATION_REQUIRED','El operador debe autorizar esta creación (zana_bootstrap_request)');
      consumeRepositoryApproval(db,{clientId,approvalId:current.approvalId,now:now()});
      saveOperation(db,{...current,state:'RESERVED',lastError:null,updatedAt:iso(now())});
      return {state:'RESERVED',digest};
    }),
    markUncertain:()=>stamp({state:'UNCERTAIN',attemptedAt:iso(now())}),
    createRepository:async({name,private:isPrivate})=>{
      const started=now();
      try{return await github.request('POST','/user/repos',{body:{name,private:isPrivate,auto_init:true,description:mark(operationId)}});}
      catch(error){
        if(!definite(error))throw error;
        // Un rechazo puede esconder un repositorio creado a medias: se mira antes de liberar.
        const found=await lookup(github,repo).catch(()=>undefined);
        if(found===undefined)throw error; // no se pudo comprobar: queda incierto
        if(ours(found,op,started))return found;
        error.definite=true;throw error;
      }
    },
    commit:({repository})=>stamp({state:'DONE',repository:slim(repository),lastError:null}),
    release:({cause})=>stamp({state:'AWAITING_AUTHORIZATION',lastError:cause}),
  });
  return {...await status(),reused:result.reused};
}

// Para una operación RESERVED o UNCERTAIN: mira en GitHub qué pasó de verdad.
// Adopta el repositorio solo si lo creó este intento; si no existe, o existe
// pero no es de este intento, la operación vuelve a esperar autorización.
export async function reconcileBootstrap({rw,rr,github,clientId,operationId,now=()=>Date.now()}){
  const at={clientId,operationId};
  const op=await rr(db=>readOperation(db,at)),repo=repoOf(op.intent);
  if(!['RESERVED','UNCERTAIN'].includes(op.state))fail('NOTHING_TO_RECONCILE','La operación está en '+op.state);
  const found=await lookup(github,repo);
  const mine=op.state==='UNCERTAIN'&&ours(found,op,Date.parse(op.attemptedAt));
  if(!found&&op.state==='UNCERTAIN'&&now()-Date.parse(op.attemptedAt)<SETTLE_MS)
    fail('RECONCILE_TOO_EARLY','Todavía no se puede saber si el intento creó el repositorio; reconcilia en un minuto');
  const next=mine?{state:'DONE',repository:slim(found),lastError:null}
    :{state:'AWAITING_AUTHORIZATION',lastError:found?'REPO_ALREADY_EXISTS: existe un repositorio con ese nombre que no creó este intento'
      :'El intento no creó el repositorio; pide una autorización nueva'};
  await rw(db=>{
    const current=readOperation(db,at);
    if(current.state!==op.state)fail('NOTHING_TO_RECONCILE','La operación cambió mientras se reconciliaba');
    saveOperation(db,{...current,...next,updatedAt:iso(now())});
  });
  if(found&&!mine)fail('REPO_ALREADY_EXISTS','Existe '+JSON.stringify(repo)+' y no lo creó este intento; elige otro nombre');
  return rr(db=>bootstrapStatus(db,{...at,now:now()}));
}
