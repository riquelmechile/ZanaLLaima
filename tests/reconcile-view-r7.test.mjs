import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMission} from '../src/core.mjs';
import {transact} from '../src/store.mjs';
import {runCli} from '../src/cli.mjs';
import {operations} from '../src/actions.mjs';
test('R7 W8: reconcile-view CLI local muestra identidad completa sin exponer herramienta MCP',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'zana-r7-reconcile-view-'));
 const file=join(dir,'state.json'),old=process.env.ZANA_STATE_FILE;
 process.env.ZANA_STATE_FILE=file;
 try{
   const token=randomUUID(),pre='a'.repeat(64),post='b'.repeat(64);
   await transact(()=>{
     const m=createMission({objective:'Inspeccionar una intención incierta',
       authorization:{writesAllowed:true,allowedPaths:['docs']},
       units:[{id:'write',effect:'WRITE',paths:['docs'],instruction:'Efecto firmado'}]});
     m.units[0].attempts=1;m.units[0].status='OUTCOME_UNKNOWN';
     m.units[0].run={token,leaseGeneration:3,
       effectIntent:{path:'docs/guia.txt',preSha256:pre,expectedPostSha256:post,
         status:'INTENT_DURABLE'}};
     return m;
   },file);
   const view=await runCli('reconcile-view');
   assert.deepEqual(view.items,[{unitId:'write',leaseGeneration:3,token,
     path:'docs/guia.txt',preSha256:pre,expectedPostSha256:post}]);
   assert.equal(operations.reconcileView,undefined,'MCP no debe exponer token local completo');
 }finally{
   if(old===undefined)delete process.env.ZANA_STATE_FILE;
   else process.env.ZANA_STATE_FILE=old;
   await rm(dir,{recursive:true,force:true});
 }
});
