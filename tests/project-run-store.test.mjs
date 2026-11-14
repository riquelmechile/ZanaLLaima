import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture} from './helpers/remote-fixture.mjs';
import {remoteWrite} from '../src/store.mjs';

test('memoryContext excluye entradas retiradas de cualquier tipo',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session();
    const spec={objective:'Memoria retirada',units:[{id:'read',effect:'READ',instruction:'Leer'}]};
    const init=await f.call('zana_mission_init',{spec,github:{repo:'o/r',base:'main'}},s);
    const saved=await f.call('zana_memory_save',{missionId:init.id,kind:'issue',topic:'viejo',body:'Ya resuelto'},s);
    assert.equal(saved.error,undefined,saved.error);
    await remoteWrite(db=>db.prepare('UPDATE project_memory SET resolved_at=? WHERE seq=?').run(new Date().toISOString(),saved.seq));
    const ctx=await f.call('zana_memory_context',{projectId:init.memory.projectId},s);
    assert.equal(ctx.entries.some(e=>e.topic==='viejo'),false);
  }finally{await f.cleanup();}
});
