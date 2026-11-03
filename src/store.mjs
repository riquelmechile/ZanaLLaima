import { DatabaseSync, backup } from 'node:sqlite';
import { constants } from 'node:fs';
import { access, chmod, copyFile, link, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA_VERSION = 1;
const MAX_EVENTS = 2000;
const MAX_ARCHIVES = 200;
const BUSY_MS = 10000;
const now = () => new Date().toISOString();
const fail = (message) => { throw new Error(message); };
const json = x => JSON.stringify(x);
const parse = x => x == null ? null : JSON.parse(x);

export const statePath = () => resolve(process.env.ZANA_STATE_FILE || '.zana/state.json');
export const databasePath = (file = statePath()) =>
  resolve(file).replace(/\.json$/i, '.sqlite');
export const legacyPath = (file = statePath()) => {
  const absolute = resolve(file);
  return absolute.endsWith('.json') ? absolute : absolute + '.json';
};
const exists = async path => {
  try { await access(path); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
};
const validate = state => {
  if (!state || state.schema !== 1 || typeof state.id !== 'string' ||
      !Array.isArray(state.units) || !Number.isInteger(state.revision) || state.revision < 0)
    fail('Invalid or unsupported mission snapshot');
  return state;
};

function connect(path, readonly = false) {
  const db = new DatabaseSync(path, { readOnly: readonly });
  try {
    db.exec('PRAGMA busy_timeout = ' + BUSY_MS + '; PRAGMA foreign_keys = ON;');
    if (!readonly) {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version > SCHEMA_VERSION) fail('Database schema is newer than this software');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec([
          'CREATE TABLE IF NOT EXISTS active_mission (slot INTEGER PRIMARY KEY CHECK(slot=1), id TEXT NOT NULL UNIQUE, objective TEXT NOT NULL, authorization TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
          'CREATE TABLE IF NOT EXISTS units (mission_id TEXT NOT NULL, id TEXT NOT NULL, ordinal INTEGER NOT NULL, instruction TEXT NOT NULL, effect TEXT NOT NULL, depends_on TEXT NOT NULL, paths TEXT NOT NULL, status TEXT NOT NULL, run TEXT, result TEXT, PRIMARY KEY(mission_id,id))',
          'CREATE INDEX IF NOT EXISTS units_order ON units(mission_id,ordinal)',
          'CREATE TABLE IF NOT EXISTS active_review (mission_id TEXT PRIMARY KEY, content TEXT NOT NULL)',
          'CREATE TABLE IF NOT EXISTS review_archive (seq INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL, review_id TEXT NOT NULL UNIQUE, content TEXT NOT NULL, created_at TEXT NOT NULL)',
          'CREATE INDEX IF NOT EXISTS reviews_recent ON review_archive(mission_id,seq DESC)',
          'CREATE TABLE IF NOT EXISTS state_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL, revision INTEGER NOT NULL, category TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL)',
          'CREATE INDEX IF NOT EXISTS events_recent ON state_events(mission_id,seq DESC)',
          'CREATE TABLE IF NOT EXISTS work_receipts (mission_id TEXT NOT NULL, unit_id TEXT NOT NULL, token TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(mission_id,unit_id,token))',
          'CREATE TABLE IF NOT EXISTS review_receipts (review_id TEXT NOT NULL, lens_id TEXT NOT NULL, token TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(review_id,lens_id,token))'
        ].join(';') + ';');
        db.exec('PRAGMA user_version = ' + SCHEMA_VERSION + '; COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    } else {
      if (db.prepare('PRAGMA user_version').get().user_version !== SCHEMA_VERSION)
        fail('Unsupported database schema');
    }
    return db;
  } catch (e) { db.close(); throw e; }
}

async function ensureFile(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const fd = await open(path, 'wx', 0o600);
    await fd.close();
  } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

async function legacySnapshot(path) {
  try { return validate(JSON.parse(await readFile(path, 'utf8'))); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

async function preserveLegacy(path) {
  const source = await readFile(path);
  const target = path + '.pre-sqlite.bak';
  try { await copyFile(path, target, constants.COPYFILE_EXCL); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  const retained = await readFile(target);
  if (!retained.equals(source)) fail('Existing migration backup differs from legacy file; manual reconciliation needed');
  await chmod(target, 0o600);
}

function load(db) {
  const m = db.prepare('SELECT * FROM active_mission WHERE slot=1').get();
  if (!m) return null;
  const units = db.prepare('SELECT * FROM units WHERE mission_id=? ORDER BY ordinal ASC').all(m.id)
    .map(x => ({ id:x.id, instruction:x.instruction, effect:x.effect,
      dependsOn:parse(x.depends_on), paths:parse(x.paths), status:x.status,
      run:parse(x.run), result:parse(x.result) }));
  const r = db.prepare('SELECT content FROM active_review WHERE mission_id=?').get(m.id);
  const state = { schema:1, id:m.id, objective:m.objective, authorization:parse(m.authorization),
    revision:m.revision, createdAt:m.created_at, units };
  if (r) state.review = parse(r.content);
  return validate(state);
}

function addEvent(db, m, category, detail) {
  db.prepare('INSERT INTO state_events(mission_id,revision,category,detail,created_at) VALUES(?,?,?,?,?)')
    .run(m.id, m.revision, category, json(detail), now());
}

function trimHistory(db) {
  db.exec('DELETE FROM state_events WHERE seq < COALESCE((SELECT seq FROM state_events ORDER BY seq DESC LIMIT 1 OFFSET ' +
    (MAX_EVENTS - 1) + '), -1) AND seq < (SELECT MAX(seq) FROM state_events)');
  db.exec('DELETE FROM review_archive WHERE seq < COALESCE((SELECT seq FROM review_archive ORDER BY seq DESC LIMIT 1 OFFSET ' +
    (MAX_ARCHIVES - 1) + '), -1) AND seq < (SELECT MAX(seq) FROM review_archive)');
}

function persist(db, previous, next, kind = 'STATE_CHANGED') {
  validate(next);
  if (previous && previous.id !== next.id) fail('Replacing an active mission is not authorized');
  if (previous && next.revision < previous.revision) fail('Mission revision went backwards');
  if (!previous) {
    db.prepare('INSERT INTO active_mission(slot,id,objective,authorization,revision,created_at,updated_at) VALUES(1,?,?,?,?,?,?)')
      .run(next.id, next.objective, json(next.authorization), next.revision, next.createdAt, now());
  } else {
    db.prepare('UPDATE active_mission SET objective=?, authorization=?, revision=?, updated_at=? WHERE slot=1')
      .run(next.objective, json(next.authorization), next.revision, now());
  }

  const prior = new Map((previous?.units || []).map(x => [x.id,x]));
  const ids = new Set(next.units.map(x => x.id));
  for (const old of prior.keys()) if (!ids.has(old)) fail('Deleting work units is not supported');
  for (let i=0; i<next.units.length; i++) {
    const u = next.units[i], old = prior.get(u.id);
    if (!old) {
      db.prepare('INSERT INTO units(mission_id,id,ordinal,instruction,effect,depends_on,paths,status,run,result) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(next.id,u.id,i,u.instruction,u.effect,json(u.dependsOn),json(u.paths),
          u.status,json(u.run),json(u.result));
    } else if (json(old) !== json(u)) {
      db.prepare('UPDATE units SET ordinal=?,instruction=?,effect=?,depends_on=?,paths=?,status=?,run=?,result=? WHERE mission_id=? AND id=?')
        .run(i,u.instruction,u.effect,json(u.dependsOn),json(u.paths),u.status,
          json(u.run),json(u.result),next.id,u.id);
    }
    if ((!old || old.status !== u.status) && u.status === 'RUNNING') {
      addEvent(db,next,'UNIT_STARTED',{unitId:u.id,token:u.run?.token,generation:u.run?.leaseGeneration});
    }
    if ((!old || old.status !== u.status) && (u.status === 'DONE' || u.status === 'FAILED')) {
      if (!u.run?.token || !u.result) fail('Completed unit lacks a real run token or result');
      db.prepare('INSERT OR IGNORE INTO work_receipts(mission_id,unit_id,token,generation,status,result,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(next.id,u.id,u.run.token,u.run.leaseGeneration || 1,u.status,json(u.result),now());
      addEvent(db,next,'UNIT_'+u.status,{unitId:u.id,token:u.run.token});
    }
  }
  if (previous?.review && next.review && previous.review.id === next.review.id) {
    for (const lens of next.review.lenses) {
      const before = previous.review.lenses.find(x => x.id === lens.id);
      if (lens.state === 'DONE' && before?.state !== 'DONE') {
        const token = lens.result?.packetToken;
        if (!token) fail('Completed review lacks original packet token');
        db.prepare('INSERT OR IGNORE INTO review_receipts(review_id,lens_id,token,result,created_at) VALUES(?,?,?,?,?)')
          .run(next.review.id,lens.id,token,json(lens.result),now());
        addEvent(db,next,'REVIEW_LENS_DONE',{reviewId:next.review.id,lensId:lens.id,token});
      }
    }
  }
  const oldReview = previous?.review;
  if (next.review && json(next.review) !== json(oldReview)) {
    db.prepare('INSERT INTO active_review(mission_id,content) VALUES(?,?) ON CONFLICT(mission_id) DO UPDATE SET content=excluded.content')
      .run(next.id,json(next.review));
    if (!oldReview || oldReview.id !== next.review.id)
      addEvent(db,next,'REVIEW_OPENED',{reviewId:next.review.id,candidateSha:next.review.candidateSha});
  }
  if (oldReview && next.review?.id !== oldReview.id) {
    db.prepare('INSERT OR IGNORE INTO review_archive(mission_id,review_id,content,created_at) VALUES(?,?,?,?)')
      .run(next.id,oldReview.id,json(oldReview),now());
    addEvent(db,next,'REVIEW_ARCHIVED',{reviewId:oldReview.id});
  }
  if (Array.isArray(next.reviewHistory)) {
    for (const review of next.reviewHistory) {
      if (review?.id && review.id !== next.review?.id)
        db.prepare('INSERT OR IGNORE INTO review_archive(mission_id,review_id,content,created_at) VALUES(?,?,?,?)')
          .run(next.id,review.id,json(review),now());
    }
    next.reviewHistory = [];
  }
  addEvent(db,next,kind,{previousRevision:previous?.revision ?? null,revision:next.revision});
  trimHistory(db);
}

function assertHealthy(db) {
  const row = db.prepare('PRAGMA quick_check').get();
  if (row.quick_check !== 'ok') fail('SQLite integrity failed: ' + row.quick_check);
}

async function refuseInterruptedRestore(file) {
  if (await exists(databasePath(file) + '.restore-pending'))
    fail('Interrupted offline restore detected; inspect the database and quarantine before resuming');
}

export async function readState(file = statePath()) {
  await refuseInterruptedRestore(file);
  const dbPath = databasePath(file);
  if (!await exists(dbPath)) return legacySnapshot(legacyPath(file));
  const db = connect(dbPath, true);
  try {
    const state = load(db);
    return state || await legacySnapshot(legacyPath(file));
  } finally { db.close(); }
}

export async function transact(change, file = statePath()) {
  if (typeof change !== 'function') fail('Transaction needs a state transformation');
  await refuseInterruptedRestore(file);
  const path = databasePath(file);
  await ensureFile(path);
  const db = connect(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      let previous = load(db);
      if (!previous) {
        const oldPath = legacyPath(file);
        const old = await legacySnapshot(oldPath);
        if (old) {
          await preserveLegacy(oldPath);
          persist(db,null,old,'LEGACY_MIGRATION');
          previous = old;
        }
      }
      const updated = await change(previous ? structuredClone(previous) : null);
      validate(updated);
      persist(db,previous,updated);
      db.exec('COMMIT');
      return updated;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } finally { db.close(); }
}

export async function migrateLegacy(file = statePath()) {
  return transact(existing => {
    if (!existing) fail('No legacy state found to migrate');
    return existing;
  },file);
}

export async function readHistory({ limit=25, before=null, category=null } = {}, file=statePath()) {
  if (!Number.isInteger(limit) || limit<1 || limit>100 ||
      (before!==null && (!Number.isSafeInteger(before) || before<1)) ||
      (category!==null && (typeof category !== 'string' || category.length>64)))
    fail('Invalid history pagination');
  await refuseInterruptedRestore(file);
  const path=databasePath(file);
  if (!await exists(path)) return {items:[],nextCursor:null};
  const db=connect(path,true);
  try {
    const where=['1=1'], params=[];
    if (before!==null){where.push('seq < ?');params.push(before);}
    if (category!==null){where.push('category = ?');params.push(category);}
    const rows=db.prepare('SELECT * FROM state_events WHERE '+where.join(' AND ')+
      ' ORDER BY seq DESC LIMIT ?').all(...params,limit+1);
    const page=rows.slice(0,limit);
    return {items:page.map(x=>({id:x.seq,missionId:x.mission_id,revision:x.revision,
      category:x.category,detail:parse(x.detail),createdAt:x.created_at})),
      nextCursor:rows.length>limit?page[page.length-1].seq:null};
  } finally {db.close();}
}

export async function readReviewArchive({limit=25,before=null}={},file=statePath()){
  if (!Number.isInteger(limit)||limit<1||limit>100||
      (before!==null&&(!Number.isSafeInteger(before)||before<1)))
    fail('Invalid review archive pagination');
  const path=databasePath(file);
  if (!await exists(path)) return {items:[],nextCursor:null};
  const db=connect(path,true);
  try {
    const rows=before===null
      ?db.prepare('SELECT * FROM review_archive ORDER BY seq DESC LIMIT ?').all(limit+1)
      :db.prepare('SELECT * FROM review_archive WHERE seq<? ORDER BY seq DESC LIMIT ?').all(before,limit+1);
    const page=rows.slice(0,limit);
    return {items:page.map(x=>({id:x.seq,review:parse(x.content),archivedAt:x.created_at})),
      nextCursor:rows.length>limit?page[page.length-1].seq:null};
  } finally {db.close();}
}

export async function storageStatus(file=statePath()) {
  await refuseInterruptedRestore(file);
  const path=databasePath(file);
  if (!await exists(path)) return {backend:'LEGACY_OR_EMPTY',databasePath:path,legacyExists:await exists(legacyPath(file))};
  const db=connect(path,true);
  try {
    assertHealthy(db);
    return {backend:'SQLITE_WAL',databasePath:path,schemaVersion:db.prepare('PRAGMA user_version').get().user_version,
      journalMode:db.prepare('PRAGMA journal_mode').get().journal_mode,
      integrity:'ok',activeMission:load(db)?.id??null,
      events:db.prepare('SELECT COUNT(*) AS n FROM state_events').get().n,
      archivedReviews:db.prepare('SELECT COUNT(*) AS n FROM review_archive').get().n,
      workReceipts:db.prepare('SELECT COUNT(*) AS n FROM work_receipts').get().n,
      reviewReceipts:db.prepare('SELECT COUNT(*) AS n FROM review_receipts').get().n};
  } finally {db.close();}
}

export async function backupState(destination,file=statePath()) {
  await refuseInterruptedRestore(file);
  const path=databasePath(file), target=resolve(destination);
  if (path===target || await exists(target)) fail('Backup destination must be new and distinct from database');
  if (!await exists(path)) fail('No SQLite database available for backup');
  await mkdir(dirname(target),{recursive:true,mode:0o700});
  const temp=target+'.'+randomUUID()+'.tmp';
  const db=connect(path,true);
  try {
    assertHealthy(db);
    await backup(db,temp);
    await chmod(temp,0o600);
    const check=connect(temp,true);
    try {assertHealthy(check);} finally {check.close();}
    await link(temp,target); // fails instead of overwriting another backup
    return {path:target,integrity:'ok'};
  } finally {db.close();await rm(temp,{force:true});}
}

export async function restoreBackup(source,file=statePath(),{offline=false}={}){
  if (!offline || process.env.ZANA_RESTORE_OFFLINE!=='1')
    fail('Restoration requires an explicit offline operator mode');
  const path=databasePath(file), src=resolve(source);
  if (src===path) fail('Backup source cannot be the active database');
  const db=connect(src,true);
  try {
    assertHealthy(db);
    const m=load(db);
    if (!m) fail('Backup has no mission');
    if (m.units.some(x=>x.status==='RUNNING') ||
        m.review?.lenses?.some(x=>x.state==='RUNNING'))
      fail('Backup contains running work; reconcile it before restoring');
  } finally {db.close();}
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const marker=path+'.restore-pending', quarantine=path+'.quarantine.'+randomUUID();
  const hold=await open(marker,'wx',0o600);
  await hold.close();
  const moved=[];
  try {
    for(const suffix of ['','-wal','-shm']){
      if(await exists(path+suffix)){
        await rename(path+suffix,quarantine+suffix);
        moved.push(suffix);
      }
    }
    const temp=path+'.restoring.'+randomUUID();
    try {
      const source=connect(src,true);
      try { await backup(source,temp); } finally { source.close(); }
      await chmod(temp,0o600);
      const check=connect(temp,true);
      try {assertHealthy(check);if (!load(check))fail('Restored database has no mission');}
      finally {check.close();}
      await rename(temp,path);
    } finally {await rm(temp,{force:true});}
    await rm(marker);
    return {restored:true,databasePath:path,quarantinePath:moved.length?quarantine:null,
      note:'Previous database files retained for explicit operator recovery'};
  }catch(e){
    if(!await exists(path) && moved.includes('')){
      await rename(quarantine,path);
      for(const suffix of ['-wal','-shm'])if(moved.includes(suffix))await rename(quarantine+suffix,path+suffix);
    }
    await rm(marker,{force:true});
    throw e;
  }
}
