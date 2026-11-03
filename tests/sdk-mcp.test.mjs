import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { execFileSync } from 'node:child_process';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';

async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'zana-sdk-v2-'));
  const repo=join(dir,'repo');
  await mkdir(repo);
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{
    encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q','-b','main');
  git('config','user.name','Local Test');
  git('config','user.email','test@example.invalid');
  await writeFile(join(repo,'README.md'),'baseline');
  git('add','README.md');git('commit','-qm','baseline');
  git('checkout','-qb','feature/solo');
  await writeFile(join(repo,'README.md'),'candidate');
  git('add','README.md');git('commit','-qm','candidate');
  return {dir,repo,sha:git('rev-parse','HEAD'),cleanup:()=>rm(dir,{recursive:true,force:true})};
}
async function localClient(f){
  const client=new Client({name:'zana-local-test',version:'0.1.0'});
  const transport=new StdioClientTransport({
    command:process.execPath,
    args:[resolve('src/mcp.mjs')],
    env:{
      ...process.env,ZANA_STATE_FILE:join(f.dir,'state.json'),
      ZANA_REVIEW_REPO:f.repo,ZANA_REVIEW_TARGET_REF:'refs/heads/main',
    },
  });
  await client.connect(transport);
  const call=async(name,args={})=>{
    const response=await client.callTool({name,arguments:args});
    return {response,value:response.structuredContent ??
      JSON.parse(response.content.find(x=>x.type==='text').text)};
  };
  return {client,call};
}

test('official client negotiates SDK protocol and rejects untrusted reports',async()=>{
  const f=await fixture();
  let c;
  try{
    c=await localClient(f);
    const tools=(await c.client.listTools()).tools;
    assert.equal(tools.length,23);
    assert.ok(tools.some(t=>t.name==='zana_capability_status'));
    const p=await c.call('zana_profile');
    assert.equal(p.value.requested.model,'gpt-6-astra');
    const caps=await c.call('zana_capability_status',{
      hostReport:{model:'gpt-6-astra',reasoningEffort:'max',
        nativeSubagents:{available:true,maxConcurrent:4}}});
    assert.equal(caps.value.verified.model,null);
    assert.equal(caps.value.verified.nativeLaunches,null);
    assert.equal(caps.value.hostReported.assurance,'HOST_REPORTED_UNVERIFIED');
    assert.equal(caps.value.decision.maxParallel,4);
    const spoof=await c.client.callTool({name:'zana_capability_status',
      arguments:{hostReport:{model:'gpt-6-astra',verified:true}}});
    assert.equal(spoof.isError,true);
    const invalid=await c.client.callTool({name:'zana_unit_retry',
      arguments:{unitId:42}});
    assert.equal(invalid.isError,true);
    const missing=await c.client.callTool({name:'zana_unit_retry',
      arguments:{unitId:'read'}});
    assert.equal(missing.isError,true);
  }finally{if(c)await c.client.close();await f.cleanup();}
});

test('a single local SDK client completes READ mission and four-lens RDD without pretend workers',async()=>{
  const f=await fixture();
  let c;
  try{
    c=await localClient(f);
    const init=await c.call('zana_mission_init',{spec:{
      objective:'Validate standalone single-host operation',
      authorization:{writesAllowed:false,allowedPaths:[]},
      units:[{id:'scan',effect:'READ',instruction:'Inspect committed source'}],
    }});
    assert.equal(init.response.isError,undefined);
    assert.equal(init.value.units[0].status,'PENDING');
    const plan=await c.call('zana_next_batch',{hostReport:{nativeSubagents:{available:false}}});
    assert.equal(plan.value.mode,'SERIAL_PLAN');
    const reserved=await c.call('zana_start_batch');
    assert.equal(reserved.value.packets.length,1);
    assert.equal(reserved.value.actualSubagentLaunches,'NOT_OBSERVED');
    const task=reserved.value.packets[0];
    const completed=await c.call('zana_complete_unit',{
      unitId:'scan',token:task.token,leaseGeneration:task.leaseGeneration,
      outcome:{success:true,summary:'Validated committed source locally',
        evidence:['Actual local repository Git commit inspected by fixture']},
    });
    assert.equal(completed.value.units[0].status,'DONE');
    const opened=await c.call('zana_review_open',{candidateSha:f.sha});
    assert.equal(opened.value.candidateVerifiedByGit,true);
    for(const lens of ['risk','reliability','resilience','readability']){
      const batch=await c.call('zana_review_start',{hostReport:{nativeSubagents:{available:false}}});
      assert.equal(batch.value.packets.length,1);
      assert.equal(batch.value.actualNativeLaunches,'NOT_OBSERVED');
      const packet=batch.value.packets[0];
      assert.equal(packet.lensId,lens);
      const result=await c.call('zana_review_submit',{
        lensId:lens,token:packet.token,candidateSha:f.sha,
        verdict:'PASS',summary:'Reviewed immutable Git candidate for '+lens,
        evidence:['Inspected actual candidate and unit test fixture'],
        execution:'SELF_CONTEXT',findings:[],
      });
      assert.equal(result.value.approved,false);
    }
    const status=await c.call('zana_review_status');
    assert.equal(status.value.gate,'SELF_CHECK_COMPLETE_UNVERIFIED');
    assert.equal(status.value.independentReviewVerified,false);
    const verify=await c.call('zana_review_check');
    assert.equal(verify.value.gate,'SELF_CHECK_COMPLETE_UNVERIFIED');
    const missing=await c.call('zana_review_start');
    assert.equal(missing.response.isError,true);
  }finally{if(c)await c.client.close();await f.cleanup();}
});
