#!/usr/bin/env node
// Remote MCP Streamable HTTP listener (2025-era sessionful transport).
// Listens on 127.0.0.1 only; a Cloudflare tunnel publishes it. Every /mcp
// request needs an OAuth access token from the embedded authorization server
// (closed registration, src/oauth.mjs). Each MCP session gets its own
// transport and McpServer; its Mcp-Session-Id is bound to the OAuth identity
// that opened it. La sesión de ZanaLLaima de cada tool call (dueña de unidades,
// autora y revisora, con su creación guardada en SQLite) es la conversación de
// ChatGPT cuando viene; si no, la del transporte (ver conversationSessionId). Requests carrying a 2026 per-request envelope are answered with
// a protocol error, so negotiating clients fall back to the sessionful
// handshake. Wiring adapted from panter-ai@1a99048 src/server.ts
// (/health, Host/Origin allowlists, 401 challenge, no-store).
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname,join,resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {WebStandardStreamableHTTPServerTransport,isInitializeRequest} from '@modelcontextprotocol/server';
import {EmbeddedOAuth} from './oauth.mjs';
import {createRemoteRuntime} from './remote.mjs';
import {registerSession} from './remote-state.mjs';
import {ensureSchema,statePath} from './store.mjs';
import {clean,envSecrets} from './redact.mjs';

const packageVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
const MAX_BODY=4*1024*1024;
const MAX_SESSIONS=200;
const IDLE_MS=2*3600*1000;
// ChatGPT abre un transporte por tool call y no lo cierra: el que solo sirvió a
// una conversación (o no hizo ninguna llamada) no guarda nada y se suelta rápido.
// El que es la identidad de su sesión (sin openai/session) conserva las 2 h.
const CONVERSATION_IDLE_MS=5*60*1000;

// ChatGPT abre una sesión MCP nueva en casi cada tool call, así que el
// Mcp-Session-Id no sirve para reconocer una conversación. Cada tools/call trae
// _meta["openai/session"], un id anonimizado de la conversación (Apps SDK,
// "for correlating tool calls within the same ChatGPT session"). La sesión de
// ZanaLLaima es su hash junto a la identidad OAuth: la misma conversación con
// otra cuenta da otra sesión y el valor crudo no se guarda. Sin el campo, o con
// un valor fuera de 1-128 ASCII imprimible, se usa la sesión del transporte.
// No debilita la separación de la revisión: un cliente ya podía abrir una
// sesión MCP nueva cuando quisiera, y este valor lo pone ChatGPT, no el modelo.
const OPENAI_SESSION=/^[\x21-\x7e][\x20-\x7e]{0,127}$/;
export function conversationSessionId(identity,meta){
  const raw=meta?.['openai/session'];
  if(typeof raw!=='string'||!OPENAI_SESSION.test(raw))return null;
  return 'oai-'+createHash('sha256').update(identity.clientId+'\0'+identity.host+'\0'+raw).digest('hex').slice(0,32);
}

const hostname=h=>{try{return new URL('http://'+(h??'')).hostname.toLowerCase().replace(/^\[|\]$/g,'');}catch{return '';}};
function jsonRpcError(res,status,code,message,headers={}){
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store',...headers});
  res.end(JSON.stringify({jsonrpc:'2.0',error:{code,message},id:null}));
}
async function readBody(req){
  // Drain an oversized body (discarding it) so the client receives the 413
  // instead of a reset connection.
  const parts=[];let size=0;
  for await(const chunk of req){
    size+=chunk.length;
    if(size<=MAX_BODY)parts.push(chunk);
  }
  if(size>MAX_BODY)throw Object.assign(new Error('Request body too large'),{status:413});
  return Buffer.concat(parts);
}
async function sendWeb(res,response){
  const headers={};
  response.headers.forEach((v,k)=>{headers[k]=v;});
  res.writeHead(response.status,headers);
  if(!response.body){res.end();return;}
  const reader=response.body.getReader();
  res.on('close',()=>{reader.cancel().catch(()=>{});});
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;res.write(value);}
  }catch{/* client went away */}
  res.end();
}

export function httpSettings(env=process.env){
  // 0 picks a free port (tests); production uses a fixed port behind the tunnel.
  const port=Number(env.ZANA_HTTP_PORT??8787);
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('ZANA_HTTP_PORT must be 0-65535');
  // No default: the public hostname is the operator's own, set only on the server.
  const publicHost=String(env.ZANA_PUBLIC_HOST??'').trim();
  const publicUrl=env.ZANA_PUBLIC_MCP_URL||(publicHost?'https://'+publicHost+'/mcp':null);
  // The Host allowlist and the OAuth issuer must name the same hostname.
  let urlHost='';
  if(publicUrl){
    try{urlHost=new URL(publicUrl).hostname.toLowerCase();}catch{throw new Error('ZANA_PUBLIC_MCP_URL must be an absolute URL');}
    if(publicHost&&hostname(publicHost)!==urlHost)
      throw new Error('ZANA_PUBLIC_HOST and ZANA_PUBLIC_MCP_URL name different hosts');
  }
  const origins=String(env.ZANA_ALLOWED_ORIGINS??'https://chatgpt.com').split(',').map(x=>x.trim()).filter(Boolean);
  const redirectUris=String(env.ZANA_OAUTH_REDIRECT_URIS??'https://chatgpt.com/connector_platform_oauth_redirect')
    .split(',').map(x=>x.trim()).filter(Boolean);
  const allowedHosts=[...new Set([...(urlHost?[urlHost]:[]),'127.0.0.1','localhost'])];
  const oauthDb=resolve(env.ZANA_OAUTH_DB||join(dirname(statePath()),'oauth.sqlite'));
  return {port,bind:'127.0.0.1',publicUrl,origins,redirectUris,allowedHosts,oauthDb,
    password:env.ZANA_OAUTH_CONSENT_PASSWORD??''};
}

export function createHttpServer({runtime,oauth,settings,log=console,maxSessions=MAX_SESSIONS,
  idleMs=IDLE_MS,conversationIdleMs=CONVERSATION_IDLE_MS}){
  if(!Number.isInteger(maxSessions)||maxSessions<1)throw new Error('maxSessions must be an integer of at least 1');
  const sessions=new Map();
  const secrets=()=>envSecrets();
  function evictIdle(){
    const now=Date.now();
    for(const [id,s] of sessions)
      if(!s.inflight&&now-s.seen>(s.own?idleMs:conversationIdleMs)){sessions.delete(id);s.transport.close().catch(()=>{});}
  }
  // Una llamada en vuelo protege a su transporte: cerrarlo cortaría la respuesta
  // de una tool que igual termina en el servidor.
  async function serve(holder,res,respond){
    holder.inflight++;
    try{await sendWeb(res,await respond());}
    finally{holder.inflight--;holder.seen=Date.now();}
  }
  async function openSession(identity,request,parsed){
    evictIdle();
    // ChatGPT abre un transporte por llamada y no siempre lo cierra: con el tope
    // lleno se cierra el más viejo que no tenga una llamada en vuelo. La sesión
    // de ZanaLLaima no vive en el transporte, así que la conversación no pierde
    // nada. Solo si todos están ocupados se rechaza.
    while(sessions.size>=maxSessions){
      let oldest=null;
      for(const [id,s] of sessions)if(!s.inflight&&(!oldest||s.seen<oldest[1].seen))oldest=[id,s];
      if(!oldest)throw Object.assign(new Error('Too many open MCP sessions'),{status:503});
      sessions.delete(oldest[0]);oldest[1].transport.close().catch(()=>{});
    }
    const holder={identity,info:null,seen:Date.now(),transport:null,inflight:0,own:false};
    const transport=new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator:()=>randomUUID(),
      onsessioninitialized:async id=>{
        holder.info=await registerSession({sessionId:id,host:identity.host,clientId:identity.clientId});
        sessions.set(id,holder);
      },
      onsessionclosed:id=>{sessions.delete(id);},
    });
    holder.transport=transport;
    // La conversación de ChatGPT, si viene, manda sobre la sesión del transporte.
    const server=runtime.createServer(async ctx=>{
      const id=conversationSessionId(identity,ctx?.mcpReq?._meta);
      if(id)return {...await registerSession({sessionId:id,host:identity.host,clientId:identity.clientId}),source:'conversation'};
      if(!holder.info)throw new Error('transport session is not registered');
      holder.own=true;
      return {...holder.info,source:'transport'};
    });
    await server.connect(transport);
    return {holder,respond:()=>transport.handleRequest(request,{parsedBody:parsed})};
  }
  async function handleMcp(req,res,identity){
    const url='http://127.0.0.1'+req.url;
    const raw=req.method==='POST'?await readBody(req):null;
    const request=new Request(url,{method:req.method,headers:req.headers,
      ...(raw?{body:raw}:{})});
    let parsed;
    if(raw){
      try{parsed=JSON.parse(raw.toString('utf8'));}
      catch{return jsonRpcError(res,400,-32700,'Parse error');}
    }
    const sid=req.headers['mcp-session-id'];
    if(typeof sid==='string'&&sid){
      const s=sessions.get(sid);
      if(!s)return jsonRpcError(res,404,-32001,'Session not found');
      if(s.identity.host!==identity.host||s.identity.clientId!==identity.clientId)
        return jsonRpcError(res,403,-32002,'Session belongs to another identity');
      s.seen=Date.now();
      // Solo los POST cuentan como llamada en vuelo: un GET de streaming puede
      // quedar abierto horas y no debe fijar el transporte.
      if(req.method!=='POST')return sendWeb(res,await s.transport.handleRequest(request,{parsedBody:parsed}));
      return serve(s,res,()=>s.transport.handleRequest(request,{parsedBody:parsed}));
    }
    if(req.method==='POST'&&parsed&&!Array.isArray(parsed)&&isInitializeRequest(parsed)){
      const {holder,respond}=await openSession(identity,request,parsed);
      return serve(holder,res,respond);
    }
    const envelope=parsed&&!Array.isArray(parsed)&&parsed.params?._meta&&
      Object.keys(parsed.params._meta).some(k=>k.startsWith('io.modelcontextprotocol/'));
    if(envelope)return jsonRpcError(res,400,-32602,'Unsupported protocol version: this endpoint serves the sessionful 2025 Streamable HTTP transport; send initialize');
    return jsonRpcError(res,400,-32000,'Bad Request: no valid session; send initialize first');
  }
  const server=createServer(async(req,res)=>{
    try{
      const path=(req.url??'').split('?')[0];
      if(req.method==='GET'&&path==='/health'){
        const h=await runtime.health();
        // Through the tunnel only status, version and counts; the detail (error
        // text, paths, tokens configured) only on loopback without a proxy header.
        const peer=String(req.socket?.remoteAddress??'').replace(/^::ffff:/,'');
        const local=['127.0.0.1','::1'].includes(peer)&&!req.headers['cf-connecting-ip']&&
          ['127.0.0.1','localhost'].includes(hostname(req.headers.host));
        const body=local?{...h,name:'zana-llaima',version:packageVersion,mode:'remote',sessions:sessions.size}
          :{status:h.status,version:packageVersion,sessions:sessions.size,staleTickets:h.staleTickets};
        res.writeHead(h.status==='ok'?200:503,{'content-type':'application/json','cache-control':'no-store'});
        res.end(JSON.stringify(body));
        return;
      }
      const host=hostname(req.headers.host);
      if(!host||!settings.allowedHosts.includes(host)){res.writeHead(403);res.end('Host not allowed');return;}
      if(req.method==='GET'&&path==='/.well-known/zana-downstream-keys'){
        res.writeHead(200,{'content-type':'application/jwk-set+json','cache-control':'max-age=300'});
        res.end(JSON.stringify(runtime.actorKeys()));return;
      }
      if(path!=='/mcp'){
        if(await oauth.handle(req,res))return;
        res.writeHead(404);res.end('Not found');return;
      }
      if(req.headers.origin&&!settings.origins.includes(req.headers.origin)){res.writeHead(403);res.end('Origin not allowed');return;}
      let identity;
      try{identity=oauth.authenticate(req.headers.authorization);}catch{identity=null;}
      if(!identity){
        res.writeHead(401,{'www-authenticate':oauth.challenge(),'cache-control':'no-store'});res.end('Unauthorized');return;
      }
      res.setHeader('Cache-Control','no-store');
      await handleMcp(req,res,identity);
    }catch(error){
      log.error('MCP request failed:',clean(error,secrets()));
      if(!res.headersSent)res.writeHead(error?.status??500,{'content-type':'text/plain'});
      if(!res.writableEnded)res.end(error?.status===413?'Request body too large':'Internal error');
    }
  });
  server.sessions=sessions;
  return server;
}

export async function startRemote(env=process.env){
  const settings=httpSettings(env);
  if(!settings.publicUrl)throw new Error('ZANA_PUBLIC_HOST (or ZANA_PUBLIC_MCP_URL) must be set to the public hostname of the tunnel');
  if(!String(env.ZANA_REVIEWER_LOGIN??'').trim())throw new Error('ZANA_REVIEWER_LOGIN must be set to the GitHub login of the reviewer account');
  for(const name of ['ZANA_STATE_FILE','ZANA_OAUTH_DB'])
    if(!(env[name]??process.env[name])||!isAbsolute(env[name]??process.env[name]))
      throw new Error(name+' must be set to an absolute path (systemd does not expand ~)');
  await ensureSchema();
  const oauth=new EmbeddedOAuth({path:settings.oauthDb,resource:settings.publicUrl,
    redirectUris:settings.redirectUris,password:settings.password});
  const runtime=createRemoteRuntime({env});
  const server=createHttpServer({runtime,oauth,settings});
  runtime.gateway.refresh().catch(error=>console.error('GitHub downstream:',clean(error,envSecrets(env))));
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(settings.port,settings.bind,ok);});
  settings.port=server.address().port;
  console.error('ZanaLLaima remote MCP ready on '+settings.bind+':'+settings.port+'/mcp ('+settings.publicUrl+')');
  return {server,runtime,oauth,settings};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  startRemote().catch(error=>{
    console.error('ZanaLLaima remote startup failed:',clean(error,envSecrets()));
    process.exitCode=1;
  });
}
