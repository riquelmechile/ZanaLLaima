import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const sleep=ms=>new Promise(done=>setTimeout(done,ms));
test('eight overlapping real MCP heartbeat/complete mutations do not deadlock SQLite',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zana-mcp-overlap-'));
  const client=new Client({name:'zana-concurrency-test',version:'0.1.0'});
  try{
    const transport=new StdioClientTransport({command:process.execPath,
      args:[resolve('src/mcp.mjs')],
      env:{...process.env,ZANA_STATE_FILE:join(dir,'state.json'),
        ZANA_OPERATOR_PUBLIC_KEY_PATH:'',ZANA_WORKSPACE_ROOT:dir}});
    await client.connect(transport);
    const call=(name,args)=>client.callTool({name,arguments:args||{}});
    const setup=await call('zana_mission_init',{spec:{
      objective:'Four concurrent read claims with eight MCP mutations',
      authorization:{writesAllowed:false,allowedPaths:[]},
      units:Array.from({length:4},(_,i)=>({id:'scan-'+i,effect:'READ',
        instruction:'Inspect safe fixture '+i})),
    }});
    assert.notEqual(setup.isError,true,JSON.stringify(setup));
    const reserved=await call('zana_start_batch',{hostReport:{
      model:'gpt-6-astra',reasoningEffort:'max',
      nativeSubagents:{available:true,maxConcurrent:4},
    }});
    assert.notEqual(reserved.isError,true,JSON.stringify(reserved));
    const packets=reserved.structuredContent.packets;
    assert.equal(packets.length,4);
    // All eight requests are in Promise.all. Completions start after a small
    // delay so a heartbeat is not accidentally made stale by its own completion.
    const heartbeat=packets.map(p=>call('zana_unit_heartbeat',{
      unitId:p.unitId,token:p.token,leaseGeneration:p.leaseGeneration,
      leaseSeconds:120}));
    const complete=packets.map(async p=>{
      await sleep(12);
      return call('zana_complete_unit',{unitId:p.unitId,token:p.token,
        leaseGeneration:p.leaseGeneration,
        outcome:{success:true,summary:'Read-only task checked by real MCP test',
          evidence:['Observed and compared explicit fixture data']}});
    });
    const settled=await Promise.all([...heartbeat,...complete]);
    assert.equal(settled.length,8);
    settled.forEach((result,index)=>{
      const msg=result.content?.[0]?.text??'no text';
      assert.equal(result.isError,undefined,
        'MCP mutation '+index+' rejected: '+msg);
      assert.doesNotMatch(msg,/database is locked/i);
    });
    const status=await call('zana_mission_status');
    assert.equal(status.isError,undefined);
    assert.equal(status.structuredContent.units.filter(x=>x.status==='DONE').length,4);
  }finally{await client.close().catch(()=>{});await rm(dir,{recursive:true,force:true});}
});
