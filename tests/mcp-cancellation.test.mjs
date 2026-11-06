import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatchTool} from '../src/mcp.mjs';

test('an already cancelled MCP request never dispatches a mutation',async()=>{
  const controller=new AbortController();
  controller.abort('client stopped before dispatch');
  let calls=0;
  const outcome=await dispatchTool('init',{spec:{objective:'must not run'}},{
    signal:controller.signal,
    implementation:{init:async()=>{calls++;return {created:true};}},
  });
  assert.equal(calls,0);
  assert.equal(outcome.isError,true);
  assert.match(outcome.content[0].text,/before dispatch/);
});

test('cancellation during a committed operation reports uncertainty rather than a fake failure',async()=>{
  const controller=new AbortController();
  let calls=0;
  const outcome=await dispatchTool('start',{},{
    signal:controller.signal,
    implementation:{start:async()=>{calls++;controller.abort('client left');return {committed:true};}},
  });
  assert.equal(calls,1);
  assert.equal(outcome.isError,true);
  assert.match(outcome.content[0].text,/may have committed/);
  assert.equal(outcome.structuredContent,undefined);
});

test('expected operation exceptions are MCP tool errors, not transport errors',async()=>{
  const output=await dispatchTool('retry',{unitId:'missing'},{
    implementation:{retry:async()=>{throw Error('Only failed READ work can be retried');}},
  });
  assert.equal(output.isError,true);
  assert.match(output.content[0].text,/Only failed READ work/);
});
