import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture,readDiff,sha} from './helpers/remote-fixture.mjs';
import {makePlan} from './helpers/plan-fixture.mjs';
import {remoteRead,remoteWrite,transact} from '../src/store.mjs';
import {loadRun,saveRun} from '../src/project-run-store.mjs';
import {claimMilestone,recordOutsidePlan,cancelProjectRun} from '../src/project-orchestrator.mjs';

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
    assert.ok((await f.runtime.readAudit({missionId:ext.id,limit:100})).some(x=>x.category==='project_run'&&JSON.stringify(x).includes('OUTSIDE_PLAN')));
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
        if(scenario==='missing')assert.ok((await f.runtime.readAudit({missionId:m.id,limit:100})).some(x=>x.category==='project_run'&&JSON.stringify(x).includes('MERGE_SHA_UNKNOWN')));
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
    assert.match((await init(f,{milestone:{id:'core',final:true}},reviewer)).error,/REVIEWER_READ_ONLY/);
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
    assert.match(JSON.stringify(await remoteRead(db=>loadRun(db,start.projectId).milestones[0].attempts)),/REVIEW_ROUNDS_EXHAUSTED/);
    assert.equal(second.error,undefined,second.error);assert.equal(second.run.milestoneId,'core');assert.equal(second.run.final,true);assert.ok(reviewer.sessionId);
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
    assert.ok((await f.runtime.readAudit({missionId:m.id,limit:100}))
      .some(x=>x.category==='project_run'&&JSON.stringify(x).includes('RUN_CORRUPT')));
  }finally{await f.cleanup();}
});

test('auditoría project_run en claim, outsidePlan, parte y liberación; memoria de saveRun visible',async()=>{
  const f=await remoteFixture();
  try{
    await setup(f);
    let m=await init(f,{milestone:{id:'core',final:false}});
    assert.ok((await f.runtime.readAudit({missionId:m.id,limit:100}))
      .some(x=>x.category==='project_run'&&JSON.stringify(x).includes('core')));
    await approvedMerge(f,m);
    assert.ok((await f.runtime.readAudit({missionId:m.id,limit:100}))
      .some(x=>x.category==='project_run'&&JSON.stringify(x).includes('PARTIAL')));
    await f.call('zana_mission_close',{summary},f.owner);
    await f.call('zana_mission_archive',{},f.owner);
    m=await init(f,{milestone:{id:'core',final:true}});
    assert.equal(m.error,undefined);
    await remoteWrite(db=>db.exec("CREATE TRIGGER reject_run_memory BEFORE INSERT ON project_memory BEGIN SELECT RAISE(ABORT,'NO_MEMORY'); END"));
    const cancelled=await f.call('zana_mission_cancel',{},f.owner);
    assert.equal(cancelled.run.released,true,cancelled.error);
    assert.match(cancelled.run.memoryError,/MEMORY_UNAVAILABLE/);
    assert.ok((await f.runtime.readAudit({missionId:m.id,limit:100}))
      .some(x=>x.category==='project_run'&&JSON.stringify(x).includes('MEMORY_UNAVAILABLE')));
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
    assert.ok(rejected.error||rejected.state!=='MERGED');
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
    assert.ok((await f.runtime.readAudit({missionId:m.id,limit:100}))
      .some(x=>x.category==='project_run'&&JSON.stringify(x).includes('INVALID_TIME')));
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
    assert.equal(merged.state,'STALE_SHA');assert.equal(merged.merged,false);
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
    assert.equal((await f.call('zana_mission_close',{summary:{...summary,done:'[hito falso parte 9] '+summary.done}},f.owner)).error,undefined);
    let body=await remoteRead(db=>db.prepare("SELECT body FROM project_memory WHERE mission_id=? AND kind='summary' ORDER BY seq DESC LIMIT 1").get(m.id)?.body);
    assert.ok(body.startsWith('[hito core parte 1] [hito falso parte 9]'),body);
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
    assert.equal(cancelled.run.released,false);
    assert.equal(cancelled.run.reason,'PR_ALREADY_MERGED');
    assert.notEqual((await run(f)).milestones[0].status,'PENDING');
    assert.ok((await f.runtime.readAudit({missionId:m.id,limit:100})).some(x=>
      x.tool==='zana_mission_cancel.run'&&x.detail?.code==='PR_ALREADY_MERGED'));
  }finally{await f.cleanup();}
});

test('B2b: auditoría fallida después del merge no convierte un merge real en error',async()=>{
  const f=await remoteFixture();
  try{
    await setup(f);const m=await init(f,{milestone:{id:'core',final:true}});
    await remoteWrite(db=>db.exec("CREATE TRIGGER deny_merge_result BEFORE INSERT ON remote_audit WHEN NEW.tool='zana_merge.result' BEGIN SELECT RAISE(ABORT,'AUDIT_DENIED'); END"));
    const result=await approvedMerge(f,m);
    assert.equal(result.state,'MERGED',result.error);
    assert.equal(result.run.recorded,true,result.error);
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
