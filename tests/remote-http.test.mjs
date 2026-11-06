import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {remoteFixture,AUTHOR_TOKEN,REVIEWER_TOKEN} from './helpers/remote-fixture.mjs';
import {EmbeddedOAuth,setEnrollment,listClients,revokeClient,clientIdentity} from '../src/oauth.mjs';
import {createHttpServer,httpSettings} from '../src/http.mjs';
import {REMOTE_TOOL_NAMES} from '../src/remote.mjs';
import {runCli,parseCliCommand} from '../src/cli.mjs';

const PASSWORD='p'.repeat(40);
const REDIRECT='https://chatgpt.com/connector_platform_oauth_redirect';
const PUBLIC='https://zanallaima.test/mcp';

async function server(f,{password=PASSWORD}={}){
  const settings={...httpSettings({ZANA_PUBLIC_HOST:'zanallaima.test',ZANA_OAUTH_DB:join(f.dir,'oauth.sqlite')}),password};
  const oauth=new EmbeddedOAuth({path:settings.oauthDb,resource:PUBLIC,redirectUris:[REDIRECT],password});
  const http=createHttpServer({runtime:f.runtime,oauth,settings,log:{error(){}}});
  await new Promise(ok=>http.listen(0,'127.0.0.1',ok));
  const base='http://127.0.0.1:'+http.address().port;
  return {base,oauth,settings,http,close:async()=>{http.closeAllConnections();await new Promise(ok=>http.close(ok));oauth.close();}};
}
// fetch() cannot override Host; use node:http for Host-header checks.
const rawStatus=(base,path,headers)=>new Promise((ok,fail)=>{
  const u=new URL(base);
  const r=httpRequest({host:u.hostname,port:u.port,path,method:'POST',headers},res=>{res.resume();ok(res.statusCode);});
  r.on('error',fail);r.end();
});
const form=o=>new URLSearchParams(o).toString();
async function login(base,{host='zana-chatgpt',password=PASSWORD}={}){
  const reg=await fetch(base+'/register',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({redirect_uris:[REDIRECT],client_name:'ChatGPT'})});
  if(reg.status!==201)return {status:reg.status,step:'register'};
  const {client_id}=await reg.json();
  const verifier=randomBytes(32).toString('base64url');
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  const auth=await fetch(base+'/authorize?'+form({client_id,redirect_uri:REDIRECT,response_type:'code',
    code_challenge:challenge,code_challenge_method:'S256',state:'st',scope:'mcp',resource:PUBLIC}),{redirect:'manual'});
  if(auth.status!==302)return {status:auth.status,step:'authorize'};
  const csrf=/__Host-zana-consent=([^;]+)/.exec(auth.headers.get('set-cookie'))[1];
  const sid=new URL(auth.headers.get('location'),base).searchParams.get('sid');
  const page=await fetch(base+'/oauth/consent?sid='+sid,{headers:{cookie:'__Host-zana-consent='+csrf}});
  assert.equal(page.status,200);
  assert.match(await page.text(),/NO VERIFICADO/);
  const consent=await fetch(base+'/oauth/consent?sid='+sid,{method:'POST',redirect:'manual',
    headers:{'content-type':'application/x-www-form-urlencoded',origin:'https://zanallaima.test'},
    body:form({csrf,password,host,decision:'allow'})});
  if(consent.status!==302)return {status:consent.status,step:'consent'};
  const code=new URL(consent.headers.get('location')).searchParams.get('code');
  const token=await fetch(base+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
    body:form({grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:REDIRECT,client_id})});
  return {status:token.status,client_id,...await token.json()};
}
async function connect(base,token,options){
  const client=new Client({name:'chatgpt-like',version:'1.0.0'},options);
  const transport=new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+token}}});
  await client.connect(transport);
  const call=async(name,args={})=>{
    const r=await client.callTool({name,arguments:args});
    return r.isError?{error:r.content[0].text}:r.structuredContent;
  };
  return {client,transport,call};
}

test('closed registration: nothing enrolls outside the operator window; tokens identify the host',async()=>{
  const f=await remoteFixture();
  const s=await server(f);
  try{
    const health=await (await fetch(s.base+'/health')).json();
    assert.deepEqual({status:health.status,name:health.name,mode:health.mode},{status:'ok',name:'zana-llaima',mode:'remote'});
    assert.equal((await fetch(s.base+'/mcp',{method:'POST'})).status,401);
    assert.match((await fetch(s.base+'/mcp',{method:'POST'})).headers.get('www-authenticate'),/resource_metadata=/);
    assert.equal((await fetch(s.base+'/.well-known/oauth-authorization-server')).status,200);
    // Window closed: registration refused.
    assert.deepEqual(await login(s.base),{status:400,step:'register'});
    setEnrollment(s.settings.oauthDb,5);
    assert.throws(()=>setEnrollment(s.settings.oauthDb,61),/Minutes/);
    // Wrong password: consent refused.
    assert.deepEqual(await login(s.base,{password:'x'.repeat(40)}),{status:403,step:'consent'});
    const ok=await login(s.base);
    assert.equal(ok.status,200);
    assert.ok(ok.access_token&&ok.refresh_token);
    assert.deepEqual(s.oauth.authenticate('Bearer '+ok.access_token),{host:'zana-chatgpt',clientId:ok.client_id});
    // Close the window: no new client gets in, the approved one keeps working and refreshing.
    setEnrollment(s.settings.oauthDb,0);
    assert.deepEqual(await login(s.base),{status:400,step:'register'});
    const refreshed=await fetch(s.base+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
      body:form({grant_type:'refresh_token',refresh_token:ok.refresh_token,client_id:ok.client_id})});
    assert.equal(refreshed.status,200);
    const replay=await fetch(s.base+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
      body:form({grant_type:'refresh_token',refresh_token:ok.refresh_token,client_id:ok.client_id})});
    assert.equal(replay.status,400,'refresh token replay revokes the family');
    assert.equal(listClients(s.settings.oauthDb).clients.length>=1,true);
    assert.equal(await rawStatus(s.base,'/mcp',{host:'evil.example',authorization:'Bearer '+ok.access_token}),403);
    assert.equal((await fetch(s.base+'/x',{headers:{}})).status,404);
    assert.equal((await fetch(s.base+'/.well-known/zana-downstream-keys')).status,200);
  }finally{await s.close();await f.cleanup();}
});

test('Streamable HTTP sessions: two conversations get two sessions; the reviewer flow over real MCP',async()=>{
  const f=await remoteFixture();
  const s=await server(f);
  try{
    setEnrollment(s.settings.oauthDb,5);
    const {access_token:token,client_id}=await login(s.base);
    const a=await connect(s.base,token);
    const tools=(await a.client.listTools()).tools.map(t=>t.name).sort();
    assert.deepEqual(tools,[...REMOTE_TOOL_NAMES]);
    assert.equal(tools.length,29);
    for(const local of ['zana_apply_write','zana_review_open','zana_review_submit','zana_storage_status','zana_permission_status'])
      assert.equal(tools.includes(local),false,local+' is stdio-only');
    assert.match(a.client.getInstructions(),/zana-odd/);
    assert.match(a.client.getInstructions(),/zana-4r/);
    const sa=await a.call('zana_session_status');
    assert.equal(sa.session.host,'zana-chatgpt');
    assert.equal(sa.session.id,a.transport.sessionId);
    const skills=await a.call('zana_skill_list');
    assert.ok(skills.skills.some(x=>x.name==='zana-odd'));
    // Author conversation over HTTP.
    const init=await a.call('zana_mission_init',{spec:f.spec,github:{repo:'o/r',base:'main'}});
    assert.equal(init.github.branch,'zana/'+init.id);
    await a.call('zana_start_batch',{});
    f.api.state.push(init.github.branch,'a'.repeat(40));f.api.state.green('a'.repeat(40));f.api.state.openPull(init.github.branch);
    const req=await a.call('zana_review_request',{missionId:init.id});
    assert.match((await a.call('zana_review_claim',{ticket:req.ticket})).error,/AUTHOR_SESSION/);
    // New conversation: new transport session, same OAuth identity.
    const b=await connect(s.base,token);
    assert.notEqual(b.transport.sessionId,a.transport.sessionId);
    const claim=await b.call('zana_review_claim',{ticket:req.ticket});
    assert.equal(claim.state,'CLAIMED');
    const w=await b.call('zana_ds_github',{operation:'push_files',missionId:init.id,
      arguments:{owner:'o',repo:'r',branch:init.github.branch,files:[{path:'a',content:'x'}],message:'m'}});
    assert.match(w.error,/REVIEWER_READ_ONLY/);
    // A session id is bound to the identity that opened it.
    setEnrollment(s.settings.oauthDb,5);
    const other=await login(s.base,{host:'other-host'});
    const stolen=await fetch(s.base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+other.access_token,
      'mcp-session-id':a.transport.sessionId,'content-type':'application/json',accept:'application/json, text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
    assert.equal(stolen.status,403);
    const missing=await fetch(s.base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'mcp-session-id':'nope-session',
      'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
    assert.equal(missing.status,404);
    const noSession=await fetch(s.base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
    assert.equal(noSession.status,400);
    const envelope=await fetch(s.base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'server/discover',params:{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28'}}})});
    assert.equal(envelope.status,400);
    assert.match((await envelope.json()).error.message,/Unsupported protocol version/);
    const badJson=await fetch(s.base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:'{'});
    assert.equal(badJson.status,400);
    const big=await fetch(s.base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
      body:'x'.repeat(5*1024*1024)});
    assert.equal(big.status,413);
    const badOrigin=await fetch(s.base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+token,origin:'https://evil.example'}});
    assert.equal(badOrigin.status,403);
    // Revoking the client cuts every session of it.
    revokeClient(s.settings.oauthDb,client_id);
    assert.equal((await fetch(s.base+'/mcp',{method:'POST',headers:{authorization:'Bearer '+token}})).status,401);
    // Audit: who, which tool, mission, outcome, argument hash; never a token.
    const audit=await f.runtime.readAudit({limit:100});
    assert.ok(audit.some(x=>x.tool==='zana_review_claim'&&x.sessionId===b.transport.sessionId&&x.host==='zana-chatgpt'&&
      x.missionId===init.id&&x.outcome==='OK'&&/^[0-9a-f]{64}$/.test(x.argsHmac)));
    assert.ok(audit.some(x=>x.tool==='zana_start_batch'&&x.missionId===init.id&&x.sessionId===a.transport.sessionId));
    const text=JSON.stringify(audit);
    for(const secret of [AUTHOR_TOKEN,REVIEWER_TOKEN,token,PASSWORD])assert.equal(text.includes(secret),false);
    await a.client.close();await b.client.close();
  }finally{await s.close();await f.cleanup();}
});

test('a negotiating 2026 client falls back to the sessionful transport',async()=>{
  const f=await remoteFixture();
  const s=await server(f);
  try{
    setEnrollment(s.settings.oauthDb,5);
    const {access_token:token}=await login(s.base);
    const c=await connect(s.base,token,{versionNegotiation:{mode:'auto'}});
    assert.ok(c.transport.sessionId,'legacy session established');
    assert.equal((await c.call('zana_profile')).requested.model,'gpt-6-astra');
    await c.client.close();
  }finally{await s.close();await f.cleanup();}
});

test('OAuth edge cases and client identity',async()=>{
  const f=await remoteFixture();
  const s=await server(f);
  try{
    assert.throws(()=>new EmbeddedOAuth({path:join(f.dir,'o2.sqlite'),resource:PUBLIC,redirectUris:[REDIRECT],password:'short'}),/at least 32/);
    assert.throws(()=>new EmbeddedOAuth({path:join(f.dir,'o2.sqlite'),resource:'http://x/mcp',redirectUris:[REDIRECT],password:PASSWORD}),/resource/);
    assert.throws(()=>new EmbeddedOAuth({path:join(f.dir,'o2.sqlite'),resource:PUBLIC,redirectUris:[],password:PASSWORD}),/redirect/);
    setEnrollment(s.settings.oauthDb,5);
    const post=(path,body,type='application/json',extra={})=>fetch(s.base+path,{method:'POST',
      headers:{'content-type':type,...extra},body:type==='application/json'?JSON.stringify(body):form(body)});
    assert.equal((await post('/register',{redirect_uris:['https://evil.example/cb']})).status,400);
    assert.equal((await post('/register',{redirect_uris:[REDIRECT],token_endpoint_auth_method:'client_secret_basic'})).status,400);
    assert.equal((await post('/register',{redirect_uris:[REDIRECT]},'application/x-www-form-urlencoded')).status,400);
    assert.equal((await fetch(s.base+'/register',{method:'POST',headers:{'content-type':'application/json'},body:'{'})).status,400);
    assert.equal((await fetch(s.base+'/authorize?client_id=x',{redirect:'manual'})).status,400);
    assert.equal((await fetch(s.base+'/oauth/consent?sid=x')).status,400);
    assert.equal((await post('/oauth/consent?sid=x',{},'application/x-www-form-urlencoded',{origin:'https://evil.example'})).status,403);
    assert.equal((await post('/token',{grant_type:'password',client_id:'zc_x'},'application/x-www-form-urlencoded')).status,400);
    assert.equal((await post('/token',{grant_type:'authorization_code',client_id:'zc_x',code:'c',code_verifier:'short'},'application/x-www-form-urlencoded')).status,400);
    assert.equal((await post('/token',{grant_type:'refresh_token',client_id:'zc_x',refresh_token:'r'.repeat(40)},'application/x-www-form-urlencoded')).status,400);
    assert.equal((await post('/revoke',{client_id:'bad',token:'x'},'application/x-www-form-urlencoded')).status,400);
    const ok=await login(s.base);
    assert.equal((await post('/revoke',{client_id:ok.client_id,token:ok.access_token},'application/x-www-form-urlencoded')).status,200);
    assert.throws(()=>s.oauth.authenticate('Bearer '+ok.access_token),/Invalid token/);
    assert.throws(()=>s.oauth.authenticate(undefined),/Invalid token/);
    assert.throws(()=>revokeClient(s.settings.oauthDb,'nope'),/Invalid client/);
    assert.equal(clientIdentity({socket:{remoteAddress:'127.0.0.1'},headers:{'cf-connecting-ip':'203.0.113.9'}}),'203.0.113.9');
    assert.equal(clientIdentity({socket:{remoteAddress:'198.51.100.1'},headers:{'cf-connecting-ip':'203.0.113.9'}}),'198.51.100.1');
    assert.equal(clientIdentity({socket:{},headers:{}}),'unknown');
  }finally{await s.close();await f.cleanup();}
});

test('operator CLI: enrollment window, clients, audit and argument validation',async()=>{
  const f=await remoteFixture();
  const prev=process.env.ZANA_OAUTH_DB;
  process.env.ZANA_OAUTH_DB=join(f.dir,'cli-oauth.sqlite');
  try{
    await assert.rejects(runCli('remote-enroll',['10']),/does not exist/);
    setEnrollment(process.env.ZANA_OAUTH_DB,0);
    assert.equal((await runCli('remote-enroll',['10'])).enrollmentOpen,true);
    assert.equal((await runCli('remote-clients',[])).enrollmentOpen,true);
    assert.equal((await runCli('remote-enroll-close',[])).enrollmentOpen,false);
    await assert.rejects(runCli('remote-enroll',['0']),/between 1 and 60/);
    await assert.rejects(runCli('remote-revoke',[]),/clientId/);
    await assert.rejects(runCli('remote-merge',[]),/missionId/);
    await assert.rejects(runCli('remote-ticket-abandon',[]),/ticketId/);
    await assert.rejects(runCli('remote-audit',['--env-file']),/requires a path/);
    assert.deepEqual((await parseCliCommand('remote-audit',['5','m'])).input,{limit:5,missionId:'m'});
    assert.ok(Array.isArray((await runCli('remote-audit',[])).items));
    assert.deepEqual((await runCli('remote-tickets',[])).tickets,[]);
    await assert.rejects(runCli('remote-ticket-abandon',['nope']),/TICKET_NOT_FOUND/);
    await assert.rejects(runCli('remote-merge',['missing-mission']),/UNKNOWN_MISSION/);
    await assert.rejects(runCli('remote-revoke',['zc_'+'a'.repeat(24)]),/CLIENT_NOT_FOUND/);
  }finally{
    if(prev===undefined)delete process.env.ZANA_OAUTH_DB;else process.env.ZANA_OAUTH_DB=prev;
    await f.cleanup();
  }
});
