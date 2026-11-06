// Endurecimiento de la búsqueda FTS (WARNING de la 4R de #10 y sugerencias de #11 y #12).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {remoteRead,remoteWrite,ensureSchema,setupMemoryFts} from '../src/store.mjs';
import {saveEntry,searchMemory} from '../src/project-memory.mjs';
import {REMOTE_INSTRUCTIONS} from '../src/remote.mjs';
import {redactStored} from '../src/redact.mjs';

const pid='zp_'+'f'.repeat(16);
const CREATE="CREATE VIRTUAL TABLE project_memory_fts USING fts5(topic,body,content='project_memory',content_rowid='seq')";
async function store(){
  const dir=await mkdtemp(join(tmpdir(),'zana-fts-')),file=join(dir,'state.json');
  await ensureSchema(file);
  const write=fn=>remoteWrite(fn,file);
  const read=fn=>remoteRead(fn,file),search=query=>read(db=>searchMemory(db,{query,projectId:pid}));
  const bodies=async query=>(await search(query)).entries.map(e=>e.body);
  return {write,read,search,bodies,save:body=>write(db=>saveEntry(db,{projectId:pid,kind:'issue',topic:'t'+body.length,body})),
    cleanup:()=>rm(dir,{recursive:true,force:true})};
}

test('W-FTS: una tabla FTS recreada vacía se reconstruye al reconectar',async()=>{
  const s=await store();
  try{
    await s.save('Sin punto y coma');
    await s.write(db=>db.exec('DROP TABLE project_memory_fts;'+CREATE));
    // La lectura no reconecta en escritura: el índice sigue vacío.
    assert.deepEqual(await s.bodies('punto'),[]);
    await s.write(()=>{});
    const found=await s.search('punto');
    assert.deepEqual([found.mode,found.entries.map(e=>e.body)],['fts',['Sin punto y coma']]);
  }finally{await s.cleanup();}
});

test('W-FTS: una fila escrita sin su trigger queda indexada al reconectar',async()=>{
  const s=await store();
  try{
    await s.save('El cóndor vuela alto');
    await s.write(db=>{
      db.exec('DROP TRIGGER project_memory_ai');
      saveEntry(db,{projectId:pid,kind:'issue',topic:'zorro',body:'Un zorro en el patio'});
    });
    await s.write(()=>{});
    assert.deepEqual(await s.bodies('zorro'),['Un zorro en el patio']);
    // Sin el trigger de update el número de filas no cambia: igual se reconstruye.
    await s.write(db=>{
      db.exec('DROP TRIGGER project_memory_au');
      db.prepare("UPDATE project_memory SET body='Un puma en el cerro' WHERE body LIKE '%cóndor%'").run();
    });
    await s.write(()=>{});
    assert.deepEqual(await s.bodies('puma'),['Un puma en el cerro']);
    assert.deepEqual(await s.bodies('cóndor'),[]);
  }finally{await s.cleanup();}
});

test('W-FTS: si el rebuild falla queda metadata.fts=0 y la búsqueda usa LIKE',async()=>{
  const s=await store();
  try{
    await s.save('Sin punto y coma');
    await s.write(db=>{
      db.exec('DROP TABLE project_memory_fts');
      setupMemoryFts({prepare:sql=>db.prepare(sql),exec:sql=>{if(/'rebuild'/.test(sql))throw new Error('disk I/O error');return db.exec(sql);}});
    });
    const r=await s.search('punto');
    assert.deepEqual([r.mode,'fallback' in r,r.entries.length],['like',false,1]);
  }finally{await s.cleanup();}
});
