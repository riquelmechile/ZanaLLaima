import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {remoteFixture,AUTHOR_TOKEN} from './helpers/remote-fixture.mjs';
import {remoteRead,remoteWrite,setupMemoryFts} from '../src/store.mjs';

const spec={objective:'Misión de memoria',units:[{id:'a',effect:'READ',instruction:'Leer el repo'}]};
const q=(sql,...p)=>remoteRead(db=>db.prepare(sql).all(...p).map(r=>({...r})));
async function next(f,s){
  await f.call('zana_mission_cancel',{},s);await f.call('zana_mission_archive',{},s);
  return f.call('zana_mission_init',{spec,github:{repo:'o/r',base:'main'}},s);
}

test('memory tools: save redacta y supersede, resolve, contexto por misión, proyecto o la activa',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session();
    const init=await f.call('zana_mission_init',{spec,github:{repo:'o/r',base:'main'}},s);
    const {id}=init,{projectId}=init.memory;
    const save=(kind,topic,body,mid=id)=>f.call('zana_memory_save',{missionId:mid,kind,topic,body},s);
    const first=await save('decision','estilo','Sin punto y coma, token '+AUTHOR_TOKEN);
    assert.deepEqual([first.projectId,first.superseded],[projectId,[]]);
    const second=await save('decision','estilo','Con punto y coma');
    assert.deepEqual(second.superseded,[first.seq]);
    assert.equal((await q('SELECT body FROM project_memory WHERE seq=?',first.seq))[0].body,'Sin punto y coma, token [redacted]');
    assert.match((await save('summary','x','resumen falso')).error,/INVALID_MEMORY_KIND/);
    assert.match((await save('issue','bug','falla','00000000-0000-0000-0000-000000000000')).error,/MISSION_NOT_ACTIVE/);
    const pending=await save('pending','docs','Falta la guía');
    const ctx=await f.call('zana_memory_context',{},s);
    assert.deepEqual([ctx.repo,ctx.projectId,ctx.entries.map(e=>e.kind)],['o/r',projectId,['decision','pending']]);
    assert.deepEqual(await f.call('zana_memory_context',{missionId:id},s),ctx);
    assert.deepEqual(await f.call('zana_memory_context',{projectId},s),ctx);
    assert.match((await f.call('zana_memory_context',{projectId,missionId:id},s)).error,/INVALID_ARGUMENTS/);
    assert.match((await f.call('zana_memory_context',{projectId:'zp_'+'0'.repeat(16)},s)).error,/NO_PROJECT: unknown project/);
    const resolved=await f.call('zana_memory_resolve',{missionId:id,seq:pending.seq},s);
    assert.ok(resolved.resolvedAt);
    assert.equal((await f.call('zana_memory_resolve',{missionId:id,seq:pending.seq},s)).resolvedAt,resolved.resolvedAt);
    assert.match((await f.call('zana_memory_resolve',{missionId:id,seq:second.seq},s)).error,/NOT_PENDING/);
    assert.match((await f.call('zana_memory_resolve',{missionId:'00000000-0000-0000-0000-000000000000',seq:1},s)).error,/MISSION_NOT_ACTIVE/);
    assert.deepEqual((await f.call('zana_memory_context',{},s)).entries.map(e=>e.kind),['decision']);
    const audit=await q("SELECT tool,category FROM remote_audit WHERE tool LIKE 'zana_memory_%' AND outcome='OK' ORDER BY seq");
    assert.deepEqual([...new Set(audit.map(a=>a.tool+':'+a.category))],
      ['zana_memory_save:write','zana_memory_context:read','zana_memory_resolve:write']);
    // A mission without a project resolves it on the first save.
    const other=await next(f,s);
    await remoteWrite(db=>db.prepare('UPDATE remote_missions SET project_id=NULL WHERE mission_id=?').run(other.id));
    assert.match((await f.call('zana_memory_context',{},s)).error,/NO_PROJECT: that mission has no project yet/);
    const late=await save('issue','bug','falla','');
    assert.match(late.error,/MISSION_NOT_ACTIVE/);
    const saved=await save('issue','bug','falla al compilar',other.id);
    assert.deepEqual([saved.projectId,saved.pointer.status],[projectId,'POINTER_MISSING']);
  }finally{await f.cleanup();}
});

test('memory search: proyecto actual, all:true, supersedidas al final y LIKE con fts=0',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session();
    assert.match((await f.call('zana_memory_search',{query:'punto'},s)).error,/NO_PROJECT/);
    const a=await f.call('zana_mission_init',{spec,github:{repo:'o/r',base:'main'}},s);
    const save=(mid,topic,body)=>f.call('zana_memory_save',{missionId:mid,kind:'decision',topic,body},s);
    await save(a.id,'estilo','Sin punto y coma');
    await save(a.id,'estilo','Con punto y coma al final');
    await save(a.id,'errores','Lanzar TypeError');
    f.api.state.repoId=777;
    const b=await next(f,s);
    assert.notEqual(b.memory.projectId,a.memory.projectId);
    await save(b.id,'estilo','Punto y coma obligatorio');
    const here=await f.call('zana_memory_search',{query:'punto coma'},s);
    assert.deepEqual([here.mode,here.scope,here.entries.length],['fts',b.memory.projectId,1]);
    const there=await f.call('zana_memory_search',{query:'punto',projectId:a.memory.projectId},s);
    assert.deepEqual(there.entries.map(e=>Boolean(e.superseded)),[false,true]);
    const all=await f.call('zana_memory_search',{query:'punto',all:true,limit:2},s);
    assert.deepEqual([all.scope,all.entries.length,all.entries.every(e=>!e.superseded)],['all',2,true]);
    assert.equal((await f.call('zana_memory_search',{query:'punto',all:true},s)).entries.length,3);
    assert.match((await f.call('zana_memory_search',{query:' x'},s)).error,/INVALID_QUERY/);
    // Como zana_memory_context: projectId y all:true no van juntos, y un projectId desconocido es NO_PROJECT.
    assert.match((await f.call('zana_memory_search',{query:'punto',projectId:a.memory.projectId,all:true},s)).error,/^INVALID_ARGUMENTS: /);
    assert.equal((await f.call('zana_memory_search',{query:'punto',projectId:a.memory.projectId,all:false},s)).entries.length,2);
    assert.match((await f.call('zana_memory_search',{query:'punto',projectId:'zp_'+'0'.repeat(16)},s)).error,/^NO_PROJECT: unknown project zp_0{16}/);
    // Only symbols: no FTS words, LIKE on the raw text.
    assert.deepEqual((await f.call('zana_memory_search',{query:'%-',all:true},s)).mode,'like');
    // A manual delete keeps the FTS index consistent (AFTER DELETE trigger).
    const ok=await remoteWrite(db=>{
      const extra=db.prepare("INSERT INTO project_memory(project_id,kind,topic,body,created_at) VALUES('zp_0000000000000000','issue','borrar','fila borrable','2026-01-01')").run().lastInsertRowid;
      db.prepare('DELETE FROM project_memory WHERE seq=?').run(extra);
      db.exec("INSERT INTO project_memory_fts(project_memory_fts) VALUES('integrity-check')");
      return true;
    });
    assert.equal(ok,true);
    await remoteWrite(db=>db.prepare("UPDATE metadata SET value='0' WHERE key='fts'").run());
    const like=await f.call('zana_memory_search',{query:'coma al',all:true},s);
    assert.deepEqual([like.mode,like.entries.map(e=>e.body)],['like',['Con punto y coma al final']]);
    // A SQLite without FTS5 records fts='0' instead of failing the migration.
    const raw=new DatabaseSync(':memory:');
    raw.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    setupMemoryFts({prepare:sql=>raw.prepare(sql),exec:sql=>{if(/VIRTUAL/.test(sql))throw new Error('no such module: fts5');return raw.exec(sql);}});
    assert.equal(raw.prepare("SELECT value FROM metadata WHERE key='fts'").get().value,'0');
    raw.close();
  }finally{await f.cleanup();}
});

test('memory tools: la revisora lee el contexto pero no guarda ni resuelve (REVIEWER_READ_ONLY)',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId}=await f.authorReady();
    const p=await f.call('zana_memory_save',{missionId,kind:'pending',topic:'docs',body:'Falta la guía'},author);
    const t=await f.call('zana_review_request',{missionId},author);
    const r=await f.session();
    assert.equal((await f.call('zana_review_claim',{ticket:t.ticket},r)).error,undefined);
    assert.deepEqual((await f.call('zana_memory_context',{missionId},r)).entries.map(e=>e.topic),['docs']);
    assert.equal((await f.call('zana_memory_search',{query:'guía'},r)).entries.length,1);
    assert.match((await f.call('zana_memory_save',{missionId,kind:'issue',topic:'bug',body:'x'.repeat(5)},r)).error,/REVIEWER_READ_ONLY/);
    assert.match((await f.call('zana_memory_resolve',{missionId,seq:p.seq},r)).error,/REVIEWER_READ_ONLY/);
    assert.equal((await q('SELECT COUNT(*) n FROM project_memory'))[0].n,1);
  }finally{await f.cleanup();}
});
