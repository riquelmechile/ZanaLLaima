import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture} from './helpers/remote-fixture.mjs';
import {makePlan} from './helpers/plan-fixture.mjs';
import {remoteRead,remoteWrite} from '../src/store.mjs';
import {loadRun,saveRun,applyRunMemory,retireRunMemory} from '../src/project-run-store.mjs';
import {saveEntry,reservedTopic} from '../src/project-memory.mjs';
import {claimMilestone,cancelProjectRun} from '../src/project-orchestrator.mjs';

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
    const server=await remoteWrite(db=>saveEntry(db,{projectId:init.memory.projectId,kind:'decision',topic:'proyecto:avance',body:'origen tablero'}).seq);
    const model=await f.call('zana_memory_save',{missionId:init.id,kind:'decision',topic:'һіto:parecido',body:'origen modelo'},s);
    const ctx=await f.call('zana_memory_context',{projectId:init.memory.projectId},s);
    assert.equal(ctx.entries.some(e=>e.topic.startsWith('viejo-')),false);
    assert.match(ctx.note,/Solo las entradas con origin server las escribió el servidor/);
    assert.deepEqual([ctx.entries.find(e=>e.seq===server).origin,ctx.entries.find(e=>e.seq===model.seq).origin],['server','session']);
    const found=await f.call('zana_memory_search',{query:'origen',projectId:init.memory.projectId},s);
    assert.deepEqual([found.entries.find(e=>e.seq===server).origin,found.entries.find(e=>e.seq===model.seq).origin],['server','session']);
    assert.equal(found.entries.find(e=>e.seq===model.seq).topic,'һіto:parecido');
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
    assert.ok(first.pointer.content);assert.equal(first.saved>0,true);
    const audit=await remoteRead(db=>db.prepare("SELECT category,detail FROM remote_audit WHERE tool='zana_project_run_start' AND outcome='OK' ORDER BY seq DESC LIMIT 1").get());
    assert.equal(audit.category,'project_run');assert.deepEqual(JSON.parse(audit.detail),{created:true,projectId:first.projectId,memoryError:null,memoryRepaired:false});
    const before=await count('SELECT COUNT(*) n FROM project_memory');
    const again=await f.call('zana_project_run_start',{workspaceId:w.workspaceId,repo:'o/r',base:'main'},s);
    assert.deepEqual([again.created,again.run.revision,await count('SELECT COUNT(*) n FROM project_memory')],[false,0,before]);assert.ok(again.pointer);
    assert.match((await f.call('zana_project_run_start',{workspaceId:w.workspaceId,repo:'o/r',base:'develop'},s)).error,/RUN_BASE_CHANGED.*main/);
    const reader=await f.session(),next=await f.call('zana_project_next',{repo:'O/R'},reader);
    assert.deepEqual([next.ready[0].id,next.memory.entries[0].topic,next.memoryStale],['core','proyecto:avance',false]);
    assert.equal(await count("SELECT COUNT(*) n FROM metadata WHERE key=?", 'zana:session-writer:'+reader.sessionId),0);
    const changed=await f.call('zana_workspace_update',{workspaceId:w.workspaceId,expectedVersion:w.version,plan:makePlan(w.brief,'Otro modelo')},s);
    await approve(f,s,changed);
    assert.match((await f.call('zana_project_run_start',{workspaceId:w.workspaceId,repo:'o/r',base:'main'},s)).error,/RUN_PLAN_CHANGED/);
    const other=await f.session('zana-chatgpt','otro-cliente');
    assert.match((await f.call('zana_project_next',{repo:'o/r'},other)).error,/RUN_OTHER_CLIENT/);
    const otherW=await workspace(f,other);await approve(f,other,otherW);assert.match((await f.call('zana_project_run_start',{workspaceId:otherW.workspaceId,repo:'o/r',base:'main'},other)).error,/RUN_OTHER_CLIENT/);
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
      const moved=structuredClone(run);moved.projectId='zp_'+'b'.repeat(16);moved.revision=1;assert.throws(()=>saveRun(db,run,moved),/STALE_REVISION/);
      db.prepare("INSERT INTO metadata(key,value) VALUES(?,?)").run('zana:run:zp_'+'c'.repeat(16),JSON.stringify(invalid));
      assert.throws(()=>loadRun(db,'zp_'+'c'.repeat(16)),/RUN_CORRUPT/);
      for(const topic of ['hito:x','hito_x','hito%'])saveEntry(db,{projectId:run.projectId,kind:'issue',topic,body:'basura'});
      db.prepare('INSERT INTO projects(project_id,github_repo_id,repo,created_at) VALUES(?,?,?,?)').run('zp_'+'d'.repeat(16),999,'x/y',new Date().toISOString());
      saveEntry(db,{projectId:'zp_'+'d'.repeat(16),kind:'issue',topic:'hito:x',body:'otro'});
      saveEntry(db,{projectId:run.projectId,kind:'issue',topic:'pre_fijo',body:'literal'});
      assert.equal(retireRunMemory(db,run.projectId,{kind:'issue',prefix:'pre_'}),1);
      saveEntry(db,{projectId:run.projectId,kind:'issue',topic:'prefijo',body:'no like'});
      assert.equal(retireRunMemory(db,run.projectId,{kind:'issue',prefix:'pre_'}),0);
      const superseded=saveEntry(db,{projectId:run.projectId,kind:'issue',topic:'hito:historial',body:'vieja'}).seq;
      saveEntry(db,{projectId:run.projectId,kind:'issue',topic:'hito:historial',body:'vigente'});
      const resolved=saveEntry(db,{projectId:run.projectId,kind:'issue',topic:'hito:resuelto',body:'cerrada'}).seq;
      const at=new Date().toISOString();db.prepare('UPDATE project_memory SET resolved_at=? WHERE seq=?').run(at,resolved);
      applyRunMemory(db,run.projectId,null,run);
      const rows=db.prepare("SELECT topic,resolved_at FROM project_memory WHERE kind='issue'").all();
      assert.equal(rows.find(x=>x.topic==='hito:x').resolved_at!==null,true);
      assert.equal(rows.filter(x=>['hito_x','hito%'].includes(x.topic)).every(x=>x.resolved_at===null),true);
      assert.equal(db.prepare("SELECT resolved_at FROM project_memory WHERE project_id=? AND topic='hito:x'").get('zp_'+'d'.repeat(16)).resolved_at,null);
      assert.equal(db.prepare('SELECT resolved_at FROM project_memory WHERE seq=?').get(superseded).resolved_at,null);
      assert.equal(db.prepare('SELECT resolved_at FROM project_memory WHERE seq=?').get(resolved).resolved_at,at);
      const tagged=applyRunMemory(db,run.projectId,null,run,{missionId:'mission-fallback'});
      assert.ok(tagged.saved);assert.ok(db.prepare("SELECT 1 FROM project_memory WHERE project_id=? AND mission_id='mission-fallback'").get(run.projectId));
      db.exec("CREATE TRIGGER bloquea_memoria BEFORE INSERT ON project_memory WHEN NEW.kind='pending' BEGIN SELECT RAISE(ABORT,'x'); END");
      const next=claimMilestone(run,{expectedRevision:0,milestoneId:'core',missionId:'mission-claim',final:true,baseSha:'a'.repeat(40),now:new Date(Date.parse(run.updatedAt)+1).toISOString()});
      const beforeRows=db.prepare('SELECT COUNT(*) n FROM project_memory').get().n,saved=saveRun(db,run,next);
      assert.match(saved.memoryError,/MEMORY_UNAVAILABLE/);assert.equal(db.prepare('SELECT COUNT(*) n FROM project_memory').get().n,beforeRows);
      assert.equal(loadRun(db,run.projectId).revision,1);
      saveEntry(db,{projectId:run.projectId,kind:'issue',topic:'hito:basura',body:'retirar'});
      db.exec('DROP TRIGGER bloquea_memoria');
      const after=structuredClone(next);after.revision=2;after.updatedAt=new Date(Date.parse(next.updatedAt)+1).toISOString();
      const projected=saveRun(db,next,after);
      assert.equal(projected.memoryError,undefined);
      assert.equal(db.prepare('SELECT 1 FROM metadata WHERE key=?').get('zana:run-memory-dirty:'+run.projectId),undefined);
      assert.ok(db.prepare("SELECT resolved_at FROM project_memory WHERE project_id=? AND topic='hito:basura'").get(run.projectId).resolved_at);
    });
  }finally{await f.cleanup();}
});

test('temas reservados se rechazan antes de escribir',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session(),init=await f.call('zana_mission_init',{spec:{objective:'Reserva',units:[{id:'a',effect:'READ',instruction:'Leer'}]},github:{repo:'o/r',base:'main'}},s);
    const disguised=['\u200bhito:x','\u2060hito:x','\u202ehito:x','\ufeffhito:x','hi\u200dto:x','ｈｉｔｏ:x','hito：x','\u00a0hito:x','\nhito:x','HITO:X'];
    const more=['proyecto:x','Proyecto:avance','hi\u0001to:x','hi\u0600to:x','\u034Fhito:x','hi\uFE0Fto:x','hi\u180Bto:x','\u3164hito:x','hi\u0301to:x','hi\u0300to:x','h\u0308ito:x','proy\u0301ecto:x','proy\u0300ecto:x','proy\u0308ecto:x'];
    for(const topic of [...disguised,...more])
      assert.match((await f.call('zana_memory_save',{missionId:init.id,kind:'decision',topic,body:'No escribir'},s)).error,/RESERVED_TOPIC/);
    for(const topic of ['hito 3: diseño','historia:x','hitos-del-plan'])
      assert.equal((await f.call('zana_memory_save',{missionId:init.id,kind:'decision',topic,body:'Permitido'},s)).error,undefined,topic);
    assert.equal(await count("SELECT COUNT(*) n FROM project_memory WHERE topic LIKE 'hito:%' OR lower(topic) LIKE 'proyecto:%'"),0);
    const packet=(await f.call('zana_start_batch',{},s)).packets[0];
    await f.call('zana_complete_unit',{unitId:packet.unitId,token:packet.token,leaseGeneration:packet.leaseGeneration,
      outcome:{success:true,summary:'listo',evidence:['test']}},s);
    for(const field of ['decisions','conventions','pending']){
      for(const topic of [...disguised,...more]){
        const summary={done:'Trabajo de reserva terminado',decisions:[],conventions:[],pending:[],keyFiles:[]};
        summary[field]=[{topic,body:'nunca'}];
        assert.match((await f.call('zana_mission_close',{summary},s)).error,/RESERVED_TOPIC/,field+': '+JSON.stringify(topic));
      }
    }
    const seq=await remoteWrite(db=>saveEntry(db,{projectId:init.memory.projectId,kind:'pending',topic:'hito:core',body:'servidor'}).seq);
    assert.match((await f.call('zana_memory_resolve',{missionId:init.id,seq},s)).error,/RESERVED_TOPIC/);
  }finally{await f.cleanup();}
});

test('el cierre atribuye summary, decisions, conventions y pending a la sesión en contexto y búsqueda',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session();
    const init=await f.call('zana_mission_init',{spec:{objective:'Origen de cierre',units:[{id:'a',effect:'READ',instruction:'Leer'}]},github:{repo:'o/r',base:'main'}},s);
    const packet=(await f.call('zana_start_batch',{},s)).packets[0];
    await f.call('zana_complete_unit',{unitId:packet.unitId,token:packet.token,leaseGeneration:packet.leaseGeneration,
      outcome:{success:true,summary:'unidad completada',evidence:['test']}},s);
    const summary={done:'Cierre con sello de auditoría del origen de las entradas',
      decisions:[{topic:'eleccion-sello',body:'sello decisión'}],
      conventions:[{topic:'convencion-sello',body:'sello convención'}],
      pending:[{topic:'pendiente-sello',body:'sello pendiente'}],keyFiles:[]};
    const closed=await f.call('zana_mission_close',{summary},s);
    assert.equal(closed.memory.saved,4);
    const projectId=init.memory.projectId;
    const sources=[['memoryContext',(await f.call('zana_memory_context',{projectId},s)).entries],
      ['zana_memory_search',(await f.call('zana_memory_search',{query:'sello',projectId},s)).entries]];
    for(const [label,entries] of sources){
      const saved=entries.filter(e=>e.missionId===init.id);
      assert.deepEqual(saved.map(e=>e.kind).sort(),['convention','decision','pending','summary'],label);
      assert.ok(saved.every(e=>e.origin==='session'),label+' debe marcar las cuatro entradas origin:session');
    }
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
    assert.equal((await f.call('zana_session_status',{},reviewer)).writerMarked,false,'C1: el rechazo previo no marca a la revisora');
  }finally{await f.cleanup();}
});

test('los temas reservados normalizan Unicode antes de comparar',()=>{
  for(const topic of ['\u200bhito:x','hi\u200dto:x','ｈｉｔｏ：x'])
    assert.equal(reservedTopic(topic),true,topic);
});

test('run_start repara memoria pendiente sin cambiar revisión',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session(),w=await workspace(f,s);await approve(f,s,w);
    await remoteWrite(db=>db.exec("CREATE TRIGGER falla_proyeccion BEFORE INSERT ON project_memory BEGIN SELECT RAISE(ABORT,'x'); END"));
    const first=await f.call('zana_project_run_start',{workspaceId:w.workspaceId,repo:'o/r',base:'release'},s);
    assert.match(first.memoryError,/MEMORY_UNAVAILABLE/);assert.equal(first.run.revision,0);
    let detail=await remoteRead(db=>db.prepare("SELECT detail FROM remote_audit WHERE tool='zana_project_run_start' ORDER BY seq DESC LIMIT 1").get().detail);
    assert.match(JSON.parse(detail).memoryError,/MEMORY_UNAVAILABLE/);
    assert.equal((await f.call('zana_project_next',{repo:'o/r'},s)).memoryStale,true);
    const failedRepair=await f.call('zana_project_run_start',{workspaceId:w.workspaceId,repo:'o/r',base:'release'},s);
    assert.match(failedRepair.memoryError,/MEMORY_UNAVAILABLE/);assert.notEqual(failedRepair.memoryRepaired,true);
    assert.equal(await count("SELECT COUNT(*) n FROM metadata WHERE key=?", 'zana:run-memory-dirty:'+first.projectId),1);
    detail=await remoteRead(db=>db.prepare("SELECT detail FROM remote_audit WHERE tool='zana_project_run_start' ORDER BY seq DESC LIMIT 1").get().detail);
    assert.equal(JSON.parse(detail).memoryRepaired,false);
    await remoteWrite(db=>db.exec('DROP TRIGGER falla_proyeccion'));
    const retry=await f.call('zana_project_run_start',{workspaceId:w.workspaceId,repo:'o/r',base:'release'},s);
    assert.deepEqual([retry.created,retry.memoryRepaired,retry.run.revision],[false,true,0]);
    detail=await remoteRead(db=>db.prepare("SELECT detail FROM remote_audit WHERE tool='zana_project_run_start' ORDER BY seq DESC LIMIT 1").get().detail);
    assert.equal(JSON.parse(detail).memoryRepaired,true);
    const fresh=await f.call('zana_project_next',{repo:'o/r'},s);
    assert.deepEqual([fresh.memory.entries[0].topic,fresh.memoryStale],['proyecto:avance',false]);
    assert.ok(f.api.state.requests.some(x=>x.path.includes('/contents/.zanallaima.json')&&x.search.includes('ref=release')));
  }finally{await f.cleanup();}
});

test('corrida cancelada se reemplaza y conserva el estado previo',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session(),w=await workspace(f,s);await approve(f,s,w);
    const first=await f.call('zana_project_run_start',{workspaceId:w.workspaceId,repo:'o/r',base:'main'},s);
    await remoteWrite(db=>{const run=loadRun(db,first.projectId),cancel=cancelProjectRun(run,{expectedRevision:0,reason:'Cambio solicitado',now:new Date(Date.parse(run.updatedAt)+1).toISOString()});db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(cancel),'zana:run:'+run.projectId);});
    const next=await f.call('zana_project_run_start',{workspaceId:w.workspaceId,repo:'o/r',base:'main'},s);
    assert.equal(next.created,true);assert.equal(next.run.revision,2);
    const stored=await remoteRead(db=>({run:loadRun(db,first.projectId),prev:JSON.parse(db.prepare('SELECT value FROM metadata WHERE key=?').get('zana:run-prev:'+first.projectId).value)}));
    assert.deepEqual([stored.run.revision,stored.prev.status],[2,'CANCELLED']);
    assert.equal(await count("SELECT COUNT(*) n FROM metadata WHERE key=?", 'zana:run-prev:'+first.projectId),1);
  }finally{await f.cleanup();}
});

test('next elige el proyecto más reciente y limita la memoria a 4096 bytes',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session(),w=await workspace(f,s);await approve(f,s,w);
    const first=await f.call('zana_project_run_start',{workspaceId:w.workspaceId,repo:'o/r',base:'main'},s),second='zp_'+'e'.repeat(16);
    await remoteWrite(db=>{
      db.prepare('INSERT INTO projects(project_id,github_repo_id,repo,created_at) VALUES(?,?,?,?)').run(second,999,'o/r','2099-01-01T00:00:00.000Z');
      const run=structuredClone(loadRun(db,first.projectId));run.projectId=second;saveRun(db,null,run);
      for(let i=0;i<20;i++)saveEntry(db,{projectId:second,kind:'decision',topic:'larga-'+i,body:'x'.repeat(1000)});
    });
    const next=await f.call('zana_project_next',{repo:'O/R'},s);
    assert.equal(next.projectId,second);assert.equal(next.memory.truncated,true);
    assert.ok(Buffer.byteLength(JSON.stringify(next.memory))<=4096);
  }finally{await f.cleanup();}
});
