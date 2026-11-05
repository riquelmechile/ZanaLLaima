import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {remoteFixture} from './helpers/remote-fixture.mjs';
import {transact} from '../src/store.mjs';
import {createMission} from '../src/core.mjs';
import {startRemote,httpSettings} from '../src/http.mjs';

test('remote mission init: allowlisted repo, READ units, code units recorded, one mission at a time',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session();
    const init=args=>f.call('zana_mission_init',args,s);
    assert.match((await init({spec:f.spec,github:{repo:'x/y',base:'main'}})).error,/REPO_NOT_ALLOWED/);
    assert.match((await init({spec:f.spec,github:{repo:'o/r',base:'a..b'}})).error,/Invalid base/);
    const write={...f.spec,units:[{id:'w',effect:'WRITE',paths:['a'],instruction:'x'}]};
    assert.match((await init({spec:write,github:{repo:'o/r',base:'main'}})).error,/Remote missions use READ units/);
    assert.match((await init({spec:{objective:'xyz'},github:{repo:'o/r',base:'main'}})).error,/between 1 and 100/);
    const ok=await init({spec:f.spec,github:{repo:'O/R',base:'main'}});
    assert.deepEqual(ok.codeUnits,['code']);
    assert.equal(ok.github.branch,'zana/'+ok.id);
    assert.match((await init({spec:f.spec,github:{repo:'o/r',base:'main'}})).error,/Mission exists/);
    assert.equal((await f.call('zana_mission_status',{},s)).id,ok.id);
    assert.equal((await f.call('zana_profile',{},s)).assurance,'REQUESTED_ONLY');
    assert.equal((await f.call('zana_capability_status',{},s)).verified.model,null);
    assert.ok((await f.call('zana_next_batch',{},s)).units.length);
    assert.ok(Array.isArray((await f.call('zana_mission_history',{},s)).items));
    const st=await f.call('zana_session_status',{},s);
    assert.equal(st.activeMission.wrote,true);
    assert.equal(st.activeMission.remote.repo,'O/R');
    // Lifecycle wrappers record activity and pass through.
    assert.ok((await f.call('zana_recover_expired',{},s)).changed!==undefined);
    assert.match((await f.call('zana_unit_retry',{unitId:'code'},s)).error,/./);
    assert.equal((await f.call('zana_mission_cancel',{},s)).state??'CANCELLED','CANCELLED');
    assert.match((await f.call('zana_mission_close',{},s)).error,/./);
    assert.match((await f.call('zana_delivery_status',{missionId:'00000000-0000-0000-0000-000000000000'},s)).error,/UNKNOWN_MISSION/);
    assert.match((await f.call('zana_checks_start',{missionId:ok.id},s)).error,/MISSION_NOT_ACTIVE/);
    assert.equal((await f.runtime.dispatch('zana_nope',{},s)).isError,true);
  }finally{await f.cleanup();}
});

test('a mission created outside remote mode cannot be driven remotely',async()=>{
  const f=await remoteFixture();
  try{
    await transact(()=>createMission({objective:'local mission',units:[{id:'a',effect:'READ',instruction:'x'}]}));
    const s=await f.session();
    assert.match((await f.call('zana_start_batch',{},s)).error,/NOT_REMOTE_MISSION/);
    assert.match((await f.call('zana_complete_unit',{unitId:'a',token:'t'.repeat(10),outcome:{success:true,summary:'xxxxx',evidence:['e']}},s)).error,/UNKNOWN_MISSION/);
    const st=await f.call('zana_session_status',{},s);
    assert.equal(st.activeMission.remote,null);
  }finally{await f.cleanup();}
});

test('no mission: mutating tools fail cleanly',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session();
    assert.match((await f.call('zana_start_batch',{},s)).error,/No mission initialized/);
    assert.match((await f.call('zana_complete_unit',{unitId:'a',token:'t'.repeat(10),outcome:{success:true,summary:'xxxxx',evidence:['e']}},s)).error,/No mission initialized/);
    assert.equal((await f.call('zana_session_status',{},s)).activeMission,null);
  }finally{await f.cleanup();}
});

test('startRemote listens on 127.0.0.1 and serves /health',async()=>{
  const f=await remoteFixture();
  const port=await new Promise(ok=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>ok(p));});});
  assert.throws(()=>httpSettings({ZANA_HTTP_PORT:'0'}),/ZANA_HTTP_PORT/);
  const started=await startRemote({...f.env,ZANA_HTTP_PORT:String(port),ZANA_OAUTH_DB:join(f.dir,'o.sqlite'),
    ZANA_OAUTH_CONSENT_PASSWORD:'p'.repeat(40),ZANA_PUBLIC_HOST:'zanallaima.test'});
  try{
    assert.equal(started.settings.bind,'127.0.0.1');
    assert.equal(started.settings.publicUrl,'https://zanallaima.test/mcp');
    const health=await (await fetch('http://127.0.0.1:'+port+'/health')).json();
    assert.equal(health.status,'ok');
  }finally{
    started.server.closeAllConnections();
    await new Promise(ok=>started.server.close(ok));
    started.oauth.close();await started.runtime.close();await f.cleanup();
  }
});
