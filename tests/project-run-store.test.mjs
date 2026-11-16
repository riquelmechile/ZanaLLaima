import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture} from './helpers/remote-fixture.mjs';
import {makePlan} from './helpers/plan-fixture.mjs';
import {remoteRead,remoteWrite} from '../src/store.mjs';
import {loadRun,saveRun,applyRunMemory} from '../src/project-run-store.mjs';
import {saveEntry,reservedTopic} from '../src/project-memory.mjs';

const answers={goal:'Gestionar hitos',users:'Equipos',platform:'Web',features:'Planes',data:'Sin secretos'};
async function workspace(f,s,objective='Modelo'){
  const a=await f.call('zana_workspace_create',{idea:'Crear un sitio de gestión de proyectos extensible'},s);
  const b=await f.call('zana_workspace_update',{workspaceId:a.workspaceId,expectedVersion:0,answers},s);
  return f.call('zana_workspace_update',{workspaceId:a.workspaceId,expectedVersion:1,plan:makePlan(b.brief,objective)},s);
}
async function approve(f,s,w){
  const req=await f.call('zana_plan_approval_request',{workspaceId:w.workspaceId,expectedVersion:w.version},s);
  f.runtime.planApproval.decide({approvalId:req.approvalId,decision:'allow',passwordOk:true});
}
const count=(sql,...args)=>remoteRead(db=>db.prepare(sql).get(...args).n);

test('memoryContext excluye entradas retiradas de cualquier tipo',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session(),spec={objective:'Memoria retirada',units:[{id:'read',effect:'READ',instruction:'Leer'}]};
    const init=await f.call('zana_mission_init',{spec,github:{repo:'o/r',base:'main'}},s);
    for(const kind of ['issue','decision','convention']){
      const saved=await f.call('zana_memory_save',{missionId:init.id,kind,topic:'viejo-'+kind,body:'Ya resuelto'},s);
      assert.equal(saved.error,undefined,saved.error);
      await remoteWrite(db=>db.prepare('UPDATE project_memory SET resolved_at=? WHERE seq=?').run(new Date().toISOString(),saved.seq));
    }
    const ctx=await f.call('zana_memory_context',{projectId:init.memory.projectId},s);
    assert.equal(ctx.entries.some(e=>e.topic.startsWith('viejo-')),false);
  }finally{await f.cleanup();}
});

test('run_start exige aprobación, crea memoria, es idempotente y next no marca la sesión',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session(),w=await workspace(f,s);
    assert.match((await f.call('zana_project_run_start',{workspaceId:w.workspaceId,repo:'o/r',base:'main'},s)).error,/PLAN_NOT_APPROVED/);
    await approve(f,s,w);
    const first=await f.call('zana_project_run_start',{workspaceId:w.workspaceId,repo:'o/r',base:'main'},s);
    assert.deepEqual([first.created,first.run.revision,first.run.milestones.every(m=>m.status==='PENDING')],[true,0,true]);
    assert.ok(first.pointer.content);
    assert.equal(first.saved>0,true);
    const before=await count('SELECT COUNT(*) n FROM project_memory');
    const again=await f.call('zana_project_run_start',{workspaceId:w.workspaceId,repo:'o/r',base:'main'},s);
    assert.deepEqual([again.created,again.run.revision,await count('SELECT COUNT(*) n FROM project_memory')],[false,0,before]);
    const reader=await f.session(),next=await f.call('zana_project_next',{repo:'o/r'},reader);
    assert.deepEqual([next.ready[0].id,next.memory.entries[0].topic],['core','proyecto:avance']);
    assert.equal(await count("SELECT COUNT(*) n FROM metadata WHERE key=?", 'zana:session-writer:'+reader.sessionId),0);
    const changed=await f.call('zana_workspace_update',{workspaceId:w.workspaceId,expectedVersion:w.version,plan:makePlan(w.brief,'Otro modelo')},s);
    await approve(f,s,changed);
    assert.match((await f.call('zana_project_run_start',{workspaceId:w.workspaceId,repo:'o/r',base:'main'},s)).error,/RUN_PLAN_CHANGED/);
    const other=await f.session('zana-chatgpt','otro-cliente');
    assert.match((await f.call('zana_project_next',{repo:'o/r'},other)).error,/RUN_OTHER_CLIENT/);
  }finally{await f.cleanup();}
});

test('run_start valida repo/base y no crea corrida si GitHub falla',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session(),w=await workspace(f,s);await approve(f,s,w);
    assert.match((await f.call('zana_project_run_start',{workspaceId:w.workspaceId,repo:'x/y',base:'main'},s)).error,/REPO_NOT_ALLOWED/);
    for(const base of ['-main','a..b','x.lock'])
      assert.match((await f.call('zana_project_run_start',{workspaceId:w.workspaceId,repo:'o/r',base},s)).error,/INVALID_BASE/);
    f.api.state.failNext={status:503,message:'down'};
    assert.match((await f.call('zana_project_run_start',{workspaceId:w.workspaceId,repo:'o/r',base:'main'},s)).error,/MEMORY_UNAVAILABLE/);
    assert.equal(await count("SELECT COUNT(*) n FROM metadata WHERE key LIKE 'zana:run:%'"),0);
    assert.match((await f.call('zana_project_next',{repo:'o/r'},s)).error,/RUN_NOT_FOUND/);
  }finally{await f.cleanup();}
});

test('store controla revisión, conserva corrida si falla memoria y retira por prefijo literal',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session(),w=await workspace(f,s);await approve(f,s,w);
    const started=await f.call('zana_project_run_start',{workspaceId:w.workspaceId,repo:'o/r',base:'main'},s);
    await remoteWrite(db=>{
      const run=loadRun(db,started.projectId),bad=structuredClone(run);bad.revision=2;
      assert.throws(()=>saveRun(db,run,bad),/STALE_REVISION/);
      const invalid=structuredClone(run);invalid.status='ROTO';assert.throws(()=>saveRun(db,run,invalid),/INVALID_PROJECT/);
      for(const topic of ['hito:x','hito_x','hito%'])saveEntry(db,{projectId:run.projectId,kind:'issue',topic,body:'basura'});
      applyRunMemory(db,run.projectId,null,run);
      const rows=db.prepare("SELECT topic,resolved_at FROM project_memory WHERE kind='issue'").all();
      assert.equal(rows.find(x=>x.topic==='hito:x').resolved_at!==null,true);
      assert.equal(rows.filter(x=>x.topic!=='hito:x').every(x=>x.resolved_at===null),true);
      db.exec("CREATE TRIGGER bloquea_memoria BEFORE INSERT ON project_memory BEGIN SELECT RAISE(ABORT,'x'); END");
      const next=structuredClone(run);next.revision=1;next.updatedAt=new Date(Date.parse(run.updatedAt)+1).toISOString();
      const saved=saveRun(db,run,next);assert.match(saved.memoryError,/MEMORY_UNAVAILABLE/);
      assert.equal(loadRun(db,run.projectId).revision,1);
    });
  }finally{await f.cleanup();}
});

test('temas reservados se rechazan antes de escribir',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session(),init=await f.call('zana_mission_init',{spec:{objective:'Reserva',units:[{id:'a',effect:'READ',instruction:'Leer'}]},github:{repo:'o/r',base:'main'}},s);
    for(const topic of ['hito:x','Proyecto:avance',' hito:y'])
      assert.match((await f.call('zana_memory_save',{missionId:init.id,kind:'decision',topic,body:'No escribir'},s)).error,/RESERVED_TOPIC/);
    assert.equal(await count("SELECT COUNT(*) n FROM project_memory WHERE topic LIKE 'hito:%' OR lower(topic) LIKE 'proyecto:%'"),0);
    const packet=(await f.call('zana_start_batch',{},s)).packets[0];
    await f.call('zana_complete_unit',{unitId:packet.unitId,token:packet.token,leaseGeneration:packet.leaseGeneration,
      outcome:{success:true,summary:'listo',evidence:['test']}},s);
    const summary={done:'Trabajo de reserva terminado',decisions:[{topic:'proyecto:x',body:'nunca'}],conventions:[],pending:[],keyFiles:[]};
    assert.match((await f.call('zana_mission_close',{summary},s)).error,/RESERVED_TOPIC/);
  }finally{await f.cleanup();}
});

test('una sesión revisora no puede iniciar la corrida',async()=>{
  const f=await remoteFixture();
  try{
    const owner=await f.session(),w=await workspace(f,owner);await approve(f,owner,w);
    const ready=await f.authorReady();
    const requested=await f.call('zana_review_request',{missionId:ready.missionId},ready.author);
    const reviewer=await f.session();await f.call('zana_review_claim',{ticket:requested.ticket},reviewer);
    assert.match((await f.call('zana_project_run_start',{workspaceId:w.workspaceId,repo:'o/r',base:'main'},reviewer)).error,/REVIEWER_READ_ONLY/);
  }finally{await f.cleanup();}
});

test('los temas reservados normalizan Unicode antes de comparar',()=>{
  for(const topic of ['\u200bhito:x','hi\u200dto:x','ｈｉｔｏ：x'])
    assert.equal(reservedTopic(topic),true,topic);
});
