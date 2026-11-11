import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture,sha} from './helpers/remote-fixture.mjs';

test('CI de repo: dispara workflow propio, exige sus jobs y preserva SHA',async()=>{
  const envExtra={ZANA_REPO_CHECKS_JSON:JSON.stringify({'o/r':{
    workflow:'zana-python.yml',requiredChecks:['pytest']}})};
  const f=await remoteFixture({envExtra});
  try{
    const {author,missionId,branch,packet}=await f.authorReady({green:false});
    const check=await f.call('zana_checks_start',{missionId},author);
    assert.equal(check.workflow,'zana-python.yml');
    assert.equal(check.sha,sha('a'));
    assert.deepEqual(f.api.state.dispatches,[{workflow:'zana-python.yml',ref:branch}]);
    f.api.state.green(sha('a'),'test');
    const missing=await f.call('zana_checks_status',{checkId:check.checkId},author);
    assert.equal(missing.state,'PENDING');
    assert.deepEqual(missing.missing,['pytest']);
    f.api.state.green(sha('a'),'pytest');
    const green=await f.call('zana_checks_status',{checkId:check.checkId},author);
    assert.equal(green.state,'SUCCESS');
    assert.equal(green.sha,sha('a'));
    const done=await f.call('zana_complete_unit',{unitId:'code',token:packet.token,
      leaseGeneration:packet.leaseGeneration,outcome:{success:true,summary:'CI por repo',evidence:['pytest verde'] }},author);
    assert.equal(done.error,undefined);
  }finally{await f.cleanup();}
});
