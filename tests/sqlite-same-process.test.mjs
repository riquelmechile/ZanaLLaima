import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMission} from '../src/core.mjs';
import {transact,readState,storageStatus} from '../src/store.mjs';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const mission=()=>createMission({objective:'Verify same-process transaction ordering',
  authorization:{writesAllowed:false,allowedPaths:[]},
  units:[{id:'read',effect:'READ',instruction:'Inspect the SQLite queue fixture'}]});
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'zana-same-process-'));
  const file=join(dir,'state.json');
  await transact(()=>mission(),file);
  return {file,cleanup:()=>rm(dir,{recursive:true,force:true})};
}

test('two overlapping transactions await 200ms without blocking the event loop or losing ordering',async()=>{
  const f=await fixture();
  try{
    const events=[];
    const first=transact(async state=>{
      events.push('first-start');
      await wait(200);
      state.objective='first completed';
      state.revision++;
      events.push('first-end');
      return state;
    },f.file);
    const second=transact(async state=>{
      events.push('second-start');
      assert.equal(state.objective,'first completed');
      state.objective='second completed';
      state.revision++;
      events.push('second-end');
      return state;
    },f.file);
    const [a,b]=await Promise.all([first,second]);
    assert.equal(a.revision,1);
    assert.equal(b.revision,2);
    assert.deepEqual(events,['first-start','first-end','second-start','second-end']);
    assert.equal((await readState(f.file)).objective,'second completed');
    assert.equal((await storageStatus(f.file)).integrity,'ok');
  }finally{await f.cleanup();}
});

test('a thrown asynchronous transformation always releases the local write queue',async()=>{
  const f=await fixture();
  try{
    const events=[];
    const bad=transact(async state=>{
      events.push('bad-start');
      state.objective='not committed';
      await wait(35);
      throw Error('intentional rollback in queued change');
    },f.file);
    const good=transact(async state=>{
      events.push('good-start');
      assert.notEqual(state.objective,'not committed');
      state.objective='committed after rollback';
      state.revision++;
      return state;
    },f.file);
    const result=await Promise.allSettled([bad,good]);
    assert.equal(result[0].status,'rejected');
    assert.match(result[0].reason.message,/intentional rollback/);
    assert.equal(result[1].status,'fulfilled');
    assert.deepEqual(events,['bad-start','good-start']);
    assert.equal((await readState(f.file)).objective,'committed after rollback');
    const third=await transact(state=>{state.revision++;return state;},f.file);
    assert.equal(third.revision,2);
  }finally{await f.cleanup();}
});
