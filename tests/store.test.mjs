import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMission, startBatch, completeUnit } from '../src/core.mjs';
import { openReview } from '../src/review.mjs';
import { transact, readState, databasePath, storageStatus, readHistory,
  readReviewArchive, backupState, restoreBackup, migrateLegacy } from '../src/store.mjs';

const input = () => ({ objective:'Inspect the project safely',
  authorization:{writesAllowed:false,allowedPaths:[]},
  units:[{id:'scan',effect:'READ',instruction:'Inspect the source files'}] });
const fixture = async () => {
  const dir=await mkdtemp(join(tmpdir(),'zana-sqlite-'));
  return {dir,file:join(dir,'state.json'),cleanup:()=>rm(dir,{recursive:true,force:true})};
};

test('SQLite WAL keeps normalized units and durable receipts across reopen',async()=>{
  const f=await fixture();
  try{
    const state=await transact(()=>createMission(input()),f.file);
    assert.equal((await readState(f.file)).id,state.id);
    const info=await storageStatus(f.file);
    assert.equal(info.backend,'SQLITE_WAL');
    assert.equal(info.journalMode,'wal');
    assert.equal(info.schemaVersion,1);
    assert.equal(info.integrity,'ok');
    const unit=await transact(s=>{
      const packet=startBatch(s).batch.packets[0];
      assert.equal(packet.unitId,'scan');
      return s;
    },f.file);
    assert.equal(unit.units[0].run.leaseGeneration,1);
    const token=unit.units[0].run.token;
    await transact(s=>completeUnit(s,'scan',token,{
      success:true,summary:'Verified input and expected behavior',
      evidence:['Source files reviewed and matching checks executed'],
    }),f.file);
    const reread=await readState(f.file);
    assert.equal(reread.units[0].status,'DONE');
    assert.equal((await storageStatus(f.file)).workReceipts,1);
    const events=await readHistory({limit:20},f.file);
    assert.ok(events.items.some(e=>e.category==='UNIT_DONE'));
    assert.equal(await readFile(databasePath(f.file)).then(x=>x.subarray(0,16).toString()),'SQLite format 3\u0000');
    assert.equal((await readState(f.file)).revision,reread.revision);
  }finally{await f.cleanup();}
});

test('legacy JSON migrates without erasing original and preserves a binary backup',async()=>{
  const f=await fixture();
  try{
    const previous=createMission(input());
    const serialized=JSON.stringify(previous,null,2)+'\n';
    await writeFile(f.file,serialized);
    assert.equal((await readState(f.file)).id,previous.id);
    const migrated=await migrateLegacy(f.file);
    assert.equal(migrated.id,previous.id);
    assert.equal(await readFile(f.file,'utf8'),serialized);
    assert.equal(await readFile(f.file+'.pre-sqlite.bak','utf8'),serialized);
    assert.equal((await storageStatus(f.file)).backend,'SQLITE_WAL');
    assert.equal((await readState(f.file)).id,previous.id);
  }finally{await f.cleanup();}
});

test('a thrown transaction rolls back every changed row and revision',async()=>{
  const f=await fixture();
  try{
    const old=await transact(()=>createMission(input()),f.file);
    await assert.rejects(transact(s=>{
      s.objective='A change that cannot be committed';s.revision+=1;
      throw Error('test rollback');
    },f.file),/test rollback/);
    const latest=await readState(f.file);
    assert.equal(latest.objective,old.objective);
    assert.equal(latest.revision,old.revision);
    assert.equal((await storageStatus(f.file)).integrity,'ok');
  }finally{await f.cleanup();}
});

test('review history is archived separately and paginated',async()=>{
  const f=await fixture();
  try{
    await transact(()=>createMission(input()),f.file);
    await transact(s=>{s.units[0].status='DONE';s.units[0].run={token:'test-run'};s.units[0].result={success:true,summary:'Checked',evidence:['test']};s.revision++;return s;},f.file);
    for(let i=0;i<4;i++)await transact(s=>{
      openReview(s,{candidateSha:i.toString(16).repeat(40)});return s;
    },f.file);
    const first=await readReviewArchive({limit:2},f.file);
    assert.equal(first.items.length,2);
    assert.ok(first.nextCursor);
    const second=await readReviewArchive({limit:2,before:first.nextCursor},f.file);
    assert.equal(second.items.length,1);
    assert.equal(second.nextCursor,null);
    assert.equal((await storageStatus(f.file)).archivedReviews,3);
    assert.equal((await readState(f.file)).reviewHistory,undefined);
  }finally{await f.cleanup();}
});

test('backup and explicit offline restore retain integrity and reject running backup',async()=>{
  const f=await fixture();
  try{
    await transact(()=>createMission(input()),f.file);
    const dest=join(f.dir,'safe-backup.sqlite');
    assert.equal((await backupState(dest,f.file)).integrity,'ok');
    await assert.rejects(backupState(dest,f.file),/destination/);
    await transact(s=>{ startBatch(s);return s; },f.file);
    process.env.ZANA_RESTORE_OFFLINE='1';
    try{
      const restore=await restoreBackup(dest,f.file,{offline:true});
      assert.equal(restore.restored,true);
      assert.equal((await readState(f.file)).units[0].status,'PENDING');
      assert.equal((await storageStatus(f.file)).integrity,'ok');
      assert.ok(restore.quarantinePath);
    }finally{delete process.env.ZANA_RESTORE_OFFLINE;}
  }finally{await f.cleanup();}
});

test('corrupt database is never silently reset, recovery needs explicit operator mode',async()=>{
  const f=await fixture();
  try{
    await transact(()=>createMission(input()),f.file);
    const backupFile=join(f.dir,'recovery.sqlite');
    await backupState(backupFile,f.file);
    await writeFile(databasePath(f.file),'broken sqlite database');
    await assert.rejects(readState(f.file));
    await assert.rejects(restoreBackup(backupFile,f.file),/explicit offline/);
    process.env.ZANA_RESTORE_OFFLINE='1';
    try{await restoreBackup(backupFile,f.file,{offline:true});}
    finally{delete process.env.ZANA_RESTORE_OFFLINE;}
    assert.equal((await storageStatus(f.file)).integrity,'ok');
  }finally{await f.cleanup();}
});
