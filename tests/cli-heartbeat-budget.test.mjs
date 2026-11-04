import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

const spec={objective:'Verify mission-aware CLI and MCP heartbeat defaults',
  authorization:{writesAllowed:false,allowedPaths:[]},
  budget:{maxLeaseSeconds:60},
  units:[{id:'read',effect:'READ',instruction:'Inspect a local fixture with a 60-second lease'}]};
const assertWithinBudget=(expiresAt,started)=>{
  const remaining=Date.parse(expiresAt)-started;
  assert.ok(remaining>0&&remaining<=61000,'Default lease must remain within mission maxLeaseSeconds');
};
test('CLI heartbeat without an explicit duration honours the mission 60-second limit',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zana-cli-heartbeat-'));
  const file=join(dir,'state.json'),input=join(dir,'mission.json');
  try{
    await writeFile(input,JSON.stringify(spec));
    const invoke=(...args)=>spawnSync(process.execPath,['src/cli.mjs',...args],{
      cwd:process.cwd(),encoding:'utf8',
      env:{...process.env,ZANA_STATE_FILE:file,ZANA_OPERATOR_PUBLIC_KEY_PATH:''}});
    const init=invoke('init',input);assert.equal(init.status,0,init.stderr);
    const started=invoke('start');assert.equal(started.status,0,started.stderr);
    const p=JSON.parse(started.stdout).packets[0];
    const at=Date.now();
    const heartbeat=invoke('heartbeat',p.unitId,p.token,String(p.leaseGeneration));
    assert.equal(heartbeat.status,0,heartbeat.stderr);
    assertWithinBudget(JSON.parse(heartbeat.stdout).expiresAt,at);
    const oversized=invoke('heartbeat',p.unitId,p.token,String(p.leaseGeneration),'61');
    assert.notEqual(oversized.status,0,'Over-budget explicit heartbeat must be rejected');
    assert.match(oversized.stderr,/Heartbeat exceeds mission lease budget/);
    const zero=invoke('heartbeat',p.unitId,p.token,String(p.leaseGeneration),'0');
    assert.notEqual(zero.status,0,'Zero duration must not be interpreted as omitted');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('official stdio MCP heartbeat schema leaves omitted duration to the mission budget',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zana-mcp-heartbeat-'));
  const client=new Client({name:'heartbeat-budget-test',version:'0.1.0'});
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,
      args:[resolve('src/mcp.mjs')],
      env:{...process.env,ZANA_STATE_FILE:join(dir,'state.json'),
        ZANA_OPERATOR_PUBLIC_KEY_PATH:''}}));
    const call=(name,args)=>client.callTool({name,arguments:args||{}});
    assert.notEqual((await call('zana_mission_init',{spec})).isError,true);
    const batch=await call('zana_start_batch');
    const p=batch.structuredContent.packets[0];
    const at=Date.now();
    const ok=await call('zana_unit_heartbeat',{unitId:p.unitId,
      token:p.token,leaseGeneration:p.leaseGeneration});
    assert.equal(ok.isError,undefined,ok.content?.[0]?.text);
    assertWithinBudget(ok.structuredContent.expiresAt,at);
    const invalid=await call('zana_unit_heartbeat',{unitId:p.unitId,
      token:p.token,leaseGeneration:p.leaseGeneration,leaseSeconds:61});
    assert.equal(invalid.isError,true);
    assert.match(invalid.content?.[0]?.text||'',/Heartbeat exceeds mission lease budget/);
  }finally{await client.close().catch(()=>{});await rm(dir,{recursive:true,force:true});}
});
