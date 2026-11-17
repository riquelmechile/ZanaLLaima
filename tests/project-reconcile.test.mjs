import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture,sha,REVIEWER_LOGIN,readDiff} from './helpers/remote-fixture.mjs';
import {makePlan} from './helpers/plan-fixture.mjs';
import {remoteRead,remoteWrite,transact} from '../src/store.mjs';
import {loadRun} from '../src/project-run-store.mjs';
import {cancelMission} from '../src/lifecycle.mjs';

const gh={repo:'o/r',base:'main'};
async function setup(f){
  f.owner=await f.session();
  let w=await f.call('zana_workspace_create',{idea:'Sistema de hitos de equipo'},f.owner);
  w=await f.call('zana_workspace_update',{workspaceId:w.workspaceId,expectedVersion:0,
    answers:{goal:'Gestionar hitos',users:'Equipos',platform:'Web',features:'Planes',data:'Sin secretos'}},f.owner);
  w=await f.call('zana_workspace_update',{workspaceId:w.workspaceId,expectedVersion:1,plan:makePlan(w.brief)},f.owner);
  const a=await f.call('zana_plan_approval_request',{workspaceId:w.workspaceId,expectedVersion:w.version},f.owner);
  f.runtime.planApproval.decide({approvalId:a.approvalId,decision:'allow',passwordOk:true});
  return f.call('zana_project_run_start',{workspaceId:w.workspaceId,...gh},f.owner);
}
const init=(f,final=true)=>f.call('zana_mission_init',{spec:f.spec,github:gh,milestone:{id:'core',final}},f.owner);
const reconcile=(f,started,id,extra={})=>f.call('zana_project_reconcile',
  {repo:gh.repo,expectedRevision:started.revision,milestoneId:'core',missionId:id,final:true,action:'attach',...extra},f.owner);
function proof(f,id,number=7,{merged=true,approved=true,green=true}={}){
  const branch='zana/'+id;f.api.state.push(branch,sha('a'));f.api.state.openPull(branch,number);
  const pull=f.api.state.pulls.at(-1);
  pull.state=merged?'closed':'open';pull.merged=merged;pull.merged_at=merged?'2026-11-17T00:00:00Z':null;
  pull.merge_commit_sha=merged?sha('9'):null;
  if(approved)f.api.state.reviews[number]=[{id:901,user:{login:REVIEWER_LOGIN},state:'APPROVED',commit_id:sha('a')}];
  if(green)f.api.state.green(sha('a'));
  return pull;
}
const run=f=>f.call('zana_project_next',{repo:gh.repo},f.owner);

test('C1: attach reconciles a human-merged PR with exact evidence and is idempotent',async()=>{
  const f=await remoteFixture();
  try{
    await setup(f);const m=await init(f);
    proof(f,m.id);
    const before=await run(f);
    const first=await reconcile(f,before,m.id);
    assert.equal(first.error,undefined,first.error);
    assert.equal(first.recorded,true);
    assert.equal(first.status,'DONE');
    assert.equal((await run(f)).status,'READY_TO_DELIVER');
    assert.deepEqual((await f.runtime.readAudit({missionId:m.id,limit:100})).find(x=>
      x.tool==='zana_project_reconcile.run'&&x.outcome==='SUCCESS')?.detail,
      {projectId:m.memory.projectId,milestoneId:'core',missionId:m.id,transition:'DONE'});
    const second=await reconcile(f,await run(f),m.id);
    assert.equal(second.already,true,second.error);
    const cancelled=await f.call('zana_mission_cancel',{},f.owner);
    assert.equal(cancelled.error,undefined,cancelled.error);
    assert.deepEqual(cancelled.run,{released:false,reason:'PART_RECORDED'});
  }finally{await f.cleanup();}
});

test('C1: attachPart registers a merged PR created before the run',async()=>{
  const f=await remoteFixture();
  try{
    await setup(f);
    proof(f,'previous-work');
    const before=await run(f);
    const result=await reconcile(f,before,'previous-work');
    assert.equal(result.error,undefined,result.error);
    assert.equal(result.recorded,true);
    assert.equal((await run(f)).milestones[0].status,'DONE');
  }finally{await f.cleanup();}
});

test('C1: fail-closed GitHub evidence and stale revision leave run untouched',async()=>{
  for(const [caseName,option,code] of [
    ['not-merged',{merged:false},'PR_NOT_MERGED'],
    ['no-review',{approved:false},'REVIEW_NOT_APPROVED'],
    ['no-ci',{green:false},'CI_NOT_GREEN']]){
    const f=await remoteFixture();
    try{
      await setup(f);const m=await init(f);proof(f,m.id,7,option);
      const before=await run(f);
      assert.match((await reconcile(f,before,m.id)).error??'',new RegExp(code),caseName);
      assert.equal((await run(f)).revision,before.revision);
      assert.equal((await run(f)).milestones[0].status,'RUNNING');
    }finally{await f.cleanup();}
  }
  const f=await remoteFixture();
  try{
    await setup(f);const m=await init(f);proof(f,m.id);
    const before=await run(f);
    assert.match((await reconcile(f,before,m.id,{expectedRevision:before.revision-1})).error??'',/STALE_REVISION/);
    assert.equal((await run(f)).revision,before.revision);
    const original=f.runtime.github.openPullsFor;
    f.runtime.github.openPullsFor=async()=>{throw Error('network down');};
    assert.match((await reconcile(f,before,m.id)).error??'',/GITHUB_UNAVAILABLE/);
    f.runtime.github.openPullsFor=original;
    const other=await f.session('zana-chatgpt','different-client');
    const args={repo:gh.repo,expectedRevision:before.revision,milestoneId:'core',missionId:m.id,final:true};
    assert.match((await f.call('zana_project_reconcile',args,other)).error??'',/RUN_OTHER_CLIENT/);
    assert.equal((await f.call('zana_session_status',{},other)).writerMarked,false);
  }finally{await f.cleanup();}
});

test('C1: release only inactive unmerged missions, never merged/active',async()=>{
  const f=await remoteFixture();
  try{
    await setup(f);const m=await init(f);
    const args={repo:gh.repo,expectedRevision:(await run(f)).revision,
      milestoneId:'core',missionId:m.id,final:true,action:'release'};
    assert.match((await f.call('zana_project_reconcile',args,f.owner)).error??'',/MISSION_ACTIVE/);
    const pull=proof(f,m.id,7,{merged:false});
    await transact(mission=>{cancelMission(mission);return mission;});
    pull.state='closed';pull.merged=true;pull.merged_at='2026-11-17T00:00:00Z';
    assert.match((await f.call('zana_project_reconcile',args,f.owner)).error??'',/PR_ALREADY_MERGED/);
    pull.state='open';pull.merged=false;pull.merged_at=null;
    const released=await f.call('zana_project_reconcile',args,f.owner);
    assert.equal(released.error,undefined,released.error);
    assert.equal(released.released,true);
    const before=await run(f);assert.equal(before.milestones[0].status,'PENDING');
    assert.match(JSON.stringify(await remoteRead(db=>loadRun(db,m.memory.projectId).milestones[0].attempts)),/OPERATOR_RELEASE/);
  }finally{await f.cleanup();}
});

test('C1: mission init rejects open PR of earlier attempt, permits closed and fails closed on GitHub outage',async()=>{
  const f=await remoteFixture();
  try{
    await setup(f);const m=await init(f);
    const pull=proof(f,m.id,7,{merged:false});
    const cancelled=await f.call('zana_mission_cancel',{},f.owner);
    assert.equal(cancelled.run.released,true,cancelled.error);
    await f.call('zana_mission_archive',{},f.owner);
    assert.match((await init(f)).error??'',/PRIOR_PR_OPEN/);
    const original=f.runtime.github.openPullsFor;
    f.runtime.github.openPullsFor=async()=>{throw Error('offline');};
    assert.match((await init(f)).error??'',/GITHUB_UNAVAILABLE/);
    f.runtime.github.openPullsFor=original;
    pull.state='closed';
    const next=await init(f);
    assert.equal(next.error,undefined,next.error);
  }finally{await f.cleanup();}
});

test('C1: AUDIT_UNAVAILABLE after successful merge can reconcile without re-merging',async()=>{
  const f=await remoteFixture();
  try{
    await setup(f);const m=await init(f);
    const batch=(await f.call('zana_start_batch',{},f.owner)).packets[0];
    f.api.state.push(m.github.branch,sha('a'));
    f.api.state.green(sha('a'));f.api.state.openPull(m.github.branch);
    assert.equal((await f.call('zana_complete_unit',{unitId:batch.unitId,token:batch.token,
      leaseGeneration:batch.leaseGeneration,outcome:{success:true,summary:'código',evidence:['CI verde']}},f.owner)).error,undefined);
    const request=await f.call('zana_review_request',{missionId:m.id},f.owner);
    assert.equal(request.error,undefined,request.error);
    const reviewer=await f.session();
    assert.equal((await f.call('zana_review_claim',{ticket:request.ticket},reviewer)).error,undefined);
    await readDiff(f.call,request.ticket,reviewer);
    for(const lens of ['risk','readability','reliability','resilience'])
      assert.equal((await f.call('zana_review_lens_submit',{ticket:request.ticket,lens,findings:[],
        evidence:['Diff íntegro revisado']},reviewer)).error,undefined);
    assert.equal((await f.call('zana_review_finalize',{ticket:request.ticket,
      execution:'SEQUENTIAL_SAME_CONVERSATION'},reviewer)).state,'FINALIZED');
    const notes=(await f.call('zana_start_batch',{},f.owner)).packets[0];
    await f.call('zana_complete_unit',{unitId:notes.unitId,token:notes.token,
      leaseGeneration:notes.leaseGeneration,outcome:{success:true,summary:'notas',evidence:['ok']}},f.owner);
    await remoteWrite(db=>db.exec("CREATE TRIGGER deny_merge_result BEFORE INSERT ON remote_audit WHEN NEW.tool='zana_merge.result' BEGIN SELECT RAISE(ABORT,'AUDIT_DENIED'); END"));
    const merged=await f.call('zana_merge',{missionId:m.id},f.owner);
    assert.equal(merged.state,'MERGED',merged.error);
    assert.equal(merged.run.reason,'AUDIT_UNAVAILABLE');
    const before=await run(f);
    const denied=await f.call('zana_project_reconcile',{repo:gh.repo,expectedRevision:before.revision,
      milestoneId:'core',missionId:m.id,final:true},reviewer);
    assert.match(denied.error??'',/REVIEWER_READ_ONLY/);
    assert.equal((await f.call('zana_session_status',{},reviewer)).writerMarked,false);
    const fixed=await reconcile(f,before,m.id);
    assert.equal(fixed.recorded,true,fixed.error);
    assert.equal(fixed.status,'DONE');
  }finally{await f.cleanup();}
});

test('C1 5d: cancel auditado exige PR fusionado con SHA idéntico',async()=>{
  for(const bad of ['merged','sha']){
    const f=await remoteFixture();
    try{
      await setup(f);const m=await init(f);const pull=proof(f,m.id);
      const at=new Date().toISOString();
      await remoteWrite(db=>{
        db.prepare('INSERT INTO review_tickets(ticket_id,code_hash,mission_id,repo,pr_number,sha,author_session,created_at,expires_at,state,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run('ticket-'+bad,'hash-'+bad,m.id,gh.repo,7,sha('a'),'owner',at,at,'FINALIZED',at);
        db.prepare('INSERT INTO remote_audit(at,tool,mission_id,outcome,detail) VALUES(?,?,?,?,?)')
          .run(at,'zana_merge.result',m.id,'MERGED',JSON.stringify({headSha:sha('a'),mergeCommitSha:sha('9')}));
      });
      if(bad==='merged'){pull.merged=false;pull.merged_at=null;}
      else pull.head.sha=sha('b');
      assert.match((await f.call('zana_mission_cancel',{},f.owner)).error??'',/MERGE_EVIDENCE_MISMATCH/,bad);
      assert.equal((await run(f)).milestones[0].status,'RUNNING');
    }finally{await f.cleanup();}
  }
});
test('C1 5f: cancel exige PR fusionado en rama exacta y lock',async()=>{
  const f=await remoteFixture();
  try{
    await setup(f);const m=await init(f);
    f.api.state.push(m.github.branch,sha('a'));f.api.state.openPull(m.github.branch,16);
    f.api.state.push('otra/rama',sha('b'));f.api.state.openPull('otra/rama',17);
    Object.assign(f.api.state.pulls.at(-1),{state:'closed',merged:true,merged_at:'2026-11-17T00:00:00Z'});
    f.api.state.openPull(m.github.branch,18);
    Object.assign(f.api.state.pulls.at(-1),{state:'closed',merged:true,merged_at:'2026-11-17T00:00:00Z'});
    const seen=[];let locked=0;
    const pull=f.runtime.github.pull.bind(f.runtime.github);
    f.runtime.github.pull=async(repo,n)=>{seen.push(n);return pull(repo,n);};
    const lock=f.runtime.review.withMissionLock.bind(f.runtime.review);
    f.runtime.review.withMissionLock=async(...a)=>{locked++;return lock(...a);};
    assert.match((await f.call('zana_mission_cancel',{},f.owner)).error??'',/PR_ALREADY_MERGED/);
    assert.deepEqual(seen,[18]);assert.equal(locked,1);
  }finally{await f.cleanup();}
});
