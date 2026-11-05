// Downstream MCP gateway: another MCP server (the official GitHub MCP) mounted
// behind ZanaLLaima. ZanaLLaima is the only client that holds its token,
// caches its tools, classifies every call from the downstream tool's own
// annotations (MCP defaults: destructive unless it says otherwise), gates it
// (writes: deny|grant|allow plus a policy hook), forwards it with a timeout
// and a circuit breaker, audits it with a keyed hash of the arguments and
// attaches a signed actor assertion.
//
// Copied and adapted from riquelmechile/panter-ai@1a99048
// src/core/downstream.ts and docs/DOWNSTREAM_MCP.md. Kept: contract, classes,
// writes policy, refresh before stale calls (fail closed), timeout, circuit
// breaker, bounded responses without redirects, redaction, audit and actor
// assertion. Dropped: OAuth client credentials, sensitive servers and
// per-host operator grants; in ZanaLLaima "grant" means the policy hook
// (src/github-policy.mjs) must authorize each non-read call.
import {Client,StreamableHTTPClientTransport,SdkError,SdkErrorCode,ProtocolError} from '@modelcontextprotocol/client';
import {randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {ACTOR_ISSUER,ACTOR_TTL_SECONDS,argsDigest} from './actor-assertion.mjs';
import {clean,redactDeep} from './redact.mjs';

export const WRITE_POLICIES=Object.freeze(['deny','grant','allow']);
const MAX_TOOLS=300,MAX_RESULT_BYTES=2_000_000,MAX_RESPONSE_BYTES=4_000_000,MAX_SCHEMA_BYTES=64_000;
const FAILURES_TO_OPEN=3,OPEN_MS=30_000,FRESH_MS=60_000,REFRESH_RETRY_MS=10_000;
const iso=(ms=Date.now())=>new Date(ms).toISOString();
class SafeError extends Error{}

// MCP tool annotations: read-only only when it says so; otherwise destructive
// unless it says it is not.
export function classify(annotations){
  if(annotations?.readOnlyHint===true)return 'read';
  return annotations?.destructiveHint===false?'write':'destructive';
}

// https anywhere; plain http only to localhost or a literal private address.
export function allowedUrl(raw){
  let u;
  try{u=new URL(raw);}catch{return false;}
  if(u.username||u.password||u.hash||u.search)return false;
  if(u.protocol==='https:')return true;
  if(u.protocol!=='http:')return false;
  const h=u.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(h==='localhost')return true;
  if(isIP(h)===4){
    const [a,b]=h.split('.').map(Number);
    return a===127||a===10||(a===192&&b===168)||(a===172&&b>=16&&b<=31);
  }
  if(isIP(h)===6)return h==='::1'||/^f[cd][0-9a-f]{2}:/.test(h);
  return false;
}

const callIdOf=body=>{
  if(typeof body!=='string')return null;
  try{const id=JSON.parse(body)?.params?._meta?.['zana-llaima/callId'];return typeof id==='string'?id:null;}
  catch{return null;}
};
// fetch that refuses redirects and stops reading past MAX_RESPONSE_BYTES.
const limitedFetch=(cut,fetcher)=>async(url,init)=>{
  const callId=callIdOf(init?.body);
  const res=await fetcher(url,{...init,redirect:'error'});
  if(!res.body)return res;
  let seen=0;
  const cap=new TransformStream({transform(chunk,ctl){
    seen+=chunk.byteLength;
    if(seen>MAX_RESPONSE_BYTES){cut(callId);ctl.error(new Error('response larger than '+MAX_RESPONSE_BYTES+' bytes'));}
    else ctl.enqueue(chunk);
  }});
  return new Response(res.body.pipeThrough(cap),{status:res.status,statusText:res.statusText,headers:res.headers});
};

export function parseDownstreamConfig(input){
  const where='Downstream config '+(input?.name??'?');
  if(!input||typeof input!=='object')throw new Error('Downstream config: not an object');
  if(typeof input.name!=='string'||!/^[a-z][a-z0-9]{1,23}$/.test(input.name))
    throw new Error(where+': name must be 2-24 lowercase letters or digits');
  if(typeof input.url!=='string'||!allowedUrl(input.url))
    throw new Error(where+': url must be https, or http to localhost or a private address');
  const writes=input.writes??'grant';
  if(!WRITE_POLICIES.includes(writes))throw new Error(where+': writes must be deny, grant or allow');
  const timeoutMs=input.timeoutMs??30_000;
  if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>300_000)throw new Error(where+': timeoutMs must be 1000-300000');
  const headers=input.headers??{};
  for(const [k,v] of Object.entries(headers))
    if(!/^x-[a-z0-9-]{1,60}$/i.test(k)||typeof v!=='string'||v.length>500||/[\r\n]/.test(v))
      throw new Error(where+': invalid extra header '+k);
  return {name:input.name,url:input.url,token:input.token??null,writes,timeoutMs,headers,
    description:String(input.description??'').slice(0,300)};
}

export const routerFor=name=>'zana_ds_'+name;

export class DownstreamGateway{
  // policy({caller,tool,args,cls,missionId}) -> {allowed:true,detail?} | {allowed:false,reason}
  // audit(entry) persists one metadata-only record (argument hash, no content).
  constructor(config,{policy,audit,signer,fetcher=globalThis.fetch,now=Date.now}={}){
    this.config=parseDownstreamConfig(config);
    this.policy=policy??(async()=>({allowed:true}));
    this.audit=audit??(async()=>{});
    this.signer=signer??null;
    this.fetcher=fetcher;
    this.now=now;
    this.s={tools:[],fetchedAt:null,fetchedMs:0,failures:0,openUntil:0,lastError:null,client:null,
      refreshing:null,refreshFailedMs:0,refreshError:null,cutCalls:new Set(),activeCalls:new Set()};
    this.failedConnections=new WeakSet();
  }
  get name(){return this.config.name;}
  secrets(){return this.config.token?['Bearer '+this.config.token,this.config.token]:[];}
  describe(error){return error instanceof SafeError?error.message:clean(error,this.secrets());}
  connect(){
    const s=this.s;
    if(s.client)return s.client;
    if(!this.config.token)return Promise.reject(new SafeError(this.config.name+': token is not set on the server'));
    const attempt=(async()=>{
      const client=new Client({name:'zana-llaima-gateway',version:'1.0.0'});
      const limited=limitedFetch(id=>{if(id&&s.activeCalls.has(id))s.cutCalls.add(id);},this.fetcher);
      const transport=new StreamableHTTPClientTransport(new URL(this.config.url),{fetch:limited,
        requestInit:{headers:{authorization:'Bearer '+this.config.token,...this.config.headers}}});
      let timer;
      try{
        await Promise.race([client.connect(transport),new Promise((_,no)=>{
          timer=setTimeout(()=>no(new Error('connect timed out')),this.config.timeoutMs);})]);
      }catch(error){await client.close().catch(()=>{});throw error;}
      finally{clearTimeout(timer);}
      return client;
    })();
    s.client=attempt;
    attempt.catch(()=>{if(s.client===attempt)s.client=null;});
    return attempt;
  }
  drop(which){
    if(!which||this.s.client!==which)return;
    this.s.client=null;
    which.then(x=>x.close()).catch(()=>{});
  }
  async guarded(op){
    const s=this.s;
    if(this.now()<s.openUntil)
      throw new SafeError('circuit open until '+iso(s.openUntil)+' after '+s.failures+' failures: '+(s.lastError??''));
    const used=this.connect(),callId=randomUUID();
    s.activeCalls.add(callId);
    try{
      const result=await op(await used,callId);
      s.failures=0;s.lastError=null;s.openUntil=0;
      return result;
    }catch(error){
      if(s.cutCalls.delete(callId))throw new SafeError('response larger than '+MAX_RESPONSE_BYTES+' bytes');
      const message=this.describe(error);
      if(error instanceof ProtocolError||error instanceof SafeError)throw new SafeError(message);
      const timeout=error instanceof SdkError&&error.code===SdkErrorCode.RequestTimeout;
      if(timeout||!this.failedConnections.has(used)){
        if(!timeout)this.failedConnections.add(used);
        s.failures++;s.lastError=message;
        if(s.failures>=FAILURES_TO_OPEN)s.openUntil=this.now()+OPEN_MS;
      }
      if(!timeout)this.drop(used);
      throw new SafeError(message);
    }finally{s.activeCalls.delete(callId);s.cutCalls.delete(callId);}
  }
  async refresh(){
    const s=this.s;
    if(s.refreshing)return s.refreshing;
    s.refreshing=this.fetchTools()
      .then(r=>{s.refreshFailedMs=0;s.refreshError=null;return r;},
        e=>{s.refreshFailedMs=this.now();s.refreshError=this.describe(e);throw e;})
      .finally(()=>{s.refreshing=null;});
    return s.refreshing;
  }
  async fetchTools(){
    const tools=await this.guarded(async(c,callId)=>{
      const out=[];
      let cursor;
      for(let page=0;page<20;page++){
        const r=await c.listTools({...(cursor?{cursor}:{}),_meta:{'zana-llaima/callId':callId}},{timeout:this.config.timeoutMs});
        for(const t of r.tools){
          if(out.length>=MAX_TOOLS)break;
          if(typeof t.name!=='string'||!/^[A-Za-z0-9_.-]{1,64}$/.test(t.name))continue;
          const schema=t.inputSchema??{type:'object'};
          out.push({name:t.name,description:String(t.description??'').slice(0,2000),
            inputSchema:Buffer.byteLength(JSON.stringify(schema))>MAX_SCHEMA_BYTES?
              {type:'object',description:'schema too large to show'}:schema,
            annotations:{readOnlyHint:t.annotations?.readOnlyHint===true,
              destructiveHint:typeof t.annotations?.destructiveHint==='boolean'?t.annotations.destructiveHint:null},
            cls:classify(t.annotations)});
        }
        cursor=r.nextCursor;
        if(!cursor||out.length>=MAX_TOOLS)break;
      }
      return out;
    });
    this.s.tools=tools;this.s.fetchedAt=iso(this.now());this.s.fetchedMs=this.now();
    return {server:this.config.name,tools:tools.length};
  }
  tools(){return this.s.tools;}
  // Fresh tool list or a fail-closed error.
  async ensureFresh(){
    const s=this.s;
    if(s.fetchedAt&&this.now()-s.fetchedMs<=FRESH_MS)return;
    if(s.refreshFailedMs&&this.now()-s.refreshFailedMs<REFRESH_RETRY_MS)
      throw new SafeError(this.config.name+': could not read its tool list: '+(s.refreshError??''));
    try{await this.refresh();}
    catch(error){throw new SafeError(this.config.name+': could not read its tool list: '+this.describe(error));}
  }
  status(){
    const s=this.s,t=this.now();
    return {server:this.config.name,url:this.config.url,writes:this.config.writes,timeoutMs:this.config.timeoutMs,
      state:!this.config.token?'TOKEN_MISSING':t<s.openUntil?'CIRCUIT_OPEN':s.lastError?'DEGRADED':s.fetchedAt?'OK':'NOT_CONTACTED',
      tools:s.tools.length,byClass:{read:s.tools.filter(x=>x.cls==='read').length,
        write:s.tools.filter(x=>x.cls==='write').length,destructive:s.tools.filter(x=>x.cls==='destructive').length},
      fetchedAt:s.fetchedAt,failures:s.failures,openUntil:t<s.openUntil?iso(s.openUntil):null,lastError:s.lastError,
      router:routerFor(this.config.name)};
  }
  // Forward one tool call. Refusals and failures are audited and come back as
  // tool errors, never thrown.
  async call(caller,tool,args={},{missionId=null}={}){
    const started=this.now();
    let cls='destructive',policyDetail=null;
    const finish=(outcome,error)=>this.audit({tool:this.config.name+'.'+tool,cls,outcome,args,
      missionId,caller,error,ms:this.now()-started,detail:policyDetail});
    const fail=text=>({isError:true,content:[{type:'text',text}]});
    const refuse=async message=>{await finish('REFUSED',message);return fail(message);};
    try{await this.ensureFresh();}
    catch(error){const m=this.describe(error);await finish('FAILED',m);return fail(m);}
    const known=this.s.tools.find(t=>t.name===tool);
    if(!known)return refuse('Unknown tool "'+tool+'" on '+this.config.name+'; call operation "index"');
    cls=known.cls;
    if(cls!=='read'&&this.config.writes==='deny')
      return refuse(this.config.name+' accepts no '+cls+' calls through ZanaLLaima (writes: deny)');
    let decision;
    try{decision=await this.policy({caller,tool,args,cls,missionId,known});}
    catch(error){decision={allowed:false,reason:'Policy failed closed: '+this.describe(error)};}
    if(!decision?.allowed)return refuse(String(decision?.reason??'Refused by policy'));
    policyDetail=decision.detail??null;
    try{
      const result=await this.guarded((c,callId)=>{
        const iat=Math.floor(this.now()/1000);
        const actor=this.signer?.sign({iss:ACTOR_ISSUER,aud:this.config.name,sub:caller.host,
          session:caller.sessionId,role:caller.role??'author',...(missionId?{mission:missionId}:{}),
          jti:callId,tool,args:argsDigest(args),iat,exp:iat+ACTOR_TTL_SECONDS});
        return c.callTool({name:tool,arguments:args,_meta:{'zana-llaima/callId':callId,
          'zana-llaima/host':caller.host,...(actor?{'zana-llaima/actor':actor}:{}),
          ...(missionId?{'zana-llaima/missionId':missionId}:{})}},{timeout:this.config.timeoutMs});
      });
      if(Buffer.byteLength(JSON.stringify(result))>MAX_RESULT_BYTES){
        await finish('FAILED','result too large');
        return fail(this.config.name+'.'+tool+' returned more than '+MAX_RESULT_BYTES+' bytes');
      }
      await finish(result.isError?'TOOL_ERROR':'OK',null);
      return redactDeep(result,this.secrets());
    }catch(error){
      const message=this.describe(error);
      await finish('FAILED',message);
      return fail(this.config.name+'.'+tool+' failed: '+message);
    }
  }
  async close(){this.drop(this.s.client);}
}
