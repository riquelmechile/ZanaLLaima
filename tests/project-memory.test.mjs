import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture,AUTHOR_TOKEN} from './helpers/remote-fixture.mjs';
import {remoteRead,remoteWrite} from '../src/store.mjs';
import {memoryContext,saveEntry,saveSummary,POINTER_PATH} from '../src/project-memory.mjs';

const spec={objective:'Misión de memoria',units:[{id:'a',effect:'READ',instruction:'Leer el repo'}]};
const target={repo:'o/r',base:'main'};
const q=(sql,...p)=>remoteRead(db=>db.prepare(sql).all(...p).map(r=>({...r})));
const pointer=(projectId,githubRepoId=4242)=>JSON.stringify({zanallaima:1,projectId,githubRepoId,note:'x'});
const summary=(extra={})=>({done:'Se hizo el trabajo de la misión completo',decisions:[],conventions:[],pending:[],keyFiles:[],...extra});
// One mission: init, then cancel and archive so the next one can start.
async function initOnly(f,s){
  const init=await f.call('zana_mission_init',{spec,github:target},s);
  assert.equal(init.error,undefined,init.error);
  await f.call('zana_mission_cancel',{},s);
  assert.equal((await f.call('zana_mission_archive',{},s)).archived,true);
  return init.memory;
}
async function closeWith(f,s,sum){
  const init=await f.call('zana_mission_init',{spec,github:target},s);
  const p=(await f.call('zana_start_batch',{},s)).packets[0];
  const done=await f.call('zana_complete_unit',{unitId:p.unitId,token:p.token,leaseGeneration:p.leaseGeneration,
    outcome:{success:true,summary:'leído',evidence:['e']}},s);
  assert.equal(done.error,undefined,done.error);
  const closed=sum===undefined?null:await f.call('zana_mission_close',{summary:sum},s);
  return {init,closed};
}

test('puntero: los seis casos de resolución del proyecto',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session();
    // Ausente sin proyecto: se crea. Ausente con proyecto: se usa.
    const a=await initOnly(f,s);
    assert.match(a.projectId,/^zp_[0-9a-f]{16}$/);
    assert.deepEqual(a.pointer,{status:'POINTER_MISSING',path:POINTER_PATH,content:{zanallaima:1,projectId:a.projectId,githubRepoId:4242,
      note:'Antes de trabajar en este repositorio, pide zana_memory_context con este projectId a ZanaLLaima.'}});
    assert.deepEqual(a.context,{projectId:a.projectId,entries:[],truncated:false});
    const b=await initOnly(f,s);
    assert.deepEqual([b.projectId,b.pointer.status],[a.projectId,'POINTER_MISSING']);
    // Válido con el mismo repo: OK.
    f.api.state.files[POINTER_PATH]=pointer(a.projectId);
    assert.deepEqual([(await initOnly(f,s)).pointer.status],['OK']);
    // Válido, sin fila, pero el repo ya tiene proyecto: POINTER_STALE.
    f.api.state.files[POINTER_PATH]=pointer('zp_'+'a'.repeat(16));
    const d=await initOnly(f,s);
    assert.deepEqual([d.projectId,d.pointer.status],[a.projectId,'POINTER_STALE']);
    // Copia o fork (otro id de repo con el puntero de a): proyecto nuevo, y luego el mismo.
    f.api.state.repoId=5000;f.api.state.files[POINTER_PATH]=pointer(a.projectId,4242);
    const e=await initOnly(f,s);
    assert.equal(e.pointer.status,'POINTER_FOREIGN');
    assert.notEqual(e.projectId,a.projectId);
    assert.equal((await initOnly(f,s)).projectId,e.projectId);
    // Válido, sin fila y sin proyecto del repo: se adopta el id del puntero.
    // Fork registrado ANTES que el original: el puntero dice otro repo, no se adopta.
    f.api.state.repoId=7000;f.api.state.files[POINTER_PATH]=pointer('zp_'+'c'.repeat(16),8000);
    const fork=await initOnly(f,s);
    assert.equal(fork.pointer.status,'POINTER_FOREIGN');
    assert.notEqual(fork.projectId,'zp_'+'c'.repeat(16));
    // Sin githubRepoId tampoco se adopta: id nuevo y el puntero se reescribe.
    f.api.state.repoId=7100;f.api.state.files[POINTER_PATH]=JSON.stringify({zanallaima:1,projectId:'zp_'+'d'.repeat(16)});
    const bare=await initOnly(f,s);
    assert.equal(bare.pointer.status,'POINTER_STALE');
    assert.notEqual(bare.projectId,'zp_'+'d'.repeat(16));
    // El original llega después con su propio puntero: adopta el id que le corresponde.
    f.api.state.repoId=8000;f.api.state.files[POINTER_PATH]=pointer('zp_'+'c'.repeat(16),8000);
    const orig=await initOnly(f,s);
    assert.deepEqual([orig.projectId,orig.pointer.status],['zp_'+'c'.repeat(16),'OK']);
    f.api.state.repoId=6000;f.api.state.files[POINTER_PATH]=pointer('zp_'+'b'.repeat(16),6000);
    const g=await initOnly(f,s);
    assert.deepEqual([g.projectId,g.pointer.status],['zp_'+'b'.repeat(16),'OK']);
    // Ilegible: cuenta como ausente y se informa.
    f.api.state.files[POINTER_PATH]='{nope';
    const h=await initOnly(f,s);
    assert.deepEqual([h.projectId,h.pointer.status],[g.projectId,'POINTER_MISSING']);
    assert.match(h.pointer.invalid,/not valid JSON/);
    f.api.state.files[POINTER_PATH]=JSON.stringify({zanallaima:2,projectId:g.projectId});
    assert.match((await initOnly(f,s)).pointer.invalid,/not a ZanaLLaima pointer/);
    const rows=await q('SELECT project_id,github_repo_id FROM projects ORDER BY github_repo_id');
    assert.deepEqual(rows.map(r=>r.github_repo_id),[4242,5000,6000,7000,7100,8000]);
    f.api.state.repoId=null;
    const noId=await f.call('zana_mission_init',{spec,github:target},s);
    assert.match(noId.memory.error,/REPO_ID_UNAVAILABLE/);
    await f.call('zana_mission_cancel',{},s);await f.call('zana_mission_archive',{},s);
    // GitHub caído: la misión igual se crea, con memory.error y sin contexto.
    f.api.state.failNext={status:500,message:'boom'};
    const down=await f.call('zana_mission_init',{spec,github:target},s);
    assert.ok(down.id);
    assert.match(down.memory.error,/HTTP 500/);
    assert.equal(down.memory.context,undefined);
    assert.equal((await q('SELECT project_id FROM remote_missions WHERE mission_id=?',down.id))[0].project_id,null);
  }finally{await f.cleanup();}
});

test('close: resumen obligatorio, entradas redactadas, supersesión y contexto en la misión siguiente',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session();
    const first=await closeWith(f,s);
    assert.match((await f.call('zana_mission_close',{},s)).error,/SUMMARY_REQUIRED: .*summary/);
    assert.match((await f.call('zana_mission_close',{summary:{...summary(),done:'corto'}},s)).error,/SUMMARY_REQUIRED: .*summary\.done Too small/);
    const sum=summary({decisions:[{topic:'estilo',body:'Sin punto y coma; token '+AUTHOR_TOKEN}],
      conventions:[{topic:'tests',body:'node --test por archivo'}],pending:[{topic:'docs',body:'Falta la guía; claves sk-proj-'+'Q'.repeat(30)+' AKIA'+'B'.repeat(16)+' xoxb-1234567890-abc'}],keyFiles:['src/a.mjs']});
    const closed=(await f.call('zana_mission_close',{summary:sum},s));
    assert.deepEqual([closed.status,closed.memory],['CLOSED',{projectId:first.init.memory.projectId,saved:4,superseded:0}]);
    const rows=await q('SELECT kind,topic,body,mission_id,superseded_by FROM project_memory ORDER BY seq');
    assert.deepEqual(rows.map(r=>r.kind),['summary','decision','convention','pending']);
    assert.equal(rows[0].topic,first.init.id);
    assert.match(rows[0].body,/Archivos clave: src\/a\.mjs/);
    assert.equal(rows[1].body,'Sin punto y coma; token [redacted]');
    // Credential shapes not in the server's environment are dropped too.
    assert.equal(rows[3].body,'Falta la guía; claves [redacted] [redacted] [redacted]');
    await f.call('zana_mission_archive',{},s);
    // La misión siguiente trae el contexto y una decisión con el mismo topic supersede la anterior.
    const second=await closeWith(f,s,summary({decisions:[{topic:'estilo',body:'Con punto y coma'}]}));
    const ctx=second.init.memory.context;
    assert.deepEqual(ctx.entries.map(e=>e.kind),['convention','decision','pending','summary']);
    assert.deepEqual(Object.keys(ctx.entries[0]),['seq','kind','topic','body','missionId','sha','at']);
    assert.equal(second.closed.memory.superseded,1);
    const estilo=await q("SELECT seq,body,superseded_by FROM project_memory WHERE topic='estilo' ORDER BY seq");
    assert.deepEqual(estilo.map(r=>r.superseded_by),[estilo[1].seq,null]);
  }finally{await f.cleanup();}
});

test('close de una misión sin proyecto (0.6.0 o GitHub caído en el init) lo resuelve al cerrar',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session();
    const {init}=await closeWith(f,s);
    await remoteWrite(db=>db.prepare('UPDATE remote_missions SET project_id=NULL').run());
    f.api.state.failNext={status:502,message:'down'};
    assert.match((await f.call('zana_mission_close',{summary:summary()},s)).error,/MEMORY_UNAVAILABLE: .*HTTP 502/);
    assert.equal((await f.call('zana_mission_status',{},s)).state,'ACTIVE');
    const closed=await f.call('zana_mission_close',{summary:summary()},s);
    assert.equal(closed.memory.projectId,init.memory.projectId);
    assert.equal(closed.memory.pointer.status,'POINTER_MISSING');
    assert.equal((await q('SELECT project_id FROM remote_missions'))[0].project_id,init.memory.projectId);
  }finally{await f.cleanup();}
});

test('el contexto se corta a maxBytes con truncated:true, en el orden del diseño',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session();
    const {projectId}=await initOnly(f,s);
    await remoteWrite(db=>{
      saveEntry(db,{projectId,kind:'summary',topic:'m-old',body:'resumen'});
      saveEntry(db,{projectId,kind:'issue',topic:'bug',body:'falla'});
      const p=saveEntry(db,{projectId,kind:'pending',topic:'resuelto',body:'ya no'});
      db.prepare('UPDATE project_memory SET resolved_at=? WHERE seq=?').run('2026-01-01T00:00:00.000Z',p.seq);
      for(let i=0;i<20;i++)saveEntry(db,{projectId,kind:'decision',topic:'d'+i,body:'x'.repeat(400)});
    });
    const small=await remoteRead(db=>memoryContext(db,projectId));
    assert.equal(small.truncated,true);
    assert.ok(Buffer.byteLength(JSON.stringify(small))<=4096);
    assert.equal(small.entries[0].topic,'d19');
    const big=await remoteRead(db=>memoryContext(db,projectId,{maxBytes:16384}));
    assert.deepEqual([big.truncated,big.entries.length],[false,22]);
    assert.deepEqual(big.entries.slice(-2).map(e=>e.kind),['issue','summary']);
    // Small entries after the cut still get in: the issue and the summary fit at 4 KB.
    assert.deepEqual(small.entries.slice(-2).map(e=>e.kind),['issue','summary']);
    // One entry that cannot fit does not empty the context.
    await remoteWrite(db=>saveEntry(db,{projectId,kind:'convention',topic:'enorme',body:'\u0001'.repeat(1000)}));
    const odd=await remoteRead(db=>memoryContext(db,projectId));
    assert.ok(odd.entries.length>0&&!odd.entries.some(e=>e.topic==='enorme'));
    // A long done keeps its key files.
    const long=await remoteWrite(db=>{
      saveSummary(db,{projectId,missionId:'m-long',summary:summary({done:'z'.repeat(1000),keyFiles:['src/clave.mjs']})});
      return db.prepare("SELECT body FROM project_memory WHERE topic='m-long'").get().body;
    });
    assert.ok(long.length<=1000&&long.endsWith('Archivos clave: src/clave.mjs'));
    assert.throws(()=>saveEntry({},{kind:'nope'}),/INVALID_MEMORY_KIND/);
  }finally{await f.cleanup();}
});
