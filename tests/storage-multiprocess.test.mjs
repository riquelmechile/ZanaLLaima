import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMission } from '../src/core.mjs';
import { databasePath, readState, transact, storageStatus } from '../src/store.mjs';

const run = (file, ...args) => new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['src/cli.mjs',...args],
    {cwd:process.cwd(),env:{...process.env,ZANA_STATE_FILE:file},stdio:['ignore','pipe','pipe']});
  let out='',err='';
  child.stdout.on('data',chunk=>out+=chunk);
  child.stderr.on('data',chunk=>err+=chunk);
  child.on('error',reject);
  child.on('close',code=>resolve({code,out,err}));
});

test('two processes cannot reserve the same unit or complete one token twice',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zana-race-'));
  const file=join(dir,'state.json');
  try {
    await transact(()=>createMission({objective:'Competing processes safely',
      authorization:{writesAllowed:false,allowedPaths:[]},
      units:[{id:'read',effect:'READ',instruction:'Verify shared state safely'}]}),file);
    const starts=await Promise.all([run(file,'start'),run(file,'start')]);
    const winners=starts.filter(x=>x.code===0);
    assert.equal(winners.length,1,JSON.stringify(starts));
    const packet=JSON.parse(winners[0].out).packets[0];
    const resultPath=join(dir,'result.json');
    const {writeFile}=await import('node:fs/promises');
    await writeFile(resultPath,JSON.stringify({success:true,summary:'Checked result and competing claims',
      evidence:['Inspected both process outcomes']}));
    const completes=await Promise.all([
      run(file,'complete',packet.unitId,packet.token,resultPath),
      run(file,'complete',packet.unitId,packet.token,resultPath),
    ]);
    assert.equal(completes.filter(x=>x.code===0).length,1,JSON.stringify(completes));
    assert.equal((await readState(file)).units[0].status,'DONE');
    assert.equal((await storageStatus(file)).workReceipts,1);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('abrupt process exit inside IMMEDIATE transaction rolls back without corrupting DB',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zana-crash-'));
  const file=join(dir,'state.json');
  try {
    const before=await transact(()=>createMission({objective:'Original durable objective',
      authorization:{writesAllowed:false,allowedPaths:[]},
      units:[{id:'read',effect:'READ',instruction:'Inspect state'}]}),file);
    const script="import {DatabaseSync} from 'node:sqlite';"+
      "const db=new DatabaseSync(process.argv[1]);"+
      "db.exec('PRAGMA busy_timeout=10000;BEGIN IMMEDIATE;');"+
      "db.prepare('UPDATE active_mission SET objective=? WHERE slot=1').run('uncommitted change');"+
      "process.exit(63);";
    const result=spawnSync(process.execPath,['--input-type=module','-e',script,databasePath(file)],
      {encoding:'utf8'});
    assert.equal(result.status,63,result.stderr);
    const after=await readState(file);
    assert.equal(after.objective,before.objective);
    assert.equal(after.revision,before.revision);
    assert.equal((await storageStatus(file)).integrity,'ok');
  } finally {await rm(dir,{recursive:true,force:true});}
});
