// Self-hosted OAuth 2.1 authorization server for the remote MCP with CLOSED
// registration: dynamic client registration, authorization and consent are
// accepted only while the operator keeps an enrollment window open
// (`node src/cli.mjs remote-enroll <minutes>` on the server) AND the operator
// password is typed on the consent page. Outside the window nobody new gets
// in; already approved connections keep working and refreshing. Each approved
// connection is bound to a host label the operator chooses; its tokens
// identify that host.
//
// Copied and adapted from riquelmechile/panter-ai@1a99048
// src/core/embedded-oauth.ts (PKCE S256, one-time codes, rotating refresh
// tokens with replay-family revocation, RFC 9207 iss, rate limits, CSRF
// cookie, fixed operator-safe error messages; src/core/oauth.ts is not needed
// because there is no external IdP). Panter's host roster, leader scope and
// Gemini relay are
// replaced by a single operator-chosen host label and the enrollment window.
// Storage: a separate SQLite ledger (not the mission database, so mission
// restores never roll credentials back).
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {isIP} from 'node:net';

const MAX_BODY=12_288,ACCESS_TTL=3600,REFRESH_TTL=90*86400,CODE_TTL=300,PENDING_TTL=600;
export const MAX_ENROLL_MINUTES=60;
const ALLOWED_SCOPES=new Set(['mcp','offline_access']);
const HOST_LABEL=/^[a-z][a-z0-9-]{1,31}$/;
const secureId=(bytes=32)=>randomBytes(bytes).toString('base64url');
const hash=s=>createHash('sha256').update(s).digest('hex');
const ts=()=>Math.floor(Date.now()/1000);
class OAuthCheckError extends Error{}
function check(ok,why){if(!ok)throw new OAuthCheckError(why);}
const eq=(a,b)=>timingSafeEqual(Buffer.from(hash(a),'hex'),Buffer.from(hash(b),'hex'));
const validString=(v,max=256)=>typeof v==='string'&&v.length>0&&v.length<=max;
const escapeHtml=s=>s.replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
const empty=()=>({version:1,clients:[],pending:[],grants:[],codes:[],tokens:[],enrollment:{openUntil:0}});

function basicClient(req){
  const h=req.headers.authorization;
  if(!h?.startsWith('Basic '))return {id:'',secret:''};
  try{
    const raw=Buffer.from(h.slice(6).trim(),'base64').toString('utf8'),i=raw.indexOf(':');
    if(i<1)return {id:'',secret:''};
    return {id:decodeURIComponent(raw.slice(0,i).replace(/\+/g,' ')),secret:decodeURIComponent(raw.slice(i+1).replace(/\+/g,' '))};
  }catch{return {id:'',secret:''};}
}
function logReject(stage,err){
  const reason=err instanceof OAuthCheckError?err.message:err instanceof Error?'unexpected '+err.name:'unknown';
  console.warn('[oauth] '+stage+' rejected: '+reason);
}
function reply(res,status,data,headers={}){
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff',...headers});
  res.end(JSON.stringify(data));
}
function redirect(res,location){res.writeHead(302,{location,'cache-control':'no-store','referrer-policy':'no-referrer'});res.end();}
async function body(req){
  const parts=[];let size=0;
  for await(const part of req){
    const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);
    size+=chunk.length;check(size<=MAX_BODY,'Request body too large');parts.push(chunk);
  }
  const raw=Buffer.concat(parts).toString('utf8');
  const type=String(req.headers['content-type']??'').split(';')[0].trim();
  if(type==='application/json'){
    let parsed;
    try{parsed=JSON.parse(raw);}catch{throw new OAuthCheckError('Malformed JSON body');}
    check(parsed!==null&&typeof parsed==='object'&&!Array.isArray(parsed),'Invalid JSON');
    return parsed;
  }
  check(type==='application/x-www-form-urlencoded','Unsupported Content-Type');
  const parsed=new URLSearchParams(raw);
  for(const key of new Set(parsed.keys()))check(parsed.getAll(key).length===1,'Duplicate form field');
  return parsed;
}
const field=(input,name)=>{const v=input instanceof URLSearchParams?input.get(name):input[name];return typeof v==='string'?v:'';};
function validateResource(value){
  const url=new URL(value);
  check(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/mcp','Invalid public MCP resource');
  return url.toString();
}
function validateRedirect(value){
  const u=new URL(value);
  check(u.protocol==='https:'&&!u.username&&!u.password&&!u.hash,'Invalid redirect URI');
  return u.toString();
}
const params=raw=>new URL(raw,'http://internal').searchParams;
function cookie(req,name){
  const part=String(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='));
  return part?.slice(name.length+1)??'';
}
function queryRedirect(uri,values){
  const url=new URL(uri);
  for(const [k,v] of Object.entries(values))url.searchParams.set(k,v);
  return url.toString();
}
// Client address for rate limits. cloudflared connects from loopback; only
// then is its CF-Connecting-IP header trusted.
export function clientIdentity(req){
  const peer=String(req.socket?.remoteAddress??'').replace(/^::ffff:/,'');
  const forwarded=req.headers?.['cf-connecting-ip'];
  if((peer==='127.0.0.1'||peer==='::1')&&typeof forwarded==='string'&&isIP(forwarded))return forwarded;
  return peer||'unknown';
}

// Single-row JSON ledger in its own SQLite file.
class Ledger{
  constructor(path){
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000; CREATE TABLE IF NOT EXISTS ledger (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  read(){
    const row=this.db.prepare("SELECT value FROM ledger WHERE key='oauth'").get();
    const value=row?JSON.parse(row.value):empty();
    value.enrollment??={openUntil:0};
    return value;
  }
  mutate(fn){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const value=this.read();
      const result=fn(value);
      this.db.prepare("INSERT INTO ledger(key,value) VALUES('oauth',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));
      this.db.exec('COMMIT');
      return result;
    }catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}
  }
  close(){this.db.close();}
}

// Operator-only (CLI on the server): open or close the enrollment window.
export function setEnrollment(path,minutes){
  check(Number.isInteger(minutes)&&minutes>=0&&minutes<=MAX_ENROLL_MINUTES,'Minutes must be 0-'+MAX_ENROLL_MINUTES);
  const ledger=new Ledger(path);
  try{
    const openUntil=minutes?ts()+minutes*60:0;
    ledger.mutate(d=>{d.enrollment={openUntil};if(!minutes)d.pending=[];});
    return {enrollmentOpen:minutes>0,openUntil:openUntil?new Date(openUntil*1000).toISOString():null};
  }finally{ledger.close();}
}
export function listClients(path){
  const ledger=new Ledger(path);
  try{
    const d=ledger.read();
    return {enrollmentOpen:d.enrollment.openUntil>ts(),
      clients:d.clients.map(c=>{const g=d.grants.filter(x=>x.clientId===c.id);
        return {clientId:c.id,name:c.name,createdAt:new Date(c.createdAt*1000).toISOString(),
          hosts:[...new Set(g.filter(x=>!x.revoked).map(x=>x.host))],revoked:g.length>0&&g.every(x=>x.revoked)};})};
  }finally{ledger.close();}
}
export function revokeClient(path,clientId){
  check(/^zc_[A-Za-z0-9_-]{24,64}$/.test(clientId),'Invalid client identifier');
  const ledger=new Ledger(path);
  try{
    return {revoked:ledger.mutate(d=>{
      const grants=d.grants.filter(g=>g.clientId===clientId);
      for(const g of grants)g.revoked=true;
      for(const t of d.tokens)if(t.clientId===clientId)t.revoked=true;
      d.codes=d.codes.filter(c=>c.clientId!==clientId);
      d.pending=d.pending.filter(p=>p.clientId!==clientId);
      return grants.length;
    })};
  }finally{ledger.close();}
}

export class EmbeddedOAuth{
  constructor({path,resource,redirectUris,password,identity=clientIdentity}){
    this.resource=validateResource(resource);
    this.issuer=new URL(this.resource).origin;
    check(validString(password,512)&&password.length>=32,'ZANA_OAUTH_CONSENT_PASSWORD must be at least 32 characters');
    this.password=password;
    check(Array.isArray(redirectUris)&&redirectUris.length>0&&redirectUris.length<=30,'Configure approved OAuth redirect URIs');
    this.callbacks=new Set(redirectUris.map(validateRedirect));
    this.identity=identity;
    this.ledger=new Ledger(path);
    this.rate=new Map();
    this.cookieName='__Host-zana-consent';
  }
  close(){this.ledger.close();}
  read(fn){return structuredClone(fn(this.ledger.read()));}
  change(fn){return this.ledger.mutate(fn);}
  enrollmentOpen(d){return (d.enrollment?.openUntil??0)>ts();}
  protectedResourceMetadata(){
    return {resource:this.resource,authorization_servers:[this.issuer],bearer_methods_supported:['header'],scopes_supported:[...ALLOWED_SCOPES]};
  }
  authorizationServerMetadata(){
    return {issuer:this.issuer,authorization_response_iss_parameter_supported:true,
      authorization_endpoint:this.issuer+'/authorize',token_endpoint:this.issuer+'/token',
      registration_endpoint:this.issuer+'/register',revocation_endpoint:this.issuer+'/revoke',
      response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],
      token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256'],scopes_supported:[...ALLOWED_SCOPES]};
  }
  challenge(){return 'Bearer realm="zana-llaima", resource_metadata="'+this.issuer+'/.well-known/oauth-protected-resource", scope="mcp"';}
  // -> {host, clientId}; throws on any invalid, expired or revoked token.
  authenticate(authHeader){
    const raw=authHeader?.startsWith('Bearer ')?authHeader.slice(7):'';
    check(/^[\w-]{32,150}$/.test(raw),'Invalid token');
    return this.read(d=>{
      const found=d.tokens.find(t=>t.digest===hash(raw)&&t.kind==='access'&&!t.revoked&&t.expiresAt>ts()&&t.resource===this.resource);
      check(found&&found.scopes.includes('mcp'),'Invalid token');
      check(d.grants.some(g=>g.clientId===found.clientId&&g.host===found.host&&!g.revoked),'Revoked connection');
      return {host:found.host,clientId:found.clientId};
    });
  }
  throttled(key,limit=10){
    const now=ts(),row=this.rate.get(key);
    if(!row||now-row.since>3600){
      if(this.rate.size>=4096){
        for(const [name,item] of this.rate)if(now-item.since>3600)this.rate.delete(name);
        check(this.rate.size<4096,'Rate limiter saturated; retry later');
      }
      this.rate.set(key,{count:1,since:now});return;
    }
    check(row.count<limit,'Rate limited');row.count++;
  }
  register(input){
    check(!(input instanceof URLSearchParams),'JSON registration required');
    check(Array.isArray(input.redirect_uris)&&input.redirect_uris.length>0&&input.redirect_uris.length<=10,'Redirect URIs required');
    const redirectUris=input.redirect_uris.map(x=>validateRedirect(String(x)));
    check(redirectUris.every(u=>this.callbacks.has(u)),'Unapproved redirect URI');
    check((input.token_endpoint_auth_method??'none')==='none','Only public PKCE clients are supported');
    check(input.grant_types===undefined||(Array.isArray(input.grant_types)&&input.grant_types.every(x=>x==='authorization_code'||x==='refresh_token')&&input.grant_types.includes('authorization_code')),'Unsupported grants');
    check(input.response_types===undefined||(Array.isArray(input.response_types)&&input.response_types.length===1&&input.response_types[0]==='code'),'Unsupported response type');
    const name=typeof input.client_name==='string'?input.client_name.slice(0,120):'MCP client';
    return this.change(d=>{
      check(this.enrollmentOpen(d),'Enrollment closed');
      d.clients=d.clients.filter(c=>c.createdAt>ts()-86400||d.grants.some(g=>g.clientId===c.id));
      check(d.clients.length<50,'Registration capacity reached');
      const client={id:'zc_'+secureId(24),name,redirectUris,createdAt:ts()};
      d.clients.push(client);
      return {client_id:client.id,client_name:client.name,redirect_uris:client.redirectUris,token_endpoint_auth_method:'none',
        grant_types:['authorization_code','refresh_token'],response_types:['code'],client_id_issued_at:client.createdAt};
    });
  }
  authorize(query,source){
    const clientId=query.get('client_id')??'',redirectUri=query.get('redirect_uri')??'';
    const challenge=query.get('code_challenge')??'',state=query.get('state')??'';
    const resource=query.get('resource')??this.resource;
    const scopes=[...new Set((query.get('scope')??'mcp').split(' ').filter(Boolean))];
    check(query.get('response_type')==='code','Authorization code only');
    check(resource===this.resource,'Invalid resource audience');
    check(query.get('code_challenge_method')==='S256'&&/^[A-Za-z0-9_-]{43}$/.test(challenge),'PKCE S256 is required');
    check(state.length<=2048&&scopes.length>0&&scopes.every(s=>ALLOWED_SCOPES.has(s)),'Invalid scopes/state');
    const id=secureId(28),csrf=secureId(32),sourceDigest=hash(source);
    this.change(d=>{
      check(this.enrollmentOpen(d),'Enrollment closed');
      const client=d.clients.find(c=>c.id===clientId);
      check(client&&client.redirectUris.includes(redirectUri),'Unknown client or redirect URI');
      d.pending=d.pending.filter(p=>p.expiresAt>ts());
      check(d.pending.filter(p=>p.sourceDigest===sourceDigest).length<5,'Pending consent quota for this source');
      check(d.pending.filter(p=>p.clientId===clientId).length<5,'Pending consent quota for this client');
      check(d.pending.length<50,'Too many pending authorizations');
      d.pending.push({id,clientId,redirectUri,challenge,state,requestedScopes:scopes,csrfDigest:hash(csrf),
        expiresAt:ts()+PENDING_TTL,failures:0,sourceDigest});
    });
    return {id,csrf};
  }
  consent(id){
    return this.read(d=>{
      check(this.enrollmentOpen(d),'Enrollment closed');
      const pending=d.pending.find(x=>x.id===id&&x.expiresAt>ts());
      check(pending,'Consent expired');
      const client=d.clients.find(x=>x.id===pending.clientId);
      check(client,'Client unavailable');
      return {pending,client};
    });
  }
  approve(id,csrf,password,host,decision){
    const result=this.change(d=>{
      check(this.enrollmentOpen(d),'Enrollment closed');
      const p=d.pending.find(x=>x.id===id&&x.expiresAt>ts());
      check(p,'Consent expired');
      check(p.failures<6,'Consent locked');
      if(!eq(hash(csrf),p.csrfDigest)){p.failures++;return {denied:true};}
      if(decision==='allow'&&!eq(password,this.password)){p.failures++;return {denied:true};}
      d.pending=d.pending.filter(x=>x.id!==id);
      if(decision==='deny')return {uri:queryRedirect(p.redirectUri,{error:'access_denied',state:p.state,iss:this.issuer})};
      check(decision==='allow'&&HOST_LABEL.test(host),'Choose a host label');
      const existing=d.grants.find(g=>g.clientId===p.clientId&&!g.revoked);
      check(!existing||existing.host===host,'Client cannot switch host without revocation');
      const scopes=[...new Set([...p.requestedScopes,'mcp','offline_access'])];
      if(!existing)d.grants.push({clientId:p.clientId,host,redirectUri:p.redirectUri,scopes,approvedAt:ts(),revoked:false});
      const code=secureId(32);
      d.codes.push({digest:hash(code),clientId:p.clientId,host,redirectUri:p.redirectUri,challenge:p.challenge,scopes,
        expiresAt:ts()+CODE_TTL,consumed:false});
      return {uri:queryRedirect(p.redirectUri,{code,state:p.state,iss:this.issuer})};
    });
    check(typeof result.uri==='string','Approval denied');
    return result.uri;
  }
  issue(d,clientId,host,scopes,family=randomUUID()){
    const now=ts();
    d.codes=d.codes.filter(c=>c.expiresAt>now-86400);
    d.tokens=d.tokens.filter(t=>t.expiresAt>now-86400);
    const access=secureId(32),refresh=scopes.includes('offline_access')?secureId(48):'';
    d.tokens.push({digest:hash(access),familyId:family,clientId,host,scopes,kind:'access',expiresAt:now+ACCESS_TTL,revoked:false,resource:this.resource});
    if(refresh)d.tokens.push({digest:hash(refresh),familyId:family,clientId,host,scopes,kind:'refresh',expiresAt:now+REFRESH_TTL,revoked:false,resource:this.resource});
    return {access_token:access,token_type:'Bearer',expires_in:ACCESS_TTL,scope:scopes.join(' '),...(refresh?{refresh_token:refresh}:{})};
  }
  exchange(input,basic={id:'',secret:''}){
    const grant=field(input,'grant_type'),bodyId=field(input,'client_id');
    check(!(basic.id&&bodyId&&basic.id!==bodyId),'Conflicting client credentials');
    const clientId=basic.id||bodyId;
    check(validString(clientId),'client_id required');
    if(grant==='authorization_code'){
      const code=field(input,'code'),verifier=field(input,'code_verifier'),redirectUri=field(input,'redirect_uri');
      check(/^[A-Za-z0-9_-]{43,128}$/.test(verifier),'Invalid PKCE verifier');
      check(field(input,'resource')===''||field(input,'resource')===this.resource,'Wrong resource audience');
      return this.change(d=>{
        const record=d.codes.find(c=>c.digest===hash(code)&&c.clientId===clientId&&!c.consumed&&c.expiresAt>ts());
        check(record&&record.redirectUri===redirectUri,'Invalid or reused authorization code');
        check(eq(record.challenge,createHash('sha256').update(verifier).digest('base64url')),'PKCE verification failed');
        check(d.grants.some(g=>g.clientId===clientId&&g.host===record.host&&!g.revoked),'Connection revoked');
        record.consumed=true;
        return this.issue(d,clientId,record.host,record.scopes);
      });
    }
    if(grant==='refresh_token'){
      const refresh=field(input,'refresh_token');
      check(refresh.length>=32,'Missing refresh token');
      return this.change(d=>{
        const token=d.tokens.find(t=>t.digest===hash(refresh)&&t.clientId===clientId&&t.kind==='refresh');
        check(token,'Invalid refresh token');
        if(token.revoked){
          for(const row of d.tokens)if(row.familyId===token.familyId)row.revoked=true;
          return {error:'invalid_grant'};
        }
        check(token.expiresAt>ts(),'Expired refresh token');
        check(d.grants.some(g=>g.clientId===clientId&&g.host===token.host&&!g.revoked),'Connection revoked');
        const requested=field(input,'scope').split(' ').filter(Boolean);
        check(requested.every(s=>token.scopes.includes(s)),'Scope escalation denied');
        token.revoked=true;
        return this.issue(d,clientId,token.host,requested.length?requested:token.scopes,token.familyId);
      });
    }
    throw new OAuthCheckError('Unsupported grant_type');
  }
  consentPage(res,id,pending,client,csrf){
    const origin=new URL(pending.redirectUri).origin;
    const age=Math.max(0,Math.floor((ts()-client.createdAt)/60));
    const html='<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ZanaLLaima · Autorizar conexión</title><style>body{font:16px system-ui;max-width:460px;margin:8vh auto;padding:20px;background:#111827;color:white}main{background:#1f2937;border-radius:12px;padding:24px}input,button{display:block;width:100%;padding:10px;margin:12px 0;box-sizing:border-box}.warning{border:1px solid #f4b400;padding:12px}</style><main><h2>Autorizar conexión a ZanaLLaima</h2><p class="warning"><strong>Cliente NO VERIFICADO.</strong> Confirma solo si tú abriste esta conexión desde tu app de ChatGPT durante la ventana de alta. Si no, pulsa Denegar.</p><p>Nombre declarado (no verificado): '+escapeHtml(client.name)+'</p><p>Registro: '+escapeHtml(client.id)+', hace '+age+' minutos</p><p>Redirección: '+escapeHtml(pending.redirectUri)+'</p><form method="post" action="/oauth/consent?sid='+encodeURIComponent(id)+'"><input type="hidden" name="csrf" value="'+escapeHtml(csrf)+'"><label>Etiqueta del host<input name="host" required pattern="[a-z][a-z0-9-]{1,31}" value="zana-chatgpt"></label><label>Clave del operador<input name="password" type="password" required autocomplete="off"></label><button name="decision" value="allow">Autorizar</button><button name="decision" value="deny">Denegar</button></form></main></html>';
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer',
      'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self' "+origin+"; base-uri 'none'; frame-ancestors 'none'"});
    res.end(html);
  }
  async handle(req,res){
    const path=(req.url??'').split('?')[0]??'';
    const who=this.identity(req);
    if(req.method==='GET'&&(path==='/.well-known/oauth-protected-resource'||path==='/.well-known/oauth-protected-resource/mcp')){
      reply(res,200,this.protectedResourceMetadata());return true;
    }
    if(req.method==='GET'&&path==='/.well-known/oauth-authorization-server'){reply(res,200,this.authorizationServerMetadata());return true;}
    if(req.method==='POST'&&path==='/register'){
      try{this.throttled('register:'+who,20);reply(res,201,this.register(await body(req)));}
      catch(err){logReject('register',err);reply(res,400,{error:'invalid_client_metadata',error_description:err instanceof OAuthCheckError?err.message:'Invalid request'});}
      return true;
    }
    if(req.method==='GET'&&path==='/authorize'){
      try{
        this.throttled('authorize:'+who,60);
        const {id,csrf}=this.authorize(params(req.url??''),who);
        res.setHeader('Set-Cookie',this.cookieName+'='+csrf+'; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600');
        redirect(res,'/oauth/consent?sid='+encodeURIComponent(id));
      }catch(err){logReject('authorize',err);reply(res,400,{error:'invalid_request'});}
      return true;
    }
    if(path==='/oauth/consent'&&req.method==='GET'){
      try{
        const id=params(req.url??'').get('sid')??'';
        const {pending,client}=this.consent(id);
        const csrf=cookie(req,this.cookieName);
        check(csrf.length>30&&eq(hash(csrf),pending.csrfDigest),'Invalid consent session');
        check(this.callbacks.has(pending.redirectUri)&&client.redirectUris.includes(pending.redirectUri),'Unapproved consent redirect');
        this.consentPage(res,id,pending,client,csrf);
      }catch(err){logReject('consent-page',err);reply(res,400,{error:'invalid_request'});}
      return true;
    }
    if(path==='/oauth/consent'&&req.method==='POST'){
      try{
        const origin=String(req.headers.origin??'');
        check(origin===this.issuer||((origin===''||origin==='null')&&req.headers['sec-fetch-site']==='same-origin'),'Invalid Origin');
        this.throttled('consent-ip:'+who,60);
        const id=params(req.url??'').get('sid')??'';
        check(/^[A-Za-z0-9_-]{38}$/.test(id),'Invalid consent session ID');
        this.consent(id);
        this.throttled('consent:'+id,6);
        const payload=await body(req);
        const uri=this.approve(id,field(payload,'csrf'),field(payload,'password'),field(payload,'host'),field(payload,'decision'));
        res.setHeader('Set-Cookie',this.cookieName+'=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
        redirect(res,uri);
      }catch(err){logReject('consent-submit',err);reply(res,403,{error:'access_denied'});}
      return true;
    }
    if(path==='/token'&&req.method==='POST'){
      try{
        this.throttled('token:'+who,100);
        const result=this.exchange(await body(req),basicClient(req));
        reply(res,'error' in result?400:200,result);
      }catch(err){logReject('token',err);reply(res,400,{error:'invalid_grant'});}
      return true;
    }
    if(path==='/revoke'&&req.method==='POST'){
      try{
        this.throttled('revoke:'+who,100);
        const input=await body(req),basic=basicClient(req),bodyId=field(input,'client_id');
        check(!(basic.id&&bodyId&&basic.id!==bodyId),'Conflicting client credentials');
        const clientId=basic.id||bodyId,token=field(input,'token');
        check(/^zc_[A-Za-z0-9_-]{24,64}$/.test(clientId)&&token.length>=32&&token.length<=200,'Invalid revocation request');
        const digest=hash(token);
        this.change(d=>{
          const found=d.tokens.find(t=>t.digest===digest&&t.clientId===clientId&&!t.revoked);
          if(found)for(const row of d.tokens)if(row.familyId===found.familyId)row.revoked=true;
        });
        reply(res,200,{});
      }catch(err){logReject('revoke',err);reply(res,400,{error:'invalid_request'});}
      return true;
    }
    return false;
  }
}

