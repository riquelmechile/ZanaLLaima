import test from 'node:test';
import assert from 'node:assert/strict';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import {remoteConfig} from '../src/remote-config.mjs';
import {createRemoteRuntime} from '../src/remote.mjs';
import {validateGithubAdmin,githubAdminRequest,githubAdminAudit} from '../src/github-admin.mjs';
import {remoteFixture} from './helpers/remote-fixture.mjs';
import {BOOTSTRAP_TOKEN,REVIEWER_TOKEN} from './helpers/fake-github.mjs';

async function mcpClient(runtime,session){
  const [client,transport]=InMemoryTransport.createLinkedPair();
  const server=runtime.createServer(async()=>session);
  await server.connect(transport);
  const pending=new Map();let id=0;
  client.onmessage=message=>{const accept=pending.get(message.id);if(accept){pending.delete(message.id);accept(message);}};
  await client.start();
  const request=async(method,params={})=>{
    const n=++id,promise=new Promise(resolve=>pending.set(n,resolve));
    await client.send({jsonrpc:'2.0',id:n,method,params});return promise;
  };
  await request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'github-admin-test',version:'1'}});
  await client.send({jsonrpc:'2.0',method:'notifications/initialized'});
  return {request,close:async()=>{await client.close();await server.close();}};
}
const call=(client,name,args)=>client.request('tools/call',{name,arguments:args}).then(x=>x.result);

test('full access is off and fails closed without a distinct bootstrap token',()=>{
  assert.equal(remoteConfig({}).githubFullAccess,false);
  assert.throws(()=>remoteConfig({ZANA_GITHUB_FULL_ACCESS:'true'}),/TOKEN_MISSING/);
  assert.throws(()=>remoteConfig({ZANA_GITHUB_FULL_ACCESS:'true',ZANA_BOOTSTRAP_GITHUB_TOKEN:'x',ZANA_DOWNSTREAM_GITHUB_TOKEN:'x'}),/TOKEN_SHARED/);
});
test('el arranque remoto falla cerrado si full access no tiene token bootstrap separado',()=>{
  assert.throws(()=>createRemoteRuntime({env:{ZANA_GITHUB_FULL_ACCESS:'true'}}),/TOKEN_MISSING/);
  assert.throws(()=>createRemoteRuntime({env:{ZANA_GITHUB_FULL_ACCESS:'true',ZANA_BOOTSTRAP_GITHUB_TOKEN:'same',
    ZANA_DOWNSTREAM_GITHUB_TOKEN:'same'}}),/TOKEN_SHARED/);
});
test('validates paths, accept and reviewer scope',()=>{
  for(const path of ['https://x','//repos/x','/repos/../x','/repos\\x','/repos/x\r\ny'])
    assert.throws(()=>validateGithubAdmin({method:'GET',path}),/PATH/);
  assert.throws(()=>validateGithubAdmin({method:'TRACE',path:'/repos/o/r'}),/METHOD/);
  assert.throws(()=>validateGithubAdmin({method:'GET',path:'repos/o/r'}),/PATH/);
  assert.throws(()=>validateGithubAdmin({method:'GET',path:'/'+('x'.repeat(2000))}),/PATH/);
  assert.throws(()=>validateGithubAdmin({method:'GET',path:'/repos/o/r',accept:'text/plain'}),/ACCEPT/);
  assert.doesNotThrow(()=>validateGithubAdmin({method:'GET',path:'/repos/o/r',accept:'application/vnd.github+json'}));
  for(const body of [null,[],1,'text'])
    assert.throws(()=>validateGithubAdmin({method:'POST',path:'/repos/o/r',body}),/BODY/);
  assert.throws(()=>validateGithubAdmin({method:'POST',path:'/repos/o/r',body:{large:'x'.repeat(1_048_576)}}),/BODY/);
  assert.doesNotThrow(()=>validateGithubAdmin({method:'POST',path:'/repos/o/r',body:{ok:true}}));
  assert.throws(()=>validateGithubAdmin({method:'GET',path:'/repos/x',identity:'reviewer'}),/REVIEWER_SCOPE/);
  assert.throws(()=>validateGithubAdmin({method:'GET',path:'/user/repository_invitations/7',identity:'reviewer'}),/REVIEWER_SCOPE/);
  assert.throws(()=>validateGithubAdmin({method:'PATCH',path:'/user/repository_invitations',identity:'reviewer'}),/REVIEWER_SCOPE/);
  assert.doesNotThrow(()=>validateGithubAdmin({method:'GET',path:'/user/repository_invitations',identity:'reviewer'}));
  assert.doesNotThrow(()=>validateGithubAdmin({method:'PATCH',path:'/user/repository_invitations/7',identity:'reviewer'}));
});
test('executes the bootstrap sequence and audit excludes bodies and tokens',async()=>{
  const calls=[];
  const owner={request:async(method,path,options)=>{calls.push({identity:'owner',method,path,options});return {status:201,data:{ok:true}};}};
  const reviewer={request:async(method,path,options)=>{calls.push({identity:'reviewer',method,path,options});return {status:204,data:null};}};
  await githubAdminRequest({method:'PUT',path:'/repos/o/r/contents/.github/workflows/zana-checks.yml',body:{content:'x'}},{owner,reviewer});
  await githubAdminRequest({method:'PUT',path:'/repos/o/r/collaborators/reviewer',body:{permission:'push'}},{owner,reviewer});
  await githubAdminRequest({method:'PATCH',path:'/user/repository_invitations/7',identity:'reviewer'},{owner,reviewer});
  await githubAdminRequest({method:'PUT',path:'/repos/o/r/branches/main/protection',body:{required_pull_request_reviews:{required_approving_review_count:1}}},{owner,reviewer});
  assert.deepEqual(calls.map(x=>[x.identity,x.method,x.path]),[
    ['owner','PUT','/repos/o/r/contents/.github/workflows/zana-checks.yml'],['owner','PUT','/repos/o/r/collaborators/reviewer'],
    ['reviewer','PATCH','/user/repository_invitations/7'],['owner','PUT','/repos/o/r/branches/main/protection']]);
  const audit=githubAdminAudit({method:'PUT',path:'/repos/o/r?token=secret',body:{token:'secret'},identity:'owner'},201);
  assert.deepEqual(audit,{method:'PUT',path:'/repos/o/r',status:201,identity:'owner'});
  assert.equal(JSON.stringify(audit).includes('secret'),false);
});

test('acota respuestas grandes, usa owner por defecto y convierte errores desconocidos en 502',async()=>{
  const calls=[];
  const owner={request:async(method,path)=>{calls.push([method,path]);return {status:200,data:{text:'x'.repeat(70_000)}};}};
  const large=await githubAdminRequest({method:'GET',path:'/repos/o/r'},{owner});
  assert.deepEqual(calls,[['GET','/repos/o/r']]);
  assert.equal(large.status,200);assert.equal(large.truncated,true);
  assert.equal(typeof large.data,'string');assert.equal(large.data.length,64_000);
  const unknown={request:async()=>{throw new TypeError('socket closed');}};
  await assert.rejects(githubAdminRequest({method:'GET',path:'/repos/o/r'},{owner:unknown}),error=>{
    assert.equal(error.status,502);assert.match(error.message,/^GITHUB_502: socket closed$/);return true;
  });
  assert.deepEqual(githubAdminAudit(),{method:undefined,path:'',status:null,identity:'owner'});
});

test('MCP real expone full access solo encendido, ejecuta bootstrap y audita solo metadatos',async()=>{
  const off=await remoteFixture();let offClient;
  try{
    offClient=await mcpClient(off.runtime,await off.session());
    const names=(await offClient.request('tools/list')).result.tools.map(x=>x.name);
    assert.equal(names.includes('zana_github_request'),false);
  }finally{if(offClient)await offClient.close();await off.cleanup();}

  const f=await remoteFixture({envExtra:{ZANA_GITHUB_FULL_ACCESS:'true',ZANA_BOOTSTRAP_GITHUB_TOKEN:BOOTSTRAP_TOKEN}});
  let client;
  try{
    client=await mcpClient(f.runtime,await f.session());
    const names=(await client.request('tools/list')).result.tools.map(x=>x.name);
    assert.equal(names.includes('zana_github_request'),true);
    const requests=[
      {method:'GET',path:'/repos/o/r'},
      {method:'PUT',path:'/repos/o/r/contents/.github/workflows/zana-checks.yml',body:{content:'secret-body'}},
      {method:'PUT',path:'/repos/o/r/collaborators/reviewer-bot',body:{permission:'push'}},
      {method:'PATCH',path:'/user/repository_invitations/7',identity:'reviewer'},
      {method:'PUT',path:'/repos/o/r/branches/main/protection',body:{required_pull_request_reviews:{required_approving_review_count:1}}},
    ];
    for(const args of requests){const result=await call(client,'zana_github_request',args);assert.equal(result.isError,undefined,JSON.stringify(result));}
    const before=f.api.state.requests.length;
    const refused=await call(client,'zana_github_request',{method:'GET',path:'/repos/o/r',identity:'reviewer'});
    assert.equal(refused.isError,true);assert.match(refused.content[0].text,/REVIEWER_SCOPE/);
    assert.equal(f.api.state.requests.length,before,'scope se valida antes de llamar GitHub');
    const rows=(await f.runtime.readAudit({limit:50})).filter(x=>x.tool==='zana_github_request');
    assert.equal(rows.length,requests.length+1);
    const workflow=rows.find(x=>x.detail?.path==='/repos/o/r/contents/.github/workflows/zana-checks.yml');
    assert.deepEqual(workflow.detail,{method:'PUT',path:'/repos/o/r/contents/.github/workflows/zana-checks.yml',status:201,identity:'owner'});
    const serialized=JSON.stringify(rows);
    for(const secret of ['secret-body','?token=',BOOTSTRAP_TOKEN,REVIEWER_TOKEN])assert.equal(serialized.includes(secret),false);
  }finally{if(client)await client.close();await f.cleanup();}
});

test('un error GitHub es isError y la auditoría conserva status sin respuesta',async()=>{
  const f=await remoteFixture({envExtra:{ZANA_GITHUB_FULL_ACCESS:'true',ZANA_BOOTSTRAP_GITHUB_TOKEN:BOOTSTRAP_TOKEN}});
  let client;
  try{
    client=await mcpClient(f.runtime,await f.session());
    f.api.state.failNext={status:403,message:'denied-response-secret'};
    const result=await call(client,'zana_github_request',{method:'GET',path:'/repos/o/r?token=query-secret'});
    assert.equal(result.isError,true);assert.match(result.content[0].text,/GITHUB_403/);
    const row=(await f.runtime.readAudit({limit:10})).find(x=>x.tool==='zana_github_request');
    assert.equal(row.outcome,'ERROR');
    assert.deepEqual(row.detail,{method:'GET',path:'/repos/o/r',status:403,identity:'owner'});
    const serialized=JSON.stringify(row);
    for(const secret of ['denied-response-secret','query-secret','?token='])assert.equal(serialized.includes(secret),false);
  }finally{if(client)await client.close();await f.cleanup();}
});
