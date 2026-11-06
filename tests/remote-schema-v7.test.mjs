import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMission} from '../src/core.mjs';
import {transact,readState,databasePath,storageStatus,backupState,restoreBackup,
  remoteWrite,remoteRead,ensureSchema} from '../src/store.mjs';

const REMOTE=['remote_sessions','remote_missions','remote_activity','remote_checks','review_tickets','remote_audit'];
const spec=()=>({objective:'Remote schema fixture',units:[{id:'scan',effect:'READ',instruction:'Read it'}]});
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'zana-v7-'));
  return {dir,file:join(dir,'state.json'),cleanup:()=>rm(dir,{recursive:true,force:true})};
}
const ticket=(missionId,state,id='t1')=>({ticket_id:id,code_hash:'h-'+id,mission_id:missionId,repo:'o/r',
  pr_number:1,sha:'a'.repeat(40),author_session:'s-author',created_at:new Date().toISOString(),
  expires_at:new Date(Date.now()+3600e3).toISOString(),state,updated_at:new Date().toISOString()});
const insert=(db,table,row)=>{const k=Object.keys(row);
  db.prepare('INSERT OR REPLACE INTO '+table+'('+k.join(',')+') VALUES('+k.map(()=>'?').join(',')+')').run(...k.map(x=>row[x]));};

test('v6 database migrates to v7 adding remote tables without touching mission state',async()=>{
  const f=await fixture();
  try{
    const initial=await transact(()=>createMission(spec()),f.file);
    const db=new DatabaseSync(databasePath(f.file));
    try{
      for(const t of REMOTE)db.exec('DROP TABLE '+t);
      db.exec('PRAGMA user_version=6');
    }finally{db.close();}
    await assert.rejects(readState(f.file),/Unsupported database schema/);
    assert.equal((await ensureSchema(f.file)).schemaVersion,7);
    assert.equal((await storageStatus(f.file)).schemaVersion,7);
    assert.equal((await readState(f.file)).id,initial.id);
    const tables=await remoteRead(db=>db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name),f.file);
    for(const t of REMOTE)assert.ok(tables.includes(t),t);
  }finally{await f.cleanup();}
});

test('remoteRead without database returns null handles; remoteWrite rolls back on error',async()=>{
  const f=await fixture();
  try{
    assert.deepEqual(await remoteRead((db,m)=>[db,m],f.file),[null,null]);
    await transact(()=>createMission(spec()),f.file);
    await assert.rejects(remoteWrite(db=>{insert(db,'remote_sessions',{session_id:'x',host:'h',client_id:'c',
      created_at:'2026-01-01T00:00:00.000Z',last_seen_at:'2026-01-01T00:00:00.000Z'});throw Error('boom');},f.file),/boom/);
    assert.equal(await remoteRead(db=>db.prepare('SELECT COUNT(*) n FROM remote_sessions').get().n,f.file),0);
  }finally{await f.cleanup();}
});

test('restore never revives a consumed ticket and unions remote history',async()=>{
  const f=await fixture();
  try{
    const m=await transact(()=>createMission(spec()),f.file);
    await remoteWrite(db=>{insert(db,'review_tickets',ticket(m.id,'OPEN'));
      insert(db,'review_tickets',ticket(m.id,'OPEN','t2'));},f.file);
    const backup=join(f.dir,'b.sqlite');
    await backupState(backup,f.file);
    await remoteWrite(db=>{
      insert(db,'review_tickets',{...ticket(m.id,'CLAIMED'),reviewer_session:'s-rev'});
      insert(db,'remote_sessions',{session_id:'s-rev',host:'gpt',client_id:'c',created_at:'2026-01-01T00:00:00.000Z',last_seen_at:'2026-01-01T00:00:00.000Z'});
      insert(db,'remote_activity',{session_id:'s-a',mission_id:m.id,kind:'WRITE',tool:'x',created_at:'2026-01-01T00:00:00.000Z'});
      insert(db,'remote_audit',{at:'2026-01-01T00:00:00.000Z',host:'gpt',session_id:'s-a',tool:'x',mission_id:m.id,outcome:'OK',args_hmac:'k',detail:null});
      db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES('remote_audit_key','live-key')").run();
      db.prepare("INSERT INTO review_receipts(review_id,lens_id,token,result,created_at) VALUES('t1','risk','h','{}','x')").run();
    },f.file);
    process.env.ZANA_RESTORE_OFFLINE='1';
    try{
      // A newer lens receipt is a durable receipt: refused without consent.
      await assert.rejects(restoreBackup(backup,f.file,{offline:true}),/newer durable receipt/);
      // Even with --force-data-loss the consumed ticket state is merged back.
      await restoreBackup(backup,f.file,{offline:true,forceDataLoss:true});
    }finally{delete process.env.ZANA_RESTORE_OFFLINE;}
    const after=await remoteRead(db=>({
      t1:db.prepare("SELECT state,reviewer_session FROM review_tickets WHERE ticket_id='t1'").get(),
      t2:db.prepare("SELECT state FROM review_tickets WHERE ticket_id='t2'").get(),
      sessions:db.prepare('SELECT COUNT(*) n FROM remote_sessions').get().n,
      activity:db.prepare('SELECT COUNT(*) n FROM remote_activity').get().n,
      audit:db.prepare('SELECT COUNT(*) n FROM remote_audit').get().n,
      key:db.prepare("SELECT value FROM metadata WHERE key='remote_audit_key'").get()?.value,
      lens:db.prepare("SELECT COUNT(*) n FROM review_receipts WHERE review_id='t1'").get().n,
    }),f.file);
    assert.deepEqual({...after.t1},{state:'CLAIMED',reviewer_session:'s-rev'});
    assert.equal(after.t2.state,'OPEN');
    assert.equal(after.sessions,1);
    assert.equal(after.activity,1);
    assert.equal(after.audit,1);
    assert.equal(after.key,'live-key');
    assert.equal(after.lens,1);
  }finally{await f.cleanup();}
});

test('blind restore expires every open ticket of the backup',async()=>{
  const f=await fixture();
  try{
    const m=await transact(()=>createMission(spec()),f.file);
    await remoteWrite(db=>insert(db,'review_tickets',ticket(m.id,'OPEN')),f.file);
    const backup=join(f.dir,'b.sqlite');
    await backupState(backup,f.file);
    for(const s of ['','-wal','-shm'])await rm(databasePath(f.file)+s,{force:true});
    process.env.ZANA_RESTORE_OFFLINE='1';
    try{await restoreBackup(backup,f.file,{offline:true,forceDataLoss:true});}
    finally{delete process.env.ZANA_RESTORE_OFFLINE;}
    assert.equal(await remoteRead(db=>db.prepare("SELECT state FROM review_tickets").get().state,f.file),'EXPIRED');
  }finally{await f.cleanup();}
});

test('history trimming keeps lens receipts of open tickets',async()=>{
  const f=await fixture();
  try{
    const m=await transact(()=>createMission(spec()),f.file);
    await remoteWrite(db=>{insert(db,'review_tickets',ticket(m.id,'CLAIMED'));
      db.prepare("INSERT INTO review_receipts(review_id,lens_id,token,result,created_at) VALUES('t1','risk','h','{}','x')").run();},f.file);
    await transact(s=>{s.revision++;return s;},f.file);
    assert.equal(await remoteRead(db=>db.prepare('SELECT COUNT(*) n FROM review_receipts').get().n,f.file),1);
  }finally{await f.cleanup();}
});

test('restore merge: duplicates are not doubled, a less advanced live ticket never downgrades the backup',async()=>{
  const f=await fixture();
  try{
    const m=await transact(()=>createMission(spec()),f.file);
    const act={session_id:'s-a',mission_id:m.id,kind:'WRITE',tool:'x',created_at:'2026-01-01T00:00:00.000Z'};
    const aud={at:'2026-01-01T00:00:00.000Z',host:'gpt',session_id:'s-a',tool:'x',mission_id:m.id,outcome:'OK',args_hmac:'k',detail:null};
    await remoteWrite(db=>{
      insert(db,'remote_activity',act);insert(db,'remote_audit',aud);
      insert(db,'review_tickets',{...ticket(m.id,'FINALIZED'),reviewer_session:'s-rev'});
      insert(db,'review_tickets',ticket(m.id,'WEIRD','t3'));
    },f.file);
    const backup=join(f.dir,'b.sqlite');
    await backupState(backup,f.file);
    // Live diverges by hand: ticket t1 back to OPEN (must not win), t3 unknown state (ranked as final).
    await remoteWrite(db=>{
      insert(db,'review_tickets',ticket(m.id,'OPEN'));
      insert(db,'review_tickets',ticket(m.id,'OPEN','t3'));
    },f.file);
    process.env.ZANA_RESTORE_OFFLINE='1';
    try{await restoreBackup(backup,f.file,{offline:true});}
    finally{delete process.env.ZANA_RESTORE_OFFLINE;}
    const after=await remoteRead(db=>({
      t1:db.prepare("SELECT state FROM review_tickets WHERE ticket_id='t1'").get().state,
      t3:db.prepare("SELECT state FROM review_tickets WHERE ticket_id='t3'").get().state,
      activity:db.prepare('SELECT COUNT(*) n FROM remote_activity').get().n,
      audit:db.prepare('SELECT COUNT(*) n FROM remote_audit').get().n,
      key:db.prepare("SELECT value FROM metadata WHERE key='remote_audit_key'").get()?.value??null,
    }),f.file);
    assert.equal(after.t1,'FINALIZED');
    assert.equal(after.t3,'WEIRD');
    assert.equal(after.activity,1);
    assert.equal(after.audit,1);
    assert.equal(after.key,null);
  }finally{await f.cleanup();}
});
