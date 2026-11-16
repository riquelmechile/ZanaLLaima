import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture,readDiff,sha} from './helpers/remote-fixture.mjs';
import {makePlan} from './helpers/plan-fixture.mjs';
import {remoteRead,remoteWrite,transact} from '../src/store.mjs';
import {loadRun,saveRun} from '../src/project-run-store.mjs';
import {claimMilestone,completePart} from '../src/project-orchestrator.mjs';

const gh={repo:'o/r',base:'main'};
const lenses=['risk','readability','reliability','resilience'];
const summary={done:'Hito integrado y revisado correctamente',decisions:[],conventions:[],pending:[],keyFiles:['src/x.mjs']};
const count=()=>remoteRead(db=>db.prepare('SELECT COUNT(*) n FROM remote_missions').get().n);
const run=f=>f.call('zana_project_next',{repo:'o/r'},f.owner);
async function setup(f){
  f.owner=await f.session();
  let w=await f.call('zana_workspace_create',{idea:'Crear un sistema de hitos extensible'},f.owner);
  w=await f.call('zana_workspace_update',{workspaceId:w.workspaceId,expectedVersion:0,
    answers:{goal:'Gestionar hitos',users:'Equipos',platform:'Web',features:'Planes',data:'Sin secretos'}},f.owner);
  w=await f.call('zana_workspace_update',{workspaceId:w.workspaceId,expectedVersion:1,plan:makePlan(w.brief)},f.owner);
  const a=await f.call('zana_plan_approval_request',{workspaceId:w.workspaceId,expectedVersion:w.version},f.owner);
  f.runtime.planApproval.decide({approvalId:a.approvalId,decision:'allow',passwordOk:true});
  const started=await f.call('zana_project_run_start',{workspaceId:w.workspaceId,...gh},f.owner);
  assert.equal(started.created,true,started.error);
  return started;
}
const init=(f,extra={},s=f.owner)=>f.call('zana_mission_init',{spec:f.spec,github:gh,...extra},s);
async function approvedMerge(f,mission,pr=7,commit='a',options={}){
  const s=f.owner,batch=await f.call('zana_start_batch',{},s);
  assert.equal(batch.error,undefined,batch.error);
  const packet=batch.packets[0];
  f.api.state.push(mission.github.branch,sha(commit));
  f.api.state.green(sha(commit));f.api.state.openPull(mission.github.branch,pr);
  const done=await f.call('zana_complete_unit',{unitId:packet.unitId,token:packet.token,
    leaseGeneration:packet.leaseGeneration,outcome:{success:true,summary:'código validado',evidence:['CI verde']}},s);
  assert.equal(done.error,undefined,done.error);
  const req=await f.call('zana_review_request',{missionId:mission.id},s);
  assert.equal(req.error,undefined,req.error);
  const reviewer=await f.session();
  assert.equal((await f.call('zana_review_claim',{ticket:req.ticket},reviewer)).error,undefined);
  await readDiff(f.call,req.ticket,reviewer);
  for(const lens of lenses)assert.equal((await f.call('zana_review_lens_submit',
    {ticket:req.ticket,lens,findings:[],evidence:['Diff completo revisado']},reviewer)).error,undefined);
  assert.equal((await f.call('zana_review_finalize',
    {ticket:req.ticket,execution:'SEQUENTIAL_SAME_CONVERSATION'},reviewer)).state,'FINALIZED');
  const notes=(await f.call('zana_start_batch',{},s)).packets[0];
  await f.call('zana_complete_unit',{unitId:notes.unitId,token:notes.token,
    leaseGeneration:notes.leaseGeneration,outcome:{success:true,summary:'notas',evidence:['listo']}},s);
  if(options.lose)f.api.state.loseMergeResponse=true;
  return f.call('zana_merge',{missionId:mission.id},s);
}

test('init: corrida activa exige hito, valida cliente, base, exclusión y no deja misiones huérfanas',async()=>{
  const f=await remoteFixture();
  try{
    await setup(f);
    let v=await init(f);assert.match(v.error,/RUN_MILESTONE_REQUIRED.*core/);
    assert.equal(await count(),0);
    v=await init(f,{milestone:{id:'no-listo',final:true}});
    assert.match(v.error,/MILESTONE_NOT_READY/);assert.equal(await count(),0);
    v=await init(f,{milestone:{id:'core',final:true},outsidePlan:'Trabajo adicional documentado'});
    assert.match(v.error,/INVALID_ARGUMENTS/);assert.equal(await count(),0);
    v=await init(f,{outsidePlan:'Trabajo adicional documentado'},await f.session('zana-chatgpt','otro'));
    assert.match(v.error,/RUN_OTHER_CLIENT/);assert.equal(await count(),0);
    v=await f.call('zana_mission_init',{spec:f.spec,github:{repo:'o/r',base:'dev'},
      milestone:{id:'core',final:true}},f.owner);
    assert.match(v.error,/RUN_REPO_MISMATCH/);assert.equal(await count(),0);
    const m=await init(f,{milestone:{id:'core',final:false}});
    assert.equal(m.error,undefined,m.error);
    assert.deepEqual([m.run.milestoneId,m.run.final,m.run.outsidePlan],[ 'core',false,false ]);
    assert.equal((await run(f)).milestones[0].status,'RUNNING');
    const stored=await remoteRead(db=>loadRun(db,m.memory.projectId).milestones[0].running);
    assert.equal(stored.baseSha,sha('0'));
    assert.match(JSON.stringify(m.memory.context),/En curso/);
  }finally{await f.cleanup();}
});

test('init: plan externo, proyecto sin corrida y fallback cuando falla el puntero',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session();
    const ordinary=await init(f,{},s);
    assert.equal(ordinary.error,undefined,ordinary.error);
    await f.call('zana_mission_cancel',{},s);
    await f.call('zana_mission_archive',{},s);
    await setup(f);
    f.api.state.failNext={status:503,message:'down'};
    assert.match((await init(f)).error,/RUN_MILESTONE_REQUIRED/);
    const ext=await init(f,{outsidePlan:'Corrección urgente fuera del plan'});
    assert.equal(ext.error,undefined,ext.error);
    assert.equal(ext.run.outsidePlan,true);
    const next=await run(f);
    assert.equal(next.milestones[0].status,'PENDING');
    assert.equal(await remoteRead(db=>loadRun(db,ext.memory.projectId).outsidePlan.length),1);
  }finally{await f.cleanup();}
});

test('merge: parcial, cierre final, memoria retirada, reintento y recuperación',async()=>{
  const f=await remoteFixture();
  try{
    await setup(f);
    let m=await init(f,{milestone:{id:'core',final:false}});
    let merged=await approvedMerge(f,m,7,'a',{lose:true});
    assert.equal(merged.state,'MERGED',merged.error);
    assert.ok(merged.run,'Falta integración de merge en corrida');
    assert.deepEqual([merged.run.recorded,merged.run.status],[true,'PARTIAL']);
    let next=await run(f);assert.equal(next.milestones[0].status,'PARTIAL');
    assert.match(JSON.stringify(next.memory),/Parcial/);
    const again=await f.call('zana_merge',{missionId:m.id},f.owner);
    assert.equal(again.run.already,true,again.error);
    const closed=await f.call('zana_mission_close',{summary},f.owner);
    assert.equal(closed.error,undefined,closed.error);
    const archived=await f.call('zana_mission_archive',{},f.owner);
    assert.equal(archived.error,undefined,archived.error);
    m=await init(f,{milestone:{id:'core',final:true}});
    assert.equal(m.error,undefined,m.error);
    const secondMerge=f.runtime.github.merge.bind(f.runtime.github);
    f.runtime.github.merge=async(...args)=>({...await secondMerge(...args),sha:sha('8')});
    merged=await approvedMerge(f,m,8,'b');
    assert.equal(merged.state,'MERGED',merged.error);
    assert.deepEqual([merged.run.status,merged.run.runStatus],['DONE','READY_TO_DELIVER']);
    next=await run(f);
    assert.equal(next.milestones[0].status,'DONE');
    assert.equal(next.status,'READY_TO_DELIVER');
    assert.equal(next.memory.entries.some(x=>x.kind==='pending'&&x.topic.startsWith('hito:')),false);
  }finally{await f.cleanup();}
});

test('merge: SHA recuperable, ausencia de SHA y fallo de la máquina no invalidan merge',async()=>{
  for(const scenario of ['fallback','missing','duplicate']){
    const f=await remoteFixture();
    try{
      const started=await setup(f);
      const m=await init(f,{milestone:{id:'core',final:true}});
      const original=f.runtime.github.merge.bind(f.runtime.github);
      f.runtime.github.merge=async(...args)=>{const result=await original(...args);
        return {...result,sha:null};};
      if(scenario==='missing'){
        const pull=f.runtime.github.pull.bind(f.runtime.github);
        f.runtime.github.pull=async(...args)=>({...await pull(...args),merge_commit_sha:null});
      }
      if(scenario==='duplicate'){
        await remoteWrite(db=>{
          const r=loadRun(db,started.projectId);
          const existing=structuredClone(r);
          existing.milestones[0].running=null;
          existing.milestones[0].status='PARTIAL';
          existing.milestones[0].parts=[{missionId:'otra-mision',prNumber:7,headSha:sha('c'),
            mergeCommitSha:sha('d'),final:false,at:new Date().toISOString()}];
          existing.milestones[0].running=r.milestones[0].running;
          existing.milestones[0].status='RUNNING';
          existing.revision=r.revision+1;
          saveRun(db,r,existing);
        });
      }
      const merged=await approvedMerge(f,m);
      assert.equal(merged.state,'MERGED',merged.error);
      assert.ok(merged.run,'Falta campo run en merge');
      if(scenario==='fallback')assert.equal(merged.run.recorded,true);
      else {
        assert.equal(merged.run.recorded,false);
        assert.equal(merged.run.reason,scenario==='missing'?'MERGE_SHA_UNKNOWN':'DUPLICATE_PR');
        if(scenario==='duplicate')assert.ok((await f.runtime.readAudit({missionId:m.id,limit:100}))
          .some(x=>x.category==='project_run'&&JSON.stringify(x).includes('DUPLICATE_PR')));
      }
    }finally{await f.cleanup();}
  }
});

test('cancel: libera hito, registra intento/rondas; revisora no puede cancelar ni queda marcada',async()=>{
  const f=await remoteFixture();
  try{
    const start=await setup(f),m=await init(f,{milestone:{id:'core',final:false}});
    const packet=(await f.call('zana_start_batch',{},f.owner)).packets[0];
    f.api.state.push(m.github.branch,sha('a'));
    f.api.state.green(sha('a'));f.api.state.openPull(m.github.branch);
    assert.equal((await f.call('zana_complete_unit',{unitId:packet.unitId,token:packet.token,
      leaseGeneration:packet.leaseGeneration,outcome:{success:true,summary:'código',evidence:['CI verde']}},f.owner)).error,undefined);
    const req=await f.call('zana_review_request',{missionId:m.id},f.owner);
    assert.equal(req.error,undefined,req.error);
    const reviewer=await f.session();
    assert.equal((await f.call('zana_review_claim',{ticket:req.ticket},reviewer)).error,undefined);
    assert.match((await f.call('zana_mission_cancel',{},reviewer)).error,/REVIEWER_READ_ONLY/);
    assert.equal((await f.call('zana_session_status',{},reviewer)).writerMarked,false);
    const cancel=await f.call('zana_mission_cancel',{},f.owner);
    assert.ok(cancel.run,'Falta campo run en cancelación');
    assert.equal(cancel.run.released,true,cancel.error);
    const next=await run(f);
    assert.equal(next.milestones[0].status,'PENDING');
    assert.match(JSON.stringify(next.memory),/Intento fallido/);
    assert.match(JSON.stringify(await remoteRead(db=>loadRun(db,start.projectId).milestones[0].attempts)),/Misión cancelada/);
    await f.call('zana_mission_archive',{},f.owner);
    const second=await init(f,{milestone:{id:'core',final:true}});
    await transact(mission=>{mission.reviewCount=mission.budget.maxReviewRounds;return mission;});
    const closed=await f.call('zana_mission_cancel',{},f.owner);
    assert.equal(closed.run.released,true,closed.error);
    assert.match(JSON.stringify(await remoteRead(db=>loadRun(db,start.projectId).milestones[0].attempts)),/rondas de revisión agotadas/);
    assert.ok(second.id);assert.ok(reviewer.sessionId);
  }finally{await f.cleanup();}
});

test('marca dirty: claim repara proyección, sin reescribir memoria de sesión',async()=>{
  const f=await remoteFixture();
  try{
    const started=await setup(f);
    await remoteWrite(db=>db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)')
      .run('zana:run-memory-dirty:'+started.projectId,new Date().toISOString()));
    const m=await init(f,{milestone:{id:'core',final:true}});
    assert.equal(m.error,undefined,m.error);
    const next=await run(f);
    assert.equal(next.memoryStale,false);
    assert.match(JSON.stringify(next.memory),/En curso/);
  }finally{await f.cleanup();}
});
