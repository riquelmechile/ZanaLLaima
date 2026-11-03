import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMission} from '../src/core.mjs';
import {transact,readState,storageStatus} from '../src/store.mjs';

function run(file,...args){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['src/cli.mjs',...args],{
      cwd:process.cwd(),env:{...process.env,ZANA_STATE_FILE:file},
      stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>stdout+=chunk);
    child.stderr.on('data',chunk=>stderr+=chunk);
    child.on('error',reject);
    child.on('close',code=>resolve({code,stdout,stderr}));
  });
}

test('eight competing clients cannot claim or finish the same unit twice',{timeout:60000},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zana-stress-'));
  const file=join(dir,'state.json');
  try{
    const mission=createMission({
      objective:'Validate multiprocess contention and fencing',
      authorization:{writesAllowed:false,allowedPaths:[]},
      units:[{id:'shared',effect:'READ',
        instruction:'Inspect this single shared unit without modifying resources'}],
    });
    await transact(()=>mission,file);
    const attempts=await Promise.all(Array.from({length:8},()=>run(file,'start')));
    const winners=attempts.filter(x=>x.code===0);
    assert.equal(winners.length,1,JSON.stringify(attempts));
    const first=JSON.parse(winners[0].stdout).packets[0];
    assert.equal(first.unitId,'shared');
    assert.equal((await readState(file)).units[0].attempts,1);
    const path=join(dir,'outcome.json');
    await writeFile(path,JSON.stringify({success:true,
      summary:'Verified shared state in the contention test',
      evidence:['Verified exact token and persisted unit identity']}));
    const finishes=await Promise.all(Array.from({length:8},()=>
      run(file,'complete','shared',first.token,path,String(first.leaseGeneration))));
    assert.equal(finishes.filter(x=>x.code===0).length,1,JSON.stringify(finishes));
    assert.equal((await readState(file)).units[0].status,'DONE');
    const info=await storageStatus(file);
    assert.equal(info.workReceipts,1);
    assert.equal(info.integrity,'ok');
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
});
