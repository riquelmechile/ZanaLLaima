import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMission, startBatch, completeUnit } from '../src/core.mjs';
import { openReview, startReviewBatch, submitReview, reviewStatus } from '../src/review.mjs';
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
    assert.equal(info.schemaVersion,6);
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

test('interrupted restore marker fails closed across reads and writes',async()=>{
  const f=await fixture();
  try {
    await transact(()=>createMission(input()),f.file);
    const marker=databasePath(f.file)+'.restore-pending';
    await writeFile(marker,'pending');
    await assert.rejects(readState(f.file),/Interrupted offline restore/);
    await assert.rejects(storageStatus(f.file),/Interrupted offline restore/);
    await assert.rejects(readHistory({},f.file),/Interrupted offline restore/);
    await assert.rejects(readReviewArchive({},f.file),/Interrupted offline restore/);
    await assert.rejects(transact(s=>s,f.file),/Interrupted offline restore/);
    await rm(marker);
    assert.equal((await storageStatus(f.file)).integrity,'ok');
  } finally {await f.cleanup();}
});

test('history keeps a bounded 2000 events under repeated transactions',async()=>{
  const f=await fixture();
  try {
    await transact(()=>createMission(input()),f.file);
    for(let i=0;i<2003;i++) await transact(s=>{s.revision++;return s;},f.file);
    assert.equal((await storageStatus(f.file)).events,2000);
    const first=await readHistory({limit:50},f.file);
    assert.equal(first.items.length,50);
    const next=await readHistory({limit:50,before:first.nextCursor},f.file);
    assert.equal(next.items.length,50);
    assert.ok(next.items[0].id<first.items[first.items.length-1].id);
  } finally {await f.cleanup();}
});

test('conflicting legacy backup blocks migration without changing source data',async()=>{
  const f=await fixture();
  try{
    const previous=JSON.stringify(createMission(input()));
    await writeFile(f.file,previous);
    await writeFile(f.file+'.pre-sqlite.bak','unrelated bytes');
    await assert.rejects(migrateLegacy(f.file),/migration backup differs/);
    assert.equal(await readFile(f.file,'utf8'),previous);
    assert.equal((await readState(f.file)).id,JSON.parse(previous).id);
  }finally{await f.cleanup();}
});

test('review receipts retain packet identities privately and public queries redact tokens',async()=>{
  const f=await fixture();
  try {
    await transact(()=>createMission(input()),f.file);
    await transact(s=>{
      const packet=startBatch(s).batch.packets[0];
      completeUnit(s,packet.unitId,packet.token,{success:true,
        summary:'Verified all source files',evidence:['Reviewed tests']});
      return s;
    },f.file);
    await transact(s=>{openReview(s,{candidateSha:'a'.repeat(40)});return s;},f.file);
    let packet;
    await transact(s=>{packet=startReviewBatch(s).packets[0];return s;},f.file);
    await transact(s=>{submitReview(s,{lensId:packet.lensId,token:packet.token,
      candidateSha:packet.candidateSha,verdict:'PASS',
      summary:'Completed risk review',evidence:['Verified repository contracts'],
      execution:'SELF_CONTEXT'});return s;},f.file);
    assert.equal((await storageStatus(f.file)).reviewReceipts,1);
    const live=reviewStatus(await readState(f.file));
    assert.equal(live.lenses[0].result.packetToken,undefined);
    const history=await readHistory({category:'REVIEW_LENS_DONE'},f.file);
    assert.equal(history.items.length,1);
    assert.equal(history.items[0].detail.token,undefined);
    assert.equal(history.items[0].detail.tokenHash.length,64);
    await transact(s=>{openReview(s,{candidateSha:'b'.repeat(40)});return s;},f.file);
    const archive=await readReviewArchive({limit:10},f.file);
    assert.equal(archive.items[0].review.lenses[0].result.packetToken,undefined);
  }finally{await f.cleanup();}
});

test('filesystem errors do not damage the durable mission',async()=>{
  const f=await fixture();
  try {
    const old=await transact(()=>createMission(input()),f.file);
    const obstruction=join(f.dir,'not-a-directory');
    await writeFile(obstruction,'regular file');
    await assert.rejects(backupState(join(obstruction,'backup.sqlite'),f.file),/ENOTDIR/);
    assert.equal((await storageStatus(f.file)).integrity,'ok');
    assert.equal((await readState(f.file)).revision,old.revision);
  }finally{await f.cleanup();}
});

test('archived review retention never exceeds 200 records',async()=>{
  const f=await fixture();
  try{
    await transact(()=>createMission(input()),f.file);
    await transact(s=>{
      const p=startBatch(s).batch.packets[0];
      completeUnit(s,p.unitId,p.token,{success:true,summary:'Mission validated',
        evidence:['Actual source validation']});
      return s;
    },f.file);
    // Test storage retention independently of the enforced per-mission
    // maximum of five review rounds: prepopulate historical archived rows.
    const db=new DatabaseSync(databasePath(f.file));
    try{
      db.exec('BEGIN IMMEDIATE');
      const insert=db.prepare('INSERT INTO review_archive(mission_id,review_id,content,created_at) VALUES(?,?,?,?)');
      for(let i=0;i<204;i++){
        const id='archive-fixture-'+i;
        insert.run('historical-mission',id,JSON.stringify({id,lenses:[]}),new Date().toISOString());
      }
      db.exec('COMMIT');
    }finally{db.close();}
    await transact(s=>{s.revision++;return s;},f.file);
    assert.equal((await storageStatus(f.file)).archivedReviews,200);
    const page=await readReviewArchive({limit:100},f.file);
    const second=await readReviewArchive({limit:100,before:page.nextCursor},f.file);
    assert.equal(page.items.length+second.items.length,200);
  }finally{await f.cleanup();}
});

test('verified review correction count survives process reopen',async()=>{
  const f=await fixture();
  const sha=n=>n.toString(16).padStart(40,'0');
  const git=n=>({assurance:'LOCAL_GIT_OBSERVED',repoRoot:'/tmp/verification',
    candidateSha:sha(n),treeSha:sha(n+100),baseSha:sha(500),
    branchRef:'refs/heads/review',targetRef:'refs/heads/main',
    clean:true,observedAt:new Date().toISOString()});
  try{
    await transact(()=>createMission(input()),f.file);
    await transact(m=>{
      const p=startBatch(m).batch.packets[0];
      completeUnit(m,p.unitId,p.token,{success:true,summary:'Verified source behavior',
        evidence:['Inspected and verified actual source checks']});
      return m;
    },f.file);
    await transact(m=>{
      openReview(m,{candidateSha:sha(1),gitEvidence:git(1)});return m;
    },f.file);
    assert.equal((await readState(f.file)).reviewCount,1);
    await transact(m=>{
      m.review.state='INVALIDATED';
      openReview(m,{candidateSha:sha(2),gitEvidence:git(2)});return m;
    },f.file);
    const restarted=await readState(f.file);
    assert.equal(restarted.reviewCount,2);
    assert.equal(restarted.review.round,2);
    assert.equal((await storageStatus(f.file)).schemaVersion,6);
  }finally{await f.cleanup();}
});
