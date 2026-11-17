import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture,readDiff,sha} from './helpers/remote-fixture.mjs';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {makePlan} from './helpers/plan-fixture.mjs';
import {remoteRead,remoteWrite,transact} from '../src/store.mjs';
import {loadRun,saveRun} from '../src/project-run-store.mjs';
import {claimMilestone,recordOutsidePlan,cancelProjectRun} from '../src/project-orchestrator.mjs';

const gh={repo:'o/r',base:'main'};
const lenses=['risk','readability','reliability','resilience'];
const summary={done:'Hito integrado y revisado correctamente',decisions:[],conventions:[],pending:[],keyFiles:['src/x.mjs']};
const count=()=>remoteRead(db=>db.prepare('SELECT COUNT(*) n FROM remote_missions').get().n);
function fakeAllPulls(f){
  const original=f.runtime.github.openPullsFor.bind(f.runtime.github),states=[];
  f.runtime.github.openPullsFor=(repo,branch,state='open')=>{
    states.push(state);
    return state==='all'
      ?Promise.resolve(f.api.state.pulls.filter(p=>p.head.ref===branch))
      :original(repo,branch,state);
  };
  return states;
}
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
    assert.match(m.memory.context.entries.find(x=>x.topic==='hito:core')?.body??'',/En curso/);
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
    assert.deepEqual((await f.runtime.readAudit({missionId:ext.id,limit:100})).find(x=>x.tool==='zana_mission_init.run'&&x.outcome==='SUCCESS')?.detail,
      {projectId:ext.memory.projectId,milestoneId:null,transition:'OUTSIDE_PLAN'});
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
    assert.match(next.memory.entries.find(x=>x.topic==='hito:core')?.body??'',/Parcial/);
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
        if(scenario==='missing')assert.equal((await f.runtime.readAudit({missionId:m.id,limit:100})).find(x=>x.tool==='zana_merge.run'&&x.outcome==='ERROR')?.detail?.code,'MERGE_SHA_UNKNOWN');
        if(scenario==='duplicate')assert.equal((await f.runtime.readAudit({missionId:m.id,limit:100})).find(x=>x.tool==='zana_merge.run'&&x.outcome==='ERROR')?.detail?.code,'DUPLICATE_PR');
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
    assert.match((await f.call('zana_project_run_cancel',{repo:gh.repo,
      expectedRevision:(await run(f)).revision,reason:'Cancelación de corrida solicitada'},reviewer)).error,
    /REVIEWER_READ_ONLY/);
    assert.match((await init(f,{milestone:{id:'core',final:true}},reviewer)).error,/REVIEWER_READ_ONLY/);
    assert.equal((await f.call('zana_session_status',{},reviewer)).writerMarked,false);
    const cancel=await f.call('zana_mission_cancel',{},f.owner);
    assert.ok(cancel.run,'Falta campo run en cancelación');
    assert.equal(cancel.run.released,true,cancel.error);
    const next=await run(f);
    assert.equal(next.milestones[0].status,'PENDING');
    assert.match(next.memory.entries.find(x=>x.topic==='hito:core')?.body??'',/Intento fallido/);
    assert.match((await remoteRead(db=>loadRun(db,start.projectId).milestones[0].attempts.at(-1)?.reason))??'',/Misión cancelada/);
    await f.call('zana_mission_archive',{},f.owner);
    const beforeRetry=await count();
    assert.match((await init(f,{milestone:{id:'core',final:true}})).error,/PRIOR_PR_OPEN/);
    assert.equal(await count(),beforeRetry);
    Object.assign(f.api.state.pulls.at(-1),{state:'closed',merged:false});
    const second=await init(f,{milestone:{id:'core',final:true}});
    await transact(mission=>{mission.reviewCount=mission.budget.maxReviewRounds;return mission;});
    const closed=await f.call('zana_mission_cancel',{},f.owner);
    assert.equal(closed.run.released,true,closed.error);
    assert.match((await remoteRead(db=>loadRun(db,start.projectId).milestones[0].attempts.at(-1)?.reason))??'',/rondas de revisión agotadas/);
    assert.match((await remoteRead(db=>loadRun(db,start.projectId).milestones[0].attempts.at(-1)?.reason))??'',/REVIEW_ROUNDS_EXHAUSTED/);
    assert.equal(second.error,undefined,second.error);assert.equal(second.run.milestoneId,'core');assert.equal(second.run.final,true);
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
    assert.match(next.memory.entries.find(x=>x.topic==='hito:core')?.body??'',/En curso/);
  }finally{await f.cleanup();}
});

test('merge exitoso con RUN_CORRUPT conserva resultado y deja auditoría project_run',async()=>{
  const f=await remoteFixture();
  try{
    const started=await setup(f),m=await init(f,{milestone:{id:'core',final:true}});
    const merge=f.runtime.github.merge.bind(f.runtime.github);
    f.runtime.github.merge=async(...args)=>{const result=await merge(...args);
      await remoteWrite(db=>db.prepare('UPDATE metadata SET value=? WHERE key=?').run('{corrupt','zana:run:'+started.projectId));
      return result;};
    const result=await approvedMerge(f,m);
    assert.equal(result.error,undefined);assert.equal(result.state,'MERGED');
    assert.equal(result.merged,true);assert.deepEqual(result.run,{recorded:false,reason:'RUN_CORRUPT'});
    assert.equal((await f.runtime.readAudit({missionId:m.id,limit:100})).find(x=>x.tool==='zana_merge.run'&&x.outcome==='ERROR')?.detail?.code,'RUN_CORRUPT');
  }finally{await f.cleanup();}
});

test('auditoría project_run en claim, outsidePlan, parte y liberación; memoria de saveRun visible',async()=>{
  const f=await remoteFixture();
  try{
    await setup(f);
    let m=await init(f,{milestone:{id:'core',final:false}});
    assert.equal((await f.runtime.readAudit({missionId:m.id,limit:100})).find(x=>x.tool==='zana_mission_init.run'&&x.outcome==='SUCCESS')?.detail?.milestoneId,'core');
    await approvedMerge(f,m);
    assert.deepEqual((await f.runtime.readAudit({missionId:m.id,limit:100})).find(x=>x.tool==='zana_merge.run'&&x.outcome==='SUCCESS')?.detail,
      {projectId:m.memory.projectId,milestoneId:'core',transition:'PARTIAL'});
    await f.call('zana_mission_close',{summary},f.owner);
    await f.call('zana_mission_archive',{},f.owner);
    m=await init(f,{milestone:{id:'core',final:true}});
    assert.equal(m.error,undefined);
    await remoteWrite(db=>db.exec("CREATE TRIGGER reject_run_memory BEFORE INSERT ON project_memory BEGIN SELECT RAISE(ABORT,'NO_MEMORY'); END"));
    const cancelled=await f.call('zana_mission_cancel',{},f.owner);
    assert.equal(cancelled.run.released,true,cancelled.error);
    assert.match(cancelled.run.memoryError,/MEMORY_UNAVAILABLE/);
    assert.equal((await f.runtime.readAudit({missionId:m.id,limit:100})).find(x=>x.tool==='zana_mission_cancel.run'&&x.outcome==='ERROR')?.detail?.code,'MEMORY_UNAVAILABLE');
  }finally{await f.cleanup();}
});

test('init: rechazos no marcan escritora, carrera relee corrida y valida entrada',async()=>{
  const f=await remoteFixture();
  try{
    const outside=await f.session();
    assert.match((await init(f,{milestone:{id:'core',final:true}},outside)).error,/RUN_NOT_FOUND/);
    assert.match((await init(f,{outsidePlan:'Trabajo legítimo sin corrida'},outside)).error,/RUN_NOT_FOUND/);
    assert.equal((await f.call('zana_session_status',{},outside)).writerMarked,false);
    const started=await setup(f),intruder=await f.session('zana-chatgpt','other-client');
    assert.match((await init(f,{milestone:{id:'core',final:true}},intruder)).error,/RUN_OTHER_CLIENT/);
    assert.equal((await f.call('zana_session_status',{},intruder)).writerMarked,false);
    assert.match((await init(f,{outsidePlan:'Trabajo excepcional válido'},intruder)).error,/RUN_OTHER_CLIENT/);
    assert.equal((await f.call('zana_session_status',{},intruder)).writerMarked,false);
    assert.match((await init(f,{milestone:{id:'CORE',final:true}})).error,/invalid|regex|format/i);
    assert.match((await init(f,{milestone:{id:'a'.repeat(49),final:true}})).error,/INVALID_ID|large|long|max|48/i);
    const original=f.runtime.github.branchHead.bind(f.runtime.github);
    let triggered=false;
    f.runtime.github.branchHead=async(...args)=>{if(!triggered){triggered=true;
      await remoteWrite(db=>{const r=loadRun(db,started.projectId);
        saveRun(db,r,recordOutsidePlan(r,{missionId:'another-task',reason:'Trabajo adicional simultáneo',now:new Date().toISOString()}));});
    }return original(...args);};
    const claim=await init(f,{milestone:{id:'core',final:true}});
    assert.equal(claim.error,undefined,claim.error);
    assert.equal((await remoteRead(db=>loadRun(db,started.projectId))).outsidePlan.length,1);
    assert.equal((await remoteRead(db=>loadRun(db,started.projectId))).revision,2);
  }finally{await f.cleanup();}
});

test('outsidePlan no modifica el hito RUNNING de otra misión en merge ni cancel',async()=>{
  for(const operation of ['merge','cancel']){
    const f=await remoteFixture();
    try{
      const started=await setup(f),m=await init(f,{outsidePlan:'Corrección documentada fuera del plan'});
      await remoteWrite(db=>{const r=loadRun(db,started.projectId);
        saveRun(db,r,claimMilestone(r,{missionId:'other-task',milestoneId:'core',final:true,baseSha:sha('0'),now:new Date().toISOString()}));});
      const result=operation==='merge'?await approvedMerge(f,m):await f.call('zana_mission_cancel',{},f.owner);
      assert.equal(result.error,undefined,result.error);
      assert.equal(result.run,undefined);
      const runNow=await remoteRead(db=>loadRun(db,started.projectId));
      assert.equal(runNow.milestones[0].running.missionId,'other-task');
      assert.equal(runNow.milestones[0].status,'RUNNING');
    }finally{await f.cleanup();}
  }
});

test('no-merge no altera hito; falla branchHead no crea misión',async()=>{
  const f=await remoteFixture();
  try{
    await setup(f);
    const branch=f.runtime.github.branchHead.bind(f.runtime.github);
    f.runtime.github.branchHead=async()=>{throw new Error('unavailable');};
    assert.match((await init(f,{milestone:{id:'core',final:true}})).error,/GITHUB_UNAVAILABLE/);
    assert.equal(await count(),0);
    f.runtime.github.branchHead=branch;
    const m=await init(f,{milestone:{id:'core',final:true}});
    const before=await run(f);
    const rejected=await f.call('zana_merge',{missionId:m.id},f.owner);
    assert.notEqual(rejected.state,'MERGED');
    assert.equal(rejected.run,undefined);
    assert.equal((await f.runtime.readAudit({missionId:m.id,limit:100})).filter(x=>x.tool==='zana_merge.run'&&x.outcome==='ERROR').length,0);
    const after=await run(f);
    assert.equal(after.revision,before.revision);
    assert.equal(after.milestones[0].status,'RUNNING');
  }finally{await f.cleanup();}
});

test('cancel mantiene misión CANCELLED aun si falla releaseMilestone',async()=>{
  const f=await remoteFixture();
  try{
    const started=await setup(f),m=await init(f,{milestone:{id:'core',final:true}});
    await remoteWrite(db=>{const r=loadRun(db,started.projectId);
      saveRun(db,r,recordOutsidePlan(r,{missionId:'time-shift',reason:'Cambio temporal intencional',now:'2099-01-01T00:00:00.000Z'}));});
    const result=await f.call('zana_mission_cancel',{},f.owner);
    assert.equal(result.error,undefined,result.error);
    assert.equal(result.status,'CANCELLED');
    assert.deepEqual(result.run,{released:false,reason:'INVALID_TIME'});
    assert.deepEqual((await f.runtime.readAudit({missionId:m.id,limit:100})).find(x=>x.tool==='zana_mission_cancel.run'&&x.outcome==='ERROR')?.detail,
      {projectId:started.projectId,code:'INVALID_TIME'});
  }finally{await f.cleanup();}
});

test('corrida cancelada rechaza milestone; SHA obsoleto no registra parte',async()=>{
  const f=await remoteFixture();
  try{
    const started=await setup(f);
    await remoteWrite(db=>{const r=loadRun(db,started.projectId);saveRun(db,r,cancelProjectRun(r,{reason:'Cancelar la corrida para validar init',now:new Date().toISOString()}));});
    assert.match((await init(f,{milestone:{id:'core',final:true}})).error,/RUN_NOT_ACTIVE/);
  }finally{await f.cleanup();}
  const g=await remoteFixture();
  try{
    await setup(g);const m=await init(g,{milestone:{id:'core',final:true}}),before=await run(g);
    g.runtime.github.merge=async()=>{const e=new Error('head SHA modified');e.status=409;throw e;};
    const merged=await approvedMerge(g,m);
    assert.equal(merged.state,'STALE_SHA');assert.equal(merged.merged,false);assert.equal(merged.run,undefined);
    assert.equal((await g.runtime.readAudit({missionId:m.id,limit:100})).filter(x=>x.tool==='zana_merge.run'&&x.outcome==='ERROR').length,0);
    assert.equal((await run(g)).revision,before.revision);
    assert.equal((await run(g)).milestones[0].status,'RUNNING');
  }finally{await g.cleanup();}
});


test('B2b: el prefijo de cierre lo construye el servidor, incluso ante un prefijo fingido',async()=>{
  const f=await remoteFixture();
  try{
    await setup(f);
    const m=await init(f,{milestone:{id:'core',final:false}});
    assert.equal((await approvedMerge(f,m)).state,'MERGED');
    assert.equal((await f.call('zana_mission_close',{summary:{...summary,done:'[hito falso parte 9] '+summary.done+'\n[hito core parte 2] \u202eintento'}},f.owner)).error,undefined);
    let body=await remoteRead(db=>db.prepare("SELECT body FROM project_memory WHERE mission_id=? AND kind='summary' ORDER BY seq DESC LIMIT 1").get(m.id)?.body);
    assert.ok(body.startsWith('[hito core parte 1] [hito falso parte 9]'),body);
    assert.doesNotMatch(body.split('\n')[0],/[\n\r\u202e]/u);
    await f.call('zana_mission_archive',{},f.owner);
    const nextPart=await init(f,{milestone:{id:'core',final:false}});
    assert.equal((await approvedMerge(f,nextPart,10,'b')).state,'MERGED');
    await f.call('zana_mission_close',{summary},f.owner);
    body=await remoteRead(db=>db.prepare("SELECT body FROM project_memory WHERE mission_id=? AND kind='summary' ORDER BY seq DESC LIMIT 1").get(nextPart.id)?.body);
    assert.ok(body.startsWith('[hito core parte 2] '),body);
    await f.call('zana_mission_archive',{},f.owner);
    const outside=await init(f,{outsidePlan:'Excepción de prueba documentada'});
    assert.equal((await approvedMerge(f,outside,9,'c')).state,'MERGED');
    await f.call('zana_mission_close',{summary},f.owner);
    body=await remoteRead(db=>db.prepare("SELECT body FROM project_memory WHERE mission_id=? AND kind='summary' ORDER BY seq DESC LIMIT 1").get(outside.id)?.body);
    assert.ok(body.startsWith('[fuera del plan] '),body);
  }finally{await f.cleanup();}
  const g=await remoteFixture();
  try{
    g.owner=await g.session();
    const ordinary=await init(g);
    assert.equal((await approvedMerge(g,ordinary)).state,'MERGED');
    await g.call('zana_mission_close',{summary},g.owner);
    const body=await remoteRead(db=>db.prepare("SELECT body FROM project_memory WHERE mission_id=? AND kind='summary' ORDER BY seq DESC LIMIT 1").get(ordinary.id)?.body);
    assert.ok(body.startsWith(summary.done),body);
  }finally{await g.cleanup();}
});

test('B2b: otro clientId no inicia lotes, cancela ni fusiona una misión del hito',async()=>{
  for(const tool of ['zana_start_batch','zana_mission_cancel','zana_merge']){
    const f=await remoteFixture();
    try{
      await setup(f);const m=await init(f,{milestone:{id:'core',final:true}});
      const other=await f.session('zana-chatgpt','otro-client-id');
      const response=await f.call(tool,tool==='zana_merge'?{missionId:m.id}:{},other);
      assert.match(response.error??'',/RUN_OTHER_CLIENT/,tool+': '+JSON.stringify(response));
      assert.equal((await f.call('zana_session_status',{},other)).writerMarked,false,tool);
      assert.equal((await run(f)).milestones[0].status,'RUNNING',tool);
      assert.equal((await remoteRead(db=>loadRun(db,m.memory.projectId).milestones[0].running.missionId)),m.id);
    }finally{await f.cleanup();}
  }
});

test('B2b: prechequeo init sin milestone no marca sesión ajena',async()=>{
  const f=await remoteFixture();
  try{
    await setup(f);
    const other=await f.session('zana-chatgpt','cliente-distinto');
    const result=await init(f,{},other);
    assert.match(result.error??'',/RUN_OTHER_CLIENT/);
    assert.equal((await f.call('zana_session_status',{},other)).writerMarked,false);
    assert.equal(await count(),0);
  }finally{await f.cleanup();}
});

test('B2b: cancel tras PR fusionado no libera hito si falló completePart',async()=>{
  const f=await remoteFixture();
  try{
    const started=await setup(f),m=await init(f,{milestone:{id:'core',final:true}});
    const merge=f.runtime.github.merge.bind(f.runtime.github);
    f.runtime.github.merge=async(...args)=>{
      const result=await merge(...args);
      await remoteWrite(db=>{const run=loadRun(db,started.projectId);
        saveRun(db,run,recordOutsidePlan(run,{missionId:'fecha-futura',reason:'Simulación del fallo de completePart',now:'2099-01-01T00:00:00.000Z'}));});
      return result;
    };
    const merged=await approvedMerge(f,m);
    assert.equal(merged.state,'MERGED');
    assert.equal(merged.run.recorded,false);
    const cancelled=await f.call('zana_mission_cancel',{},f.owner);
    assert.match(cancelled.error??'',/PR_ALREADY_MERGED/);
    assert.equal((await f.call('zana_mission_status',{},f.owner)).state,'ACTIVE');
    assert.notEqual((await run(f)).milestones[0].status,'PENDING');
    assert.ok((await f.runtime.readAudit({missionId:m.id,limit:100})).some(x=>
      x.tool==='zana_mission_cancel.run'&&x.detail?.code==='PR_ALREADY_MERGED'));
  }finally{await f.cleanup();}
});

test('B2c: auditoría fallida tras merge conserva SHAs sin certificar el hito',async()=>{
  const f=await remoteFixture();
  try{
    await setup(f);const m=await init(f,{milestone:{id:'core',final:true}});
    await remoteWrite(db=>db.exec("CREATE TRIGGER deny_merge_result BEFORE INSERT ON remote_audit WHEN NEW.tool='zana_merge.result' BEGIN SELECT RAISE(ABORT,'AUDIT_DENIED'); END"));
    const result=await approvedMerge(f,m);
    assert.equal(result.error,undefined,result.error);
    assert.equal(result.state,'MERGED');
    assert.equal(result.headSha,sha('a'));
    assert.equal(result.mergeCommitSha,sha('9'));
    assert.deepEqual(result.run,{recorded:false,reason:'AUDIT_UNAVAILABLE'});
    assert.equal((await run(f)).milestones[0].status,'RUNNING');
  }finally{await f.cleanup();}
});

test('B2b: auditoría exacta de claim y outsidePlan sin texto del modelo',async()=>{
  const f=await remoteFixture();
  try{
    const start=await setup(f),m=await init(f,{milestone:{id:'core',final:true}});
    let audit=(await f.runtime.readAudit({missionId:m.id,limit:100})).find(x=>x.tool==='zana_mission_init.run'&&x.outcome==='SUCCESS');
    assert.deepEqual(audit.detail,{projectId:start.projectId,milestoneId:'core',transition:'CLAIM'});
    await f.call('zana_mission_cancel',{},f.owner);
    audit=(await f.runtime.readAudit({missionId:m.id,limit:100})).find(x=>x.tool==='zana_mission_cancel.run'&&x.outcome==='SUCCESS');
    assert.deepEqual(audit.detail,{projectId:start.projectId,milestoneId:'core',transition:'RELEASE'});
    await f.call('zana_mission_archive',{},f.owner);
    const ext=await init(f,{outsidePlan:'NO_INCLUIR_ESTE_TEXTO_EN_AUDITORIA'});
    audit=(await f.runtime.readAudit({missionId:ext.id,limit:100})).find(x=>x.tool==='zana_mission_init.run'&&x.outcome==='SUCCESS');
    assert.deepEqual(audit.detail,{projectId:start.projectId,milestoneId:null,transition:'OUTSIDE_PLAN'});
  }finally{await f.cleanup();}
});


test('B2b: errores de memoria en init y merge quedan auditados y aislados',async()=>{
  for(const stage of ['init','merge']){
    const f=await remoteFixture();
    try{
      const started=await setup(f);
      if(stage==='init')await remoteWrite(db=>db.exec("CREATE TRIGGER deny_memory BEFORE INSERT ON project_memory BEGIN SELECT RAISE(ABORT,'NO_MEMORY'); END"));
      const m=await init(f,{milestone:{id:'core',final:true}});
      assert.equal(m.error,undefined,m.error);
      if(stage==='merge')await remoteWrite(db=>db.exec("CREATE TRIGGER deny_memory BEFORE INSERT ON project_memory BEGIN SELECT RAISE(ABORT,'NO_MEMORY'); END"));
      const result=stage==='init'?m:await approvedMerge(f,m);
      assert.match(result.run.memoryError??'',/MEMORY_UNAVAILABLE/);
      const audits=await f.runtime.readAudit({missionId:m.id,limit:100});
      assert.deepEqual(audits.find(x=>x.tool===('zana_'+(stage==='init'?'mission_init':'merge')+'.run')&&x.outcome==='ERROR')?.detail,
        {projectId:started.projectId,milestoneId:'core',code:'MEMORY_UNAVAILABLE'});
      if(stage==='init')assert.equal((await run(f)).milestones[0].status,'RUNNING');
      else assert.equal(result.state,'MERGED');
    }finally{await f.cleanup();}
  }
});

test('B2b: un error de auditoría antes de fusionar no se silencia ni registra parte',async()=>{
  const f=await remoteFixture();
  try{
    await setup(f);const m=await init(f,{milestone:{id:'core',final:true}});
    await remoteWrite(db=>db.exec("CREATE TRIGGER deny_audit BEFORE INSERT ON remote_audit WHEN NEW.tool='zana_merge.result' BEGIN SELECT RAISE(ABORT,'AUDIT_DENIED'); END"));
    const result=await f.call('zana_merge',{missionId:m.id},f.owner);
    assert.match(result.error??'',/AUDIT_DENIED/);
    assert.equal((await run(f)).milestones[0].status,'RUNNING');
    assert.equal((await f.runtime.readAudit({missionId:m.id,limit:100})).filter(x=>x.tool==='zana_merge.run').length,0);
  }finally{await f.cleanup();}
});

test('B2b: errores inesperados se normalizan en run.reason y en auditoría',async()=>{
  const f=await remoteFixture();
  try{
    const started=await setup(f),m=await init(f,{milestone:{id:'core',final:true}});
    await remoteWrite(db=>db.exec("CREATE TRIGGER bad_run BEFORE INSERT ON metadata WHEN NEW.key LIKE 'zana:run:%' BEGIN SELECT RAISE(ABORT,'bad reason with spaces'); END"));
    const result=await f.call('zana_mission_cancel',{},f.owner);
    assert.deepEqual(result.run,{released:false,reason:'INTERNAL_ERROR'});
    assert.deepEqual((await f.runtime.readAudit({missionId:m.id,limit:100})).find(x=>x.tool==='zana_mission_cancel.run'&&x.outcome==='ERROR')?.detail,
      {projectId:started.projectId,code:'INTERNAL_ERROR'});
  }finally{await f.cleanup();}
});

test('B2b: MCP real rechaza milestone.id inválido por el esquema zod',async()=>{
  const f=await remoteFixture();
  let server,client;
  try{
    f.owner=await f.session();
    server=f.runtime.createServer(async()=>f.owner);
    client=new Client({name:'schema-b2b',version:'1.0.0'});
    const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport),client.connect(clientTransport)]);
    const response=await client.callTool({name:'zana_mission_init',arguments:{
      spec:f.spec,github:gh,milestone:{id:'MAYUSCULA',final:true}}});
    assert.equal(response.isError,true);
    assert.match(JSON.stringify(response.content),/Input validation error: Invalid arguments for tool zana_mission_init: milestone\.id: Invalid string: must match pattern/);
    assert.equal(await count(),0);
  }finally{await client?.close();await server?.close();await f.cleanup();}
});


test('B2b: fallo de memory_context conserva el SAVEPOINT y la misión',async()=>{
  const f=await remoteFixture();
  try{
    const started=await setup(f);
    await remoteWrite(db=>db.exec('ALTER TABLE project_memory RENAME COLUMN kind TO corrupt_kind'));
    const m=await init(f,{milestone:{id:'core',final:true}});
    assert.equal(m.error,undefined,m.error);
    assert.match(m.memory?.error??'',/MEMORY_UNAVAILABLE/,JSON.stringify(m.memory));
    assert.equal((await remoteRead(db=>loadRun(db,started.projectId))).milestones[0].status,'RUNNING');
    assert.equal(await count(),1);
    assert.equal((await remoteRead(db=>loadRun(db,started.projectId))).milestones[0].running.missionId,m.id);
  }finally{await f.cleanup();}
});

test('B2b: outsidePlan mantiene dueño OAuth; sin corrida conserva las reglas anteriores',async()=>{
  const f=await remoteFixture();
  try{
    await setup(f);const m=await init(f,{outsidePlan:'Excepción con propietario distinto'});
    const other=await f.session('zana-chatgpt','fuera-de-plan-ajeno');
    for(const tool of ['zana_start_batch','zana_mission_cancel','zana_merge']){
      const r=await f.call(tool,tool==='zana_merge'?{missionId:m.id}:{},other);
      assert.match(r.error??'',/RUN_OTHER_CLIENT/);
      assert.equal((await f.call('zana_session_status',{},other)).writerMarked,false);
    }
    assert.equal((await remoteRead(db=>loadRun(db,m.memory.projectId).outsidePlan[0].missionId)),m.id);
  }finally{await f.cleanup();}
});

test('R2: una misión normal de B funciona aunque la corrida de A terminó',async()=>{
  for(const state of ['READY_TO_DELIVER','CANCELLED']){
    const f=await remoteFixture();
    try{
      const started=await setup(f);
      if(state==='READY_TO_DELIVER'){const m=await init(f,{milestone:{id:'core',final:true}});
        assert.equal((await approvedMerge(f,m)).state,'MERGED');
        await f.call('zana_mission_close',{summary},f.owner);await f.call('zana_mission_archive',{},f.owner);
      }else await remoteWrite(db=>{const r=loadRun(db,started.projectId);
        saveRun(db,r,cancelProjectRun(r,{reason:'Corrida detenida por la prueba',now:new Date().toISOString()}));});
      const other=await f.session('zana-chatgpt','cliente-b'),ordinary=await init(f,{},other);
      assert.equal(ordinary.error,undefined,ordinary.error);
      assert.equal((await f.call('zana_start_batch',{},other)).error,undefined,state);
      assert.doesNotMatch((await f.call('zana_merge',{missionId:ordinary.id},other)).error??'',/RUN_OTHER_CLIENT/,state);
      assert.equal((await f.call('zana_mission_cancel',{},other)).status,'CANCELLED');
    }finally{await f.cleanup();}
  }
});
test('R2: el dueño protege todas las escrituras antes de marcar writer',async()=>{
  for(const name of ['zana_start_batch','zana_mission_cancel','zana_mission_close','zana_mission_archive',
    'zana_memory_save','zana_memory_resolve','zana_unit_retry','zana_unit_heartbeat',
    'zana_review_request','zana_correction_start','zana_budget_extend']){
    const f=await remoteFixture();
    try{
      await setup(f);const m=await init(f,{milestone:{id:'core',final:true}});
      if(['zana_mission_close','zana_mission_archive'].includes(name))await approvedMerge(f,m);
      if(name==='zana_mission_archive')await f.call('zana_mission_close',{summary},f.owner);
      const other=await f.session('zana-chatgpt','client-b');
      const v=await f.call(name,name==='zana_mission_close'?{summary}:name==='zana_review_request'?{missionId:m.id}:{},other);
      assert.match(v.error??'',/RUN_OTHER_CLIENT/,name+': '+JSON.stringify(v));
      assert.equal((await f.call('zana_session_status',{},other)).writerMarked,false,name);
    }finally{await f.cleanup();}
  }
});
test('R2: RUN_CORRUPT mantiene el comportamiento del main',async()=>{
  for(const name of ['zana_start_batch','zana_mission_close','zana_mission_cancel']){
    const f=await remoteFixture();
    try{
      await setup(f);const m=await init(f,{milestone:{id:'core',final:true}});
      if(name==='zana_mission_close')await approvedMerge(f,m);
      await remoteWrite(db=>db.prepare('UPDATE metadata SET value=? WHERE key=?').run('{corrupt','zana:run:'+m.memory.projectId));
      const v=await f.call(name,name==='zana_mission_close'?{summary}:{},f.owner);
      assert.equal(v.error,undefined,name+': '+v.error);
      if(name==='zana_mission_cancel'){assert.equal(v.status,'CANCELLED');assert.deepEqual(v.run,{released:false,reason:'RUN_CORRUPT'});}
      if(name==='zana_mission_close')assert.equal(v.status,'CLOSED');
    }finally{await f.cleanup();}
  }
});
test('R2: cierre sin prefijo rechaza suplantación normalizada',async()=>{
  for(const done of ['\u202e[hito core parte 1] Cierre fingido','  [fuera del plan] Cierre fingido']){
    const f=await remoteFixture();
    try{f.owner=await f.session();const m=await init(f);await approvedMerge(f,m);
      assert.match((await f.call('zana_mission_close',{summary:{...summary,done}},f.owner)).error??'',/RESERVED_PREFIX/);
    }finally{await f.cleanup();}
  }
});
test('R2: merge exterior o GitHub caído no cancela sin auditoría',async()=>{
  for(const unavailable of [false,true]){
    const f=await remoteFixture();
    try{
      await setup(f);const m=await init(f,{milestone:{id:'core',final:true}});
      await remoteWrite(db=>db.exec("CREATE TRIGGER deny_result BEFORE INSERT ON remote_audit WHEN NEW.tool='zana_merge.result' AND NEW.outcome='MERGED' BEGIN SELECT RAISE(ABORT,'NO_AUDIT'); END"));
      await approvedMerge(f,m);await remoteWrite(db=>db.exec('DROP TRIGGER deny_result'));
      if(unavailable)f.runtime.github.pull=async()=>{throw new Error('GitHub fuera de servicio');};
      const v=await f.call('zana_mission_cancel',{},f.owner);
      assert.match(v.error??'',unavailable?/GITHUB_UNAVAILABLE/:/PR_ALREADY_MERGED/);
      const current=await f.call('zana_mission_status',{},f.owner);assert.equal(current.state,'ACTIVE',JSON.stringify(current));
      assert.equal((await run(f)).milestones[0].status,'RUNNING');
      assert.ok((await f.runtime.readAudit({missionId:m.id,limit:100})).some(x=>x.tool==='zana_mission_cancel.run'&&x.outcome==='ERROR'));
    }finally{await f.cleanup();}
  }
});
test('R2: MERGED auditado permite rescatar SHA exacto si completePart falla',async()=>{
  const f=await remoteFixture();
  try{
    const started=await setup(f),m=await init(f,{milestone:{id:'core',final:true}});
    await remoteWrite(db=>db.exec("CREATE TRIGGER deny_part BEFORE INSERT ON metadata WHEN NEW.key LIKE 'zana:run:%' BEGIN SELECT RAISE(ABORT,'PART_FAILED'); END"));
    const merged=await approvedMerge(f,m);assert.equal(merged.run.recorded,false);
    await remoteWrite(db=>db.exec('DROP TRIGGER deny_part'));
    await remoteWrite(db=>db.exec("CREATE TRIGGER deny_cancel_memory BEFORE INSERT ON project_memory BEGIN SELECT RAISE(ABORT,'NO_MEMORY'); END"));
    const v=await f.call('zana_mission_cancel',{},f.owner);
    assert.equal(v.run.recorded,true,v.error);assert.equal(v.run.status,'DONE');
    assert.match(v.run.memoryError,/MEMORY_UNAVAILABLE/);
    const state=await remoteRead(db=>loadRun(db,started.projectId));
    assert.equal(state.milestones[0].parts[0].headSha,sha('a'));
    assert.deepEqual((await f.runtime.readAudit({missionId:m.id,limit:100})).find(x=>x.tool==='zana_mission_cancel.run'&&x.outcome==='ERROR')?.detail,{projectId:started.projectId,milestoneId:'core',code:'MEMORY_UNAVAILABLE'});
    assert.deepEqual((await f.runtime.readAudit({missionId:m.id,limit:100})).find(x=>x.tool==='zana_mission_cancel.run'&&x.outcome==='SUCCESS')?.detail,
      {projectId:started.projectId,milestoneId:'core',transition:'DONE'});
  }finally{await f.cleanup();}
});

test('R2: outsidePlan retiene 50 entradas pero el origen auditado conserva el prefijo',async()=>{
  const f=await remoteFixture();
  try{
    const started=await setup(f),m=await init(f,{outsidePlan:'Excepción persistente de prueba'});
    await approvedMerge(f,m);
    await remoteWrite(db=>{let s=loadRun(db,started.projectId);
      for(let i=0;i<51;i++){const next=recordOutsidePlan(s,{missionId:'extra-'+i,reason:'Excepción adicional verificable',now:new Date(Date.parse(s.updatedAt)+1000).toISOString()});
        saveRun(db,s,next);s=next;}
    });
    assert.equal((await remoteRead(db=>loadRun(db,started.projectId).outsidePlan.length)),50);
    assert.equal((await remoteRead(db=>loadRun(db,started.projectId).outsidePlan.some(x=>x.missionId===m.id))),false);
    assert.equal((await f.call('zana_mission_close',{summary},f.owner)).error,undefined);
    const body=await remoteRead(db=>db.prepare("SELECT body FROM project_memory WHERE mission_id=? AND kind='summary' ORDER BY seq DESC LIMIT 1").get(m.id)?.body);
    assert.match(body,/^\[fuera del plan\] /);
  }finally{await f.cleanup();}
});

test('B2c: cancel sin ticket detecta PR fusionado por fuera y no libera hito',async()=>{
  const f=await remoteFixture();
  try{
    await setup(f);const m=await init(f,{milestone:{id:'core',final:true}});
    f.api.state.push(m.github.branch,sha('a'));f.api.state.openPull(m.github.branch,17);
    Object.assign(f.api.state.pulls.at(-1),{state:'closed',merged:true,
      merged_at:'2026-11-16T00:00:00Z',merge_commit_sha:sha('9')});
    const states=fakeAllPulls(f);
    const v=await f.call('zana_mission_cancel',{},f.owner);
    assert.ok(states.includes('all'));
    assert.match(v.error??'',/PR_ALREADY_MERGED/);
    assert.equal((await f.call('zana_mission_status',{},f.owner)).state,'ACTIVE');
    assert.equal((await run(f)).milestones[0].status,'RUNNING');
  }finally{await f.cleanup();}
});
test('B2c: session_rebind respeta dueño del hito antes de marcar escritor',async()=>{
  const f=await remoteFixture();
  try{
    await setup(f);const m=await init(f,{milestone:{id:'core',final:true}});
    const p=(await f.call('zana_start_batch',{},f.owner)).packets[0];
    const other=await f.session('zana-chatgpt','cliente-b');
    const v=await f.call('zana_session_rebind',{missionId:m.id,unitId:p.unitId,
      token:p.token,leaseGeneration:p.leaseGeneration},other);
    assert.match(v.error??'',/RUN_OTHER_CLIENT/);
    assert.equal((await f.call('zana_session_status',{},other)).writerMarked,false);
  }finally{await f.cleanup();}
});
test('B2c: NFKD ancho completo bloquea suplantación, [hitos] no es reservado',async()=>{
  for(const [done,blocked] of [['［hito core parte 1] fingido',true],['[hitos] resumen legítimo',false]]){
    const f=await remoteFixture();
    try{
      f.owner=await f.session();const m=await init(f);await approvedMerge(f,m);
      const v=await f.call('zana_mission_close',{summary:{...summary,done}},f.owner);
      if(blocked)assert.match(v.error??'',/RESERVED_PREFIX/);
      else assert.equal(v.error,undefined,v.error);
    }finally{await f.cleanup();}
  }
});
test('B2c: prefijo generado elimina U+2028, U+0085, VT, FF y saltos LF',async()=>{
  const f=await remoteFixture();
  try{
    await setup(f);const m=await init(f,{milestone:{id:'core',final:true}});
    await approvedMerge(f,m);
    const done='Línea 1\u2028Línea 2\nLínea 3\u0085Cuatro\vCinco\fSeis';
    const v=await f.call('zana_mission_close',{summary:{...summary,done}},f.owner);
    assert.equal(v.error,undefined,v.error);
    const body=await remoteRead(db=>db.prepare("SELECT body FROM project_memory WHERE mission_id=? AND kind='summary' ORDER BY seq DESC LIMIT 1").get(m.id)?.body);
    assert.match(body,/Línea 1 Línea 2 Línea 3 Cuatro Cinco Seis/);
  }finally{await f.cleanup();}
});
test('B2c: misión con identificador en mayúsculas mantiene guarda de dueño',async()=>{
  const f=await remoteFixture();
  try{
    const started=await setup(f),m=await init(f,{milestone:{id:'core',final:true}});
    await remoteWrite(db=>{
      const run=loadRun(db,started.projectId),next=structuredClone(run);
      next.revision++;next.milestones[0].running.missionId=m.id.toUpperCase();
      saveRun(db,run,next);
    });
    const other=await f.session('zana-chatgpt','cliente-b');
    const v=await f.call('zana_start_batch',{},other);
    assert.match(v.error??'',/RUN_OTHER_CLIENT/);
    assert.equal((await f.call('zana_session_status',{},other)).writerMarked,false);
  }finally{await f.cleanup();}
});
test('B2c: cancel recupera mergeCommitSha de GitHub con auditoría MERGED sin SHA',async()=>{
  const f=await remoteFixture();
  try{
    const started=await setup(f),m=await init(f,{milestone:{id:'core',final:true}});
    await remoteWrite(db=>db.exec("CREATE TRIGGER deny_part_b2c BEFORE INSERT ON metadata WHEN NEW.key LIKE 'zana:run:%' BEGIN SELECT RAISE(ABORT,'PART_FAILED'); END"));
    const merged=await approvedMerge(f,m);assert.equal(merged.run.recorded,false);
    await remoteWrite(db=>{
      db.exec('DROP TRIGGER deny_part_b2c');
      const row=db.prepare("SELECT seq,detail FROM remote_audit WHERE mission_id=? AND tool='zana_merge.result' AND outcome='MERGED' ORDER BY seq DESC LIMIT 1").get(m.id);
      assert.ok(row);
      db.prepare('UPDATE remote_audit SET detail=? WHERE seq=?').run(JSON.stringify({...JSON.parse(row.detail),mergeCommitSha:null}),row.seq);
      db.prepare('DELETE FROM review_tickets WHERE mission_id=?').run(m.id);
    });
    const states=fakeAllPulls(f);
    const v=await f.call('zana_mission_cancel',{},f.owner);
    assert.ok(states.includes('all'));
    assert.equal(v.error,undefined,v.error);
    assert.equal(v.run.recorded,true);
    assert.equal((await remoteRead(db=>loadRun(db,started.projectId).milestones[0].parts[0].mergeCommitSha)),sha('9'));
  }finally{await f.cleanup();}
});

test('B2c: cancel rescata parte con auditoría completa aunque GitHub no responda',async()=>{
  const f=await remoteFixture();
  try{
    const started=await setup(f),m=await init(f,{milestone:{id:'core',final:true}});
    await remoteWrite(db=>db.exec("CREATE TRIGGER deny_part_offline BEFORE INSERT ON metadata WHEN NEW.key LIKE 'zana:run:%' BEGIN SELECT RAISE(ABORT,'PART_FAILED'); END"));
    const merged=await approvedMerge(f,m);assert.equal(merged.run.recorded,false);
    await remoteWrite(db=>db.exec('DROP TRIGGER deny_part_offline'));
    f.runtime.github.pull=async()=>{throw new Error('offline');};
    const v=await f.call('zana_mission_cancel',{},f.owner);
    assert.equal(v.error,undefined,v.error);
    assert.equal(v.run.recorded,true);
    assert.equal((await remoteRead(db=>loadRun(db,started.projectId).milestones[0].status)),'DONE');
  }finally{await f.cleanup();}
});

test('C1: prefix rejects variants, permits [hitos], strips Cc from server-prefixed summary',async()=>{
  for(const [done,blocked] of [
    ['[ hito core parte 1] simulado',true],['[hito:core] simulado',true],
    ['[fueradelplan] simulado',true],['[híto core] simulado',true],
    ['[hitos] texto legítimo',false]]){
    const f=await remoteFixture();
    try{
      f.owner=await f.session();const m=await init(f);
      assert.equal((await approvedMerge(f,m)).state,'MERGED');
      const closed=await f.call('zana_mission_close',{summary:{...summary,done}},f.owner);
      if(blocked)assert.match(closed.error??'',/RESERVED_PREFIX/);
      else assert.equal(closed.error,undefined,closed.error);
    }finally{await f.cleanup();}
  }
  const f=await remoteFixture();
  try{
    await setup(f);const m=await init(f,{milestone:{id:'core',final:true}});
    assert.equal((await approvedMerge(f,m)).state,'MERGED');
    await f.call('zana_mission_close',{summary:{...summary,done:'Texto limpio\x1cFS\x1eRS\x1bESC'}},f.owner);
    const body=await remoteRead(db=>db.prepare("SELECT body FROM project_memory WHERE mission_id=? AND kind='summary' ORDER BY seq DESC LIMIT 1").get(m.id)?.body);
    assert.ok(body.startsWith('[hito core parte 1] '));
    assert.doesNotMatch(body.split('\n')[0],/[\x00-\x1f\x7f]/);
  }finally{await f.cleanup();}
});

test('C1: cancelar sin misión conserva respuesta legada',async()=>{
  const f=await remoteFixture();
  try{
    const author=await f.session();
    assert.match((await f.call('zana_mission_cancel',{},author)).error??'',/No mission initialized/);
  }finally{await f.cleanup();}
});
test('C1: cancel solo recupera merge SHA de un pull fusionado en el head auditado',async()=>{
  for(const [tamper,blocked] of [[p=>{p.merged=false;p.merged_at=null;},false],[(p,f)=>{f.api.state.branches[p.head.ref]=sha('b');},true]]){
    const f=await remoteFixture();
    try{
      const started=await setup(f),m=await init(f,{milestone:{id:'core',final:true}});
      await remoteWrite(db=>db.exec("CREATE TRIGGER deny_part_c1 BEFORE INSERT ON metadata WHEN NEW.key LIKE 'zana:run:%' BEGIN SELECT RAISE(ABORT,'PART_FAILED'); END"));
      assert.equal((await approvedMerge(f,m)).run.recorded,false);
      await remoteWrite(db=>{
        db.exec('DROP TRIGGER deny_part_c1');
        const row=db.prepare("SELECT seq,detail FROM remote_audit WHERE mission_id=? AND tool='zana_merge.result' AND outcome='MERGED' ORDER BY seq DESC LIMIT 1").get(m.id);
        db.prepare('UPDATE remote_audit SET detail=? WHERE seq=?').run(JSON.stringify({...JSON.parse(row.detail),mergeCommitSha:null}),row.seq);
      });
      tamper(f.api.state.pulls.at(-1),f);
      const v=await f.call('zana_mission_cancel',{},f.owner);
      if(blocked)assert.match(v.error??'',/PR_ALREADY_MERGED/);
      else assert.equal(v.run.released,true,v.error);
      assert.equal((await remoteRead(db=>loadRun(db,started.projectId).milestones[0].status)),blocked?'RUNNING':'PENDING');
    }finally{await f.cleanup();}
  }
});
test('C1: cancel conserva identidad de misión y usa withMissionLock',async()=>{
  const f=await remoteFixture();
  try{
    await setup(f);const m=await init(f,{milestone:{id:'core',final:true}});
    const original=f.runtime.review.withMissionLock;let locked='';
    f.runtime.review.withMissionLock=async(id,fn)=>{locked=id;await remoteWrite(db=>db.prepare('UPDATE active_mission SET id=? WHERE slot=1').run('00000000-0000-4000-8000-000000000001'));return original(id,fn);};
    assert.match((await f.call('zana_mission_cancel',{},f.owner)).error??'',/MISSION_CHANGED/);
    assert.equal(locked,m.id);
  }finally{await f.cleanup();}
});

test('C1: búsqueda por rama omite pulls no fusionados o de otro head.ref',async()=>{
  const f=await remoteFixture();
  try{
    const started=await setup(f),m=await init(f,{milestone:{id:'core',final:true}});
    await remoteWrite(db=>db.exec("CREATE TRIGGER deny_part_search BEFORE INSERT ON metadata WHEN NEW.key LIKE 'zana:run:%' BEGIN SELECT RAISE(ABORT,'PART_FAILED'); END"));
    assert.equal((await approvedMerge(f,m)).run.recorded,false);const real=f.api.state.pulls.at(-1);
    await remoteWrite(db=>{db.exec('DROP TRIGGER deny_part_search');db.prepare('DELETE FROM review_tickets WHERE mission_id=?').run(m.id);const row=db.prepare("SELECT seq,detail FROM remote_audit WHERE mission_id=? AND tool='zana_merge.result' AND outcome='MERGED' ORDER BY seq DESC LIMIT 1").get(m.id);db.prepare('UPDATE remote_audit SET detail=? WHERE seq=?').run(JSON.stringify({...JSON.parse(row.detail),mergeCommitSha:null}),row.seq);});
    f.api.state.pulls.unshift({...structuredClone(real),number:88,head:{...real.head,ref:'otra'}},{...structuredClone(real),number:89,merged:false,merged_at:null});
    const v=await f.call('zana_mission_cancel',{},f.owner);assert.equal(v.run.recorded,true,v.error);
    assert.equal((await remoteRead(db=>loadRun(db,started.projectId).milestones[0].parts[0].prNumber)),real.number);
  }finally{await f.cleanup();}
});


test('C2: cancel rechaza auditoría de merge que no corresponde a head remoto',async()=>{
  const f=await remoteFixture();
  try{
    const started=await setup(f),m=await init(f,{milestone:{id:'core',final:true}});
    await remoteWrite(db=>db.exec("CREATE TRIGGER deny_part_c2 BEFORE INSERT ON metadata WHEN NEW.key LIKE 'zana:run:%' BEGIN SELECT RAISE(ABORT,'PART_FAILED'); END"));
    assert.equal((await approvedMerge(f,m)).run.recorded,false);
    await remoteWrite(db=>db.exec('DROP TRIGGER deny_part_c2'));
    f.api.state.branches[m.github.branch]=sha('b');
    const before=await run(f);
    const denied=await f.call('zana_mission_cancel',{},f.owner);
    assert.match(denied.error??'',/MERGE_EVIDENCE_MISMATCH/);
    assert.equal((await run(f)).revision,before.revision);
    assert.equal((await remoteRead(db=>loadRun(db,started.projectId).milestones[0].status)),'RUNNING');
  }finally{await f.cleanup();}
});
