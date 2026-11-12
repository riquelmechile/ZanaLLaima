// Eventos MCP con entrega por webhook: el servidor avisa al anfitrión que hay
// una revisión lista y el anfitrión despierta una ejecución nueva que la
// reclama. Aquí no se llama a ningún modelo: solo sale un puntero opaco
// (el id del ticket), firmado, hacia el callback que el propio anfitrión
// registró y verificó. El aviso no concede nada: quien reclama vuelve a
// autenticarse por OAuth y pasa las mismas reglas de siempre.
//
// Procedencia: portado de riquelmechile/panter-ai (src/core/workforce-events.ts,
// del mismo autor), adaptado a un solo host y a la base de estado de ZanaLLaima.
// Protocolo: https://developers.openai.com/plugins/build/mcp-events
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {request} from 'node:https';
import {BlockList,isIP} from 'node:net';

export const REVIEW_EVENT='zana.review.ready';
export const REVIEW_DONE_EVENT='zana.review.done';
const SUB='zana:evsub:',OUT='zana:evout:';
const MAX_TTL_MS=7*86_400_000,MAX_SUBSCRIPTIONS_PER_CLIENT=4,MAX_OUTSTANDING=200,MAX_ATTEMPTS=5,HISTORY_MS=7*86_400_000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(code,msg)=>{const e=new Error(code+': '+msg);e.code=code;throw e;};
const hash=v=>createHash('sha256').update(v).digest('hex');
const iso=ms=>new Date(ms).toISOString();

// Direcciones a las que el servidor nunca debe llamar (red interna, enlace local, documentación).
const blocked=new BlockList();
for(const [ip,mask] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],
  ['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])
  blocked.addSubnet(ip,mask,'ipv4');
for(const [ip,mask] of [['::',128],['::1',128],['fc00::',7],['fe80::',10],['ff00::',8],['2001:db8::',32],['2001:10::',28]])
  blocked.addSubnet(ip,mask,'ipv6');
export function publicIp(ip){
  const family=isIP(ip);
  if(!family||(family===6&&!String(ip).toLowerCase().startsWith('2')))return false;
  return !blocked.check(ip,family===4?'ipv4':'ipv6');
}
export function validCallback(raw){
  let u=null;
  try{u=typeof raw==='string'&&raw.length<=2048?new URL(raw):null;}catch{}
  const host=u?.hostname.toLowerCase()??'';
  if(!u||u.protocol!=='https:'||!host.includes('.')||isIP(host)!==0||u.username||u.password||u.port||u.hash||
    host==='localhost'||['.localhost','.internal','.local','.test','.invalid','.example'].some(s=>host.endsWith(s)))
    fail('INVALID_CALLBACK','Only public HTTPS callback endpoints are allowed');
  return u;
}
function secretBytes(secret){
  const raw=typeof secret==='string'&&/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)?secret.slice(6):'';
  const bytes=Buffer.from(raw,'base64');
  if(bytes.length<24||bytes.length>64||bytes.toString('base64')!==raw)fail('INVALID_SECRET','Invalid webhook signing secret');
  return bytes;
}
// Standard Webhooks: firma de "id.timestamp.cuerpo" con el secreto del anfitrión.
export function webhookHeaders(secret,id,subscriptionId,body,signedAt=Math.floor(Date.now()/1000)){
  const timestamp=String(signedAt);
  return {'content-type':'application/json','webhook-id':id,'webhook-timestamp':timestamp,
    'webhook-signature':'v1,'+createHmac('sha256',secretBytes(secret)).update(id+'.'+timestamp+'.'+body).digest('base64'),
    'X-MCP-Subscription-Id':subscriptionId};
}
// POST saliente: resuelve el DNS en cada llamada, rechaza cualquier respuesta
// privada y fija una dirección ya validada para la conexión TLS. Sin
// redirecciones, con tope de tiempo y de tamaño de respuesta.
export async function safeWebhookPost(url,headers,body){
  const u=validCallback(url);
  const records=await lookup(u.hostname,{all:true,verbatim:true});
  if(!records.length||!records.every(r=>publicIp(r.address)))fail('INVALID_CALLBACK','Unsafe webhook destination');
  const {address,family}=records[0];
  return new Promise((resolve,reject)=>{
    const req=request(u,{method:'POST',servername:u.hostname,timeout:7000,maxHeaderSize:16384,
      lookup:(_host,opts,cb)=>opts.all?cb(null,[{address,family}]):cb(null,address,family),
      headers:{...headers,'content-length':Buffer.byteLength(body)}},res=>{
      const chunks=[];let total=0;
      res.on('data',chunk=>{total+=chunk.length;if(total>8192)req.destroy(new Error('Webhook response too large'));else chunks.push(chunk);});
      res.on('end',()=>resolve({status:res.statusCode??0,body:Buffer.concat(chunks).toString('utf8')}));
      res.on('error',reject);
    });
    req.on('timeout',()=>req.destroy(new Error('Webhook timeout')));
    req.on('error',reject);req.end(body);
  });
}

const rows=(db,prefix)=>db.prepare('SELECT value FROM metadata WHERE key LIKE ?').all(prefix+'%').flatMap(x=>{try{return [JSON.parse(x.value)];}catch{return [];}});
const put=(db,prefix,row)=>db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(prefix+row.id,JSON.stringify(row));
const del=(db,prefix,id)=>db.prepare('DELETE FROM metadata WHERE key=?').run(prefix+id);
const live=(s,now)=>Date.parse(s.expiresAt)>now;
const terminal=d=>d.state==='ACCEPTED'||d.state==='FAILED';
const subId=({clientId,host},url,name=REVIEW_EVENT)=>'sub_'+hash([clientId,host,url,name].join('\n')).slice(0,32);
// El filtro del anfitrión debe nombrar su propio host: la identidad sale del OAuth, no del filtro.
function check(identity,input){
  if(![REVIEW_EVENT,REVIEW_DONE_EVENT].includes(input?.name))fail('UNKNOWN_EVENT','Unknown event');
  const args=input.arguments;
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length!==1||args.host!==identity.host)
    fail('INVALID_EVENT_FILTER','Event filter must match the authenticated host');
}

export function listEvents({host}){
  return {events:[{name:REVIEW_EVENT,delivery:['webhook'],
    description:'A review ticket of this account is ready. Start a new run, load the zana-4r skill and claim it with zana_review_claim.',
    inputSchema:{type:'object',properties:{host:{type:'string',enum:[host]}},required:['host'],additionalProperties:false},
    payloadSchema:{type:'object',properties:{ticketId:{type:'string',format:'uuid'}},required:['ticketId'],additionalProperties:false}},
    {name:REVIEW_DONE_EVENT,delivery:['webhook'],description:'A 4R review of this account finished. Start a new run, load the zana-project-orchestrator skill, adopt the mission with zana_mission_adopt and resume it.',
      inputSchema:{type:'object',properties:{host:{type:'string',enum:[host]}},required:['host'],additionalProperties:false},
      payloadSchema:{type:'object',properties:{ticketId:{type:'string',format:'uuid'},verdict:{type:'string',enum:['APPROVE','REQUEST_CHANGES']}},required:['ticketId','verdict'],additionalProperties:false}}]};
}

// rw: transacción de escritura. post: envío saliente (safeWebhookPost en producción).
export async function subscribeEvent({rw,post=safeWebhookPost,identity,input,now=()=>Date.now()}){
  check(identity,input);
  if(input.cursor!==undefined&&input.cursor!==null)fail('EVENT_REPLAY_UNSUPPORTED','Event replay not supported');
  if(input.delivery?.mode!=='webhook')fail('INVALID_CALLBACK','Webhook delivery required');
  const url=validCallback(input.delivery.url).toString(),secret=input.delivery.secret;
  secretBytes(secret);
  const requested=input.ttlMs===undefined||input.ttlMs===null?MAX_TTL_MS:input.ttlMs;
  if(!Number.isInteger(requested)||requested<60_000)fail('INVALID_EVENT_TTL','Invalid event subscription TTL');
  const ttl=Math.min(MAX_TTL_MS,requested),id=subId(identity,url,input.name);
  const known=await rw(db=>rows(db,SUB).find(s=>s.id===id&&live(s,now())&&s.secret===secret));
  if(!known){
    // El anfitrión prueba que controla el callback devolviendo el desafío.
    const challenge=randomBytes(24).toString('base64url'),body=JSON.stringify({type:'verification',challenge});
    let answer;
    try{answer=await post(url,webhookHeaders(secret,'msg_verification_'+randomBytes(12).toString('hex'),id,body),body);}
    catch{fail('CALLBACK_ENDPOINT_ERROR','CallbackEndpointError: connection or TLS failure');}
    if(answer.status<200||answer.status>=300)fail('CALLBACK_ENDPOINT_ERROR','CallbackEndpointError: verification HTTP error');
    let got='';
    try{got=JSON.parse(answer.body)?.challenge;}catch{}
    const a=Buffer.from(typeof got==='string'?got:''),b=Buffer.from(challenge);
    if(a.length!==b.length||!timingSafeEqual(a,b))fail('CALLBACK_ENDPOINT_ERROR','CallbackEndpointError: challenge_failed');
  }
  const expiresAt=iso(now()+ttl);
  await rw(db=>{
    const mine=rows(db,SUB).filter(s=>s.ownerClient===identity.clientId&&s.id!==id);
    for(const old of mine.filter(s=>!live(s,now())))del(db,SUB,old.id);
    if(mine.filter(s=>live(s,now())).length>=MAX_SUBSCRIPTIONS_PER_CLIENT)fail('EVENT_SUBSCRIPTION_LIMIT','Too many event subscriptions for this client');
    put(db,SUB,{schema:'zana.evsub.v1',id,ownerClient:identity.clientId,host:identity.host,name:input.name,url,secret,expiresAt,verifiedAt:iso(now())});
  });
  return {id,refreshBefore:iso(Date.parse(expiresAt)-Math.floor(ttl/4)),cursor:null,truncated:false};
}

export function unsubscribeEvent(db,{identity,input}){
  check(identity,input);
  const id=subId(identity,validCallback(input.delivery?.url).toString(),input.name);
  const found=rows(db,SUB).find(s=>s.id===id&&s.ownerClient===identity.clientId);
  if(found){
    del(db,SUB,id);
    for(const d of rows(db,OUT))if(d.subId===id)del(db,OUT,d.id);
  }
  return {};
}

// Encola un aviso por cada suscripción vigente del cliente dueño del ticket.
// Va en la misma transacción que emite el ticket. Devuelve cuántos encoló.
export function queueEvent(db,{clientId,ticketId,name=REVIEW_EVENT,data=null,now=Date.now()}){
  if(![REVIEW_EVENT,REVIEW_DONE_EVENT].includes(name))fail('UNKNOWN_EVENT','Unknown event');
  if(name===REVIEW_DONE_EVENT&&(!data||!['APPROVE','REQUEST_CHANGES'].includes(data.verdict)))fail('INVALID_EVENT_POINTER','Invalid review verdict');
  if(!UUID.test(String(ticketId)))fail('INVALID_EVENT_POINTER','El aviso solo lleva el id del ticket');
  const all=rows(db,OUT);
  for(const old of all)if(terminal(old)&&now-(old.terminalAt??0)>=HISTORY_MS)del(db,OUT,old.id);
  let added=0,outstanding=all.filter(d=>!terminal(d)).length;
  for(const sub of rows(db,SUB).filter(s=>s.ownerClient===clientId&&live(s,now)&&(s.name??REVIEW_EVENT)===name)){
    const id='evt_'+hash(sub.id+':'+name+':'+ticketId).slice(0,32);
    if(all.some(d=>d.id===id))continue;
    if(outstanding>=MAX_OUTSTANDING)fail('EVENT_BACKLOG_LIMIT','MCP event backlog limit reached');
    put(db,OUT,{schema:'zana.evout.v1',id,subId:sub.id,ticketId,name,data:name===REVIEW_DONE_EVENT?{ticketId,verdict:data.verdict}:{ticketId},state:'PENDING',attempts:0,nextAt:now,lastStatus:null,terminalAt:null});
    outstanding++;added++;
  }
  return added;
}

// Envía lo pendiente. Cada intento se toma dentro de una transacción (queda
// SENDING con su número de intento), así dos vaciados no mandan el mismo.
export async function flushEvents({rw,post=safeWebhookPost,now=()=>Date.now(),limit=10}){
  let attempted=0;
  for(let n=0;n<Math.min(20,limit);n++){
    const item=await rw(db=>{
      const t=now(),subs=rows(db,SUB);
      for(const next of rows(db,OUT).filter(d=>!terminal(d)&&d.nextAt<=t).sort((a,b)=>a.nextAt-b.nextAt)){
        const sub=subs.find(s=>s.id===next.subId&&live(s,t));
        if(!sub||next.attempts>=MAX_ATTEMPTS){
          put(db,OUT,{...next,state:'FAILED',terminalAt:t,failureReason:sub?'ATTEMPTS_EXHAUSTED':'SUBSCRIPTION_INACTIVE'});
          continue;
        }
        const taken={...next,attempts:next.attempts+1,state:'SENDING',nextAt:t+60_000};
        put(db,OUT,taken);
        return {delivery:taken,sub};
      }
      return null;
    });
    if(!item)break;
    attempted++;
    const {delivery,sub}=item;
    const body=JSON.stringify({eventId:delivery.id,name:delivery.name??REVIEW_EVENT,timestamp:iso(now()),data:delivery.data??{ticketId:delivery.ticketId},cursor:null});
    let status=null;
    try{status=(await post(sub.url,webhookHeaders(sub.secret,delivery.id,sub.id,body,Math.floor(now()/1000)),body)).status;}
    catch{/* nunca se registra la URL, el secreto ni el error del anfitrión */}
    await rw(db=>{
      const current=rows(db,OUT).find(d=>d.id===delivery.id);
      if(!current||current.state!=='SENDING'||current.attempts!==delivery.attempts)return;
      const t=now(),accepted=status!==null&&status>=200&&status<300;
      if(accepted)put(db,OUT,{...current,state:'ACCEPTED',lastStatus:status,terminalAt:t});
      else if(status===410||status===413||current.attempts>=MAX_ATTEMPTS)put(db,OUT,{...current,state:'FAILED',lastStatus:status,terminalAt:t});
      else put(db,OUT,{...current,state:'PENDING',lastStatus:status,nextAt:t+Math.min(300_000,5000*2**(current.attempts-1))});
    });
  }
  return attempted;
}

// Cuentas para el operador. Un 2xx del anfitrión solo dice que recibió el
// aviso; que haya despertado se ve cuando una sesión nueva reclama el ticket.
export function eventStatus(db,{now=Date.now()}={}){
  const out=rows(db,OUT);
  return {subscriptions:rows(db,SUB).filter(s=>live(s,now)).length,pending:out.filter(d=>!terminal(d)).length,
    accepted:out.filter(d=>d.state==='ACCEPTED').length,failed:out.filter(d=>d.state==='FAILED').length};
}

// Cliente OAuth revocado: se borran sus suscripciones y sus avisos pendientes se cierran.
export function dropClientEvents(db,{clientId,now=Date.now()}){
  const gone=new Set(rows(db,SUB).filter(s=>s.ownerClient===clientId).map(s=>s.id));
  for(const id of gone)del(db,SUB,id);
  for(const d of rows(db,OUT))if(gone.has(d.subId)&&!terminal(d))put(db,OUT,{...d,state:'FAILED',terminalAt:now,failureReason:'SUBSCRIPTION_INACTIVE'});
  return gone.size;
}
