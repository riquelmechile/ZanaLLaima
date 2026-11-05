import { DatabaseSync, backup } from 'node:sqlite';
import { constants } from 'node:fs';
import { access, chmod, copyFile, link, mkdir, open, readFile, readdir, rename, rm, stat, lstat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { operatorPublicKey, verifySignedAction, verifyStoredGrant } from './operator.mjs';
import { reconcileWrite, revokeRunningWrites } from './lifecycle.mjs';
import {inspectEffectTemporary} from './write-effect.mjs';
import {beginRestoreMoves,abortRestoreMoves,classifyRestoreArtifacts,cleanupRestoreArtifacts,interruptedRestoreJournal,RestoreJournalError} from './restore-journal.mjs';

const SCHEMA_VERSION = 6;
const MAX_EVENTS = 2000;
const MAX_ARCHIVES = 200;
const BUSY_MS = 10000;
const now = () => new Date().toISOString();
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const fail = (message) => { throw new Error(message); };
// SQLite may automatically roll back (SQLITE_FULL / RAISE(ROLLBACK)).
// Never mask the original error by issuing ROLLBACK against no transaction.
function rollbackIfOpen(db){
  try{if(db.isTransaction)db.exec('ROLLBACK');}catch{/* preserve original failure */}
}
const json = x => JSON.stringify(x);
const parse = x => x == null ? null : JSON.parse(x);

export const statePath = () => resolve(process.env.ZANA_STATE_FILE || '.zana/state.json');
export const databasePath = (file = statePath()) =>
  resolve(file).replace(/\.json$/i, '.sqlite');
// Serialize SQLite write entry before synchronous connect/BEGIN IMMEDIATE.
// SQLite WAL and busy_timeout continue to guard other processes.
const localWriteTails=new Map();
async function queueLocalWrite(path,action){
  const preceding=localWriteTails.get(path);
  let release;
  const ownTurn=new Promise(resolve=>{release=resolve;});
  localWriteTails.set(path,ownTurn);
  if(preceding)await preceding;
  try{return await action();}
  finally{
    release(); // Failed transactions must never poison later callers.
    if(localWriteTails.get(path)===ownTurn)localWriteTails.delete(path);
  }
}
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
          'CREATE TABLE IF NOT EXISTS review_receipts (review_id TEXT NOT NULL, lens_id TEXT NOT NULL, token TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(review_id,lens_id,token))',
          'CREATE TABLE IF NOT EXISTS write_effect_receipts (mission_id TEXT NOT NULL, unit_id TEXT NOT NULL, token TEXT NOT NULL, generation INTEGER NOT NULL, effect_id TEXT NOT NULL UNIQUE, path TEXT NOT NULL, pre_sha TEXT, post_sha TEXT, bytes INTEGER NOT NULL, operation TEXT NOT NULL, pre_mode INTEGER, post_mode INTEGER, created_at TEXT NOT NULL, PRIMARY KEY(mission_id,unit_id,token,generation))',
          'CREATE TABLE IF NOT EXISTS mission_archive (seq INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL UNIQUE, snapshot TEXT NOT NULL, archived_at TEXT NOT NULL)',
          'CREATE TABLE IF NOT EXISTS operator_grants (grant_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, payload TEXT NOT NULL, signature TEXT NOT NULL, fingerprint TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)',
          'CREATE TABLE IF NOT EXISTS operator_actions (nonce TEXT PRIMARY KEY, mission_id TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL)',
          'CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
        ].join(';') + ';');
        const columns=db.prepare('PRAGMA table_info(active_mission)').all().map(x=>x.name);
        if(!columns.includes('lifecycle')) db.exec("ALTER TABLE active_mission ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'ACTIVE'");
        if(!columns.includes('closed_at')) db.exec('ALTER TABLE active_mission ADD COLUMN closed_at TEXT');
        if(!columns.includes('review_count')) db.exec('ALTER TABLE active_mission ADD COLUMN review_count INTEGER NOT NULL DEFAULT 0');
        if(!columns.includes('budget')) db.exec('ALTER TABLE active_mission ADD COLUMN budget TEXT');
        const effectColumns=db.prepare('PRAGMA table_info(write_effect_receipts)').all().map(x=>x.name);
        if(!effectColumns.includes('pre_mode'))db.exec('ALTER TABLE write_effect_receipts ADD COLUMN pre_mode INTEGER');
        if(!effectColumns.includes('post_mode'))db.exec('ALTER TABLE write_effect_receipts ADD COLUMN post_mode INTEGER');
        const unitColumns=db.prepare('PRAGMA table_info(units)').all().map(x=>x.name);
        if(!unitColumns.includes('attempts')) db.exec('ALTER TABLE units ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
        db.exec('PRAGMA user_version = ' + SCHEMA_VERSION + '; COMMIT');
      } catch (e) { rollbackIfOpen(db); throw e; }
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
      attempts:x.attempts||0, run:parse(x.run), result:parse(x.result) }));
  const r = db.prepare('SELECT content FROM active_review WHERE mission_id=?').get(m.id);
  const state = { schema:1, id:m.id, status:m.lifecycle||'ACTIVE', objective:m.objective,
    authorization:parse(m.authorization), revision:m.revision, reviewCount:m.review_count||0, createdAt:m.created_at, budget:parse(m.budget),units };
  if(m.closed_at)state.closedAt=m.closed_at;
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
  const active=db.prepare('SELECT content FROM active_review LIMIT 1').get();
  const current=active ? parse(active.content).id : '';
  db.prepare('DELETE FROM review_receipts WHERE review_id != ? AND review_id NOT IN (SELECT review_id FROM review_archive)').run(current);
}

function persist(db, previous, next, kind = 'STATE_CHANGED') {
  validate(next);
  if (previous && previous.id !== next.id) fail('Replacing an active mission is not authorized');
  if (previous && next.revision < previous.revision) fail('Mission revision went backwards');
  if(previous && json(previous.budget??null)!==json(next.budget??null))
    fail('Mission resource budget cannot be modified after creation');
  const activeWriters=next.units.filter(u=>u.effect==='WRITE'&&u.status==='RUNNING');
  const activeReaders=next.units.filter(u=>u.effect==='READ'&&u.status==='RUNNING');
  if(activeWriters.length>1||(activeWriters.length&&activeReaders.length))
    fail('Exclusive WRITE invariant violated: concurrent read/write or multiple writers');
  const allowedStarts=next.budget?.maxWorkStarts;
  if(allowedStarts!==undefined && next.units.reduce((n,u)=>n+(u.attempts||0),0)>allowedStarts)
    fail('Mission work-start budget exceeded');
  if (!previous) {
    db.prepare('INSERT INTO active_mission(slot,id,objective,authorization,revision,created_at,updated_at,lifecycle,closed_at,review_count,budget) VALUES(1,?,?,?,?,?,?,?,?,?,?)')
      .run(next.id,next.objective,json(next.authorization),next.revision,next.createdAt,now(),next.status||'ACTIVE',next.closedAt||null,next.reviewCount||0,json(next.budget??null));
  } else {
    db.prepare('UPDATE active_mission SET objective=?, authorization=?, revision=?, updated_at=?, lifecycle=?, closed_at=?, review_count=?, budget=? WHERE slot=1')
      .run(next.objective,json(next.authorization),next.revision,now(),next.status||'ACTIVE',next.closedAt||null,next.reviewCount||0,json(next.budget??null));
  }

  const prior = new Map((previous?.units || []).map(x => [x.id,x]));
  const ids = new Set(next.units.map(x => x.id));
  for (const old of prior.keys()) if (!ids.has(old)) fail('Deleting work units is not supported');
  for (let i=0; i<next.units.length; i++) {
    const u = next.units[i], old = prior.get(u.id);
    if (!old) {
      db.prepare('INSERT INTO units(mission_id,id,ordinal,instruction,effect,depends_on,paths,status,run,result,attempts) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(next.id,u.id,i,u.instruction,u.effect,json(u.dependsOn),json(u.paths),
          u.status,json(u.run),json(u.result),u.attempts||0);
    } else if (json(old) !== json(u)) {
      db.prepare('UPDATE units SET ordinal=?,instruction=?,effect=?,depends_on=?,paths=?,status=?,run=?,result=?,attempts=? WHERE mission_id=? AND id=?')
        .run(i,u.instruction,u.effect,json(u.dependsOn),json(u.paths),u.status,
          json(u.run),json(u.result),u.attempts||0,next.id,u.id);
    }
    if ((!old || old.status !== u.status) && u.status === 'RUNNING' && !u.run?.effectReceipt) {
      addEvent(db,next,'UNIT_STARTED',{unitId:u.id,tokenHash:tokenHash(u.run.token),generation:u.run?.leaseGeneration});
    }
    if(u.run?.effectReceipt && !old?.run?.effectReceipt){
      const effect=u.run.effectReceipt;
      const inserted=db.prepare('INSERT INTO write_effect_receipts(mission_id,unit_id,token,generation,effect_id,path,pre_sha,post_sha,bytes,operation,pre_mode,post_mode,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(next.id,u.id,u.run.token,u.run.leaseGeneration,effect.effectId,effect.path,
          effect.preSha256,effect.postSha256,effect.bytes,effect.operation,
          effect.preMode??null,effect.postMode??null,effect.appliedAt);
      if(inserted.changes!==1)fail('Write receipt was not unique');
      addEvent(db,next,'WRITE_EFFECT_COMMITTED',{unitId:u.id,effectId:effect.effectId,
        path:effect.path,preSha256:effect.preSha256,postSha256:effect.postSha256,
        preMode:effect.preMode??null,postMode:effect.postMode??null,bytes:effect.bytes});
    }
    if ((!old || old.status !== u.status) && (u.status === 'DONE' || u.status === 'FAILED')) {
      if (!u.run?.token || !u.result) fail('Completed unit lacks a real run token or result');
      db.prepare('INSERT OR IGNORE INTO work_receipts(mission_id,unit_id,token,generation,status,result,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(next.id,u.id,u.run.token,u.run.leaseGeneration || 1,u.status,json(u.result),now());
      addEvent(db,next,'UNIT_'+u.status,{unitId:u.id,tokenHash:tokenHash(u.run.token)});
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
        addEvent(db,next,'REVIEW_LENS_DONE',{reviewId:next.review.id,lensId:lens.id,tokenHash:tokenHash(token)});
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
  for(const u of next.units){
    const old=prior.get(u.id);
    if(old && old.status!==u.status && ['EXPIRED','OUTCOME_UNKNOWN','CANCELLED','PENDING'].includes(u.status))
      addEvent(db,next,'UNIT_'+u.status,{unitId:u.id,previousStatus:old.status});
  }
  if(previous && (previous.status||'ACTIVE')==='ACTIVE' && next.status && next.status!=='ACTIVE')
    db.prepare('UPDATE operator_grants SET revoked=1 WHERE mission_id=?').run(next.id);
  if(previous && previous.status!==next.status)
    addEvent(db,next,'MISSION_'+(next.status||'ACTIVE'),{prior:previous.status||'ACTIVE'});
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
    const state=load(db);
    if(state)return state;
    const imported=db.prepare("SELECT value FROM metadata WHERE key='legacy_imported'").get();
    return imported ? null : await legacySnapshot(legacyPath(file));
  } finally { db.close(); }
}

export async function transact(change, file = statePath()) {
  if (typeof change !== 'function') fail('Transaction needs a state transformation');
  const path = databasePath(file);
  return queueLocalWrite(path,async()=>{
    await refuseInterruptedRestore(file);
    await ensureFile(path);
    const db = connect(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      let previous = load(db);
      if (!previous && !db.prepare("SELECT value FROM metadata WHERE key='legacy_imported'").get()) {
        const oldPath = legacyPath(file);
        const old = await legacySnapshot(oldPath);
        if (old) {
          await preserveLegacy(oldPath);
          persist(db,null,old,'LEGACY_MIGRATION');
          db.prepare("INSERT INTO metadata(key,value) VALUES('legacy_imported','1')").run();
          previous = old;
        }
      }
      const grant=previous ? await readEffectiveGrant(db,previous) : null;
      const updated = await change(previous ? structuredClone(previous) : null,{writeGrant:grant});
      validate(updated);
      persist(db,previous,updated);
      db.exec('COMMIT');
      return updated;
    } catch (e) { rollbackIfOpen(db); throw e; }
  } finally { db.close(); }
  });
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

function publicArchivedReview(value) {
  const r=structuredClone(value);
  for (const lens of r.lenses || []) {
    if (lens.run) lens.run={issuedAt:lens.run.issuedAt,tokenRedacted:true};
    if (lens.result) delete lens.result.packetToken;
  }
  return r;
}

export async function readReviewArchive({limit=25,before=null}={},file=statePath()){
  await refuseInterruptedRestore(file);
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
    return {items:page.map(x=>({id:x.seq,review:publicArchivedReview(parse(x.content)),archivedAt:x.created_at})),
      nextCursor:rows.length>limit?page[page.length-1].seq:null};
  } finally {db.close();}
}

async function pendingTemporary(unit,{remove=false}={}){
  const run=unit?.run, intent=run?.effectIntent;
  if(!intent?.tempName)return null; // old records cannot be safely inferred
  if(run.effectReceipt)return null;
  const anchors=run.pathAnchors;
  try{
    if(!anchors?.workspaceRoot)fail('Effect intent lost workspace anchors');
    return await inspectEffectTemporary({path:intent.path,tempName:intent.tempName,
      root:anchors.workspaceRoot,anchors:anchors.anchors,remove});
  }catch(error){
    // An unsafe/missing orphan never authorizes deletion of an arbitrary path.
    // Its cleanup failure is observable, but it must not roll back a signed
    // reconciliation or prevent recovery/status from reading durable state.
    return {path:intent.path,tempName:intent.tempName,removed:false,pending:true,
      error:{code:error?.code??'TEMP_CLEANUP_FAILED',message:String(error?.message??error)}};
  }
}
export async function cleanupEffectTemporaries(mission){
  const cleaned=[];
  for(const unit of mission?.units??[]){
    const temp=await pendingTemporary(unit,{remove:true});
    if(temp)cleaned.push({unitId:unit.id,...temp});
  }
  return cleaned;
}

export async function storageStatus(file=statePath()) {
  const path=databasePath(file);
  const restoreArtifacts=await classifyRestoreArtifacts(path);
  if(await interruptedRestoreJournal(path))
    return {backend:'RESTORE_PENDING',databasePath:path,restoreArtifacts,
      integrity:'NOT_INSPECTED_RESTORE_IN_PROGRESS'};
  if (!await exists(path)) return {backend:'LEGACY_OR_EMPTY',databasePath:path,restoreArtifacts,legacyExists:await exists(legacyPath(file))};
  const db=connect(path,true);
  try {
    assertHealthy(db);
    const live=load(db);
    const effectTemporaries=[];
    for(const u of live?.units??[]){
      const temp=await pendingTemporary(u);
      if(temp)effectTemporaries.push({unitId:u.id,...temp});
    }
    return {backend:'SQLITE_WAL',databasePath:path,effectTemporaries,restoreArtifacts,schemaVersion:db.prepare('PRAGMA user_version').get().user_version,
      journalMode:db.prepare('PRAGMA journal_mode').get().journal_mode,
      integrity:'ok',activeMission:live?.id??null,
      events:db.prepare('SELECT COUNT(*) AS n FROM state_events').get().n,
      archivedReviews:db.prepare('SELECT COUNT(*) AS n FROM review_archive').get().n,
      workReceipts:db.prepare('SELECT COUNT(*) AS n FROM work_receipts').get().n,
      reviewReceipts:db.prepare('SELECT COUNT(*) AS n FROM review_receipts').get().n,
      writeEffectReceipts:db.prepare('SELECT COUNT(*) AS n FROM write_effect_receipts').get().n};
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
  } finally {db.close();for(const suffix of ['','-wal','-shm'])await rm(temp+suffix,{force:true});}
}

// Security facts are monotone across offline restore. A missing live DB after
// SIGKILL is not evidence that no previous authorization history existed.
class RestoreGuardError extends Error {
  constructor(code,message){super(message);this.name='RestoreGuardError';this.code=code;}
}
const guardRestore=(code,message)=>{throw new RestoreGuardError(code,message);};
// A quarantine not identified by the durable journal is NOT live state.
// Never infer authority from mtime. Without a journal, an old quarantine is
// evidence for manual recovery, not a candidate to auto-install.
async function previousLiveDatabase(path){
  if(await exists(path))return {path,quarantine:false};
  const artifacts=await classifyRestoreArtifacts(path);
  if(artifacts.quarantines.length||artifacts.restoring.length)
    guardRestore('UNOWNED_ARTIFACTS','Previous restore artifacts exist without a journal; explicit manual inspection required');
  return {path:null,quarantine:false};
}
function inspectLive(candidate,source,forceDataLoss){
  if(!source.path){
    if(!forceDataLoss)guardRestore('BLIND_RESTORE','No previous database known; explicit --force-data-loss required');
    return {blind:true,actions:[],revoked:[],epoch:null};
  }
  let live;
  try{
    live=connect(source.path,true);assertHealthy(live);
    const old=load(live);
    if(!forceDataLoss&&old?.units.some(x=>
        x.status==='OUTCOME_UNKNOWN'||x.run?.effectIntent?.status==='INTENT_DURABLE'))
      guardRestore('UNCERTAIN_WRITE','Live OUTCOME_UNKNOWN write or uncertain intent prevents restore without --force-data-loss');
    if(!forceDataLoss){
      const retained=receiptIdentitySet(candidate);
      for(const key of receiptIdentitySet(live))
        if(!retained.has(key))
          guardRestore('NEWER_RECEIPT','Restoring backup would discard newer durable receipt without --force-data-loss');
    }
    return {blind:false,
      actions:live.prepare('SELECT nonce,mission_id,kind,created_at FROM operator_actions').all(),
      revoked:live.prepare('SELECT grant_id,mission_id,payload,signature,fingerprint,revoked,created_at FROM operator_grants WHERE revoked=1').all(),
      epoch:live.prepare("SELECT value FROM metadata WHERE key='restore_epoch'").get()?.value??null};
  }catch(error){
    if(error instanceof RestoreGuardError)throw error;
    if(source.quarantine)
      guardRestore('QUARANTINE_UNREADABLE','Quarantined live database cannot be inspected; use storage-restore-abort');
    if(!forceDataLoss)
      guardRestore('LIVE_UNREADABLE','Live database cannot be inspected; explicit --force-data-loss required');
    return {blind:true,actions:[],revoked:[],epoch:null};
  }finally{if(live)live.close();}
}
function mergeSecurityFacts(db,security){
  if(security.blind){
    db.exec('UPDATE operator_grants SET revoked=1');
  }else{
    const findNonce=db.prepare('SELECT nonce,mission_id,kind,created_at FROM operator_actions WHERE nonce=?');
    const putNonce=db.prepare('INSERT INTO operator_actions(nonce,mission_id,kind,created_at) VALUES(?,?,?,?)');
    for(const row of security.actions){
      const old=findNonce.get(row.nonce);
      if(old){
        if(old.mission_id!==row.mission_id||old.kind!==row.kind||old.created_at!==row.created_at)
          guardRestore('NONCE_COLLISION','Operator nonce collision while restoring; refusing rollback');
      }else putNonce.run(row.nonce,row.mission_id,row.kind,row.created_at);
    }
    const findGrant=db.prepare('SELECT grant_id,mission_id,payload,signature,fingerprint,created_at FROM operator_grants WHERE grant_id=?');
    const putRevoked=db.prepare('INSERT INTO operator_grants(grant_id,mission_id,payload,signature,fingerprint,revoked,created_at) VALUES(?,?,?,?,?,1,?)');
    const revoke=db.prepare('UPDATE operator_grants SET revoked=1 WHERE grant_id=?');
    for(const row of security.revoked){
      const old=findGrant.get(row.grant_id);
      if(old){
        if(old.mission_id!==row.mission_id||old.payload!==row.payload||
           old.signature!==row.signature||old.fingerprint!==row.fingerprint||
           old.created_at!==row.created_at)
          guardRestore('GRANT_COLLISION','Operator grant identity collision while restoring');
        revoke.run(row.grant_id);
      }else putRevoked.run(row.grant_id,row.mission_id,row.payload,
        row.signature,row.fingerprint,row.created_at);
    }
  }
  // On blind recovery revoke every grant and fence old signed actions, even
  // if a nonce was never stored in the lost live database.
  const existing=db.prepare("SELECT value FROM metadata WHERE key='restore_epoch'").get()?.value;
  const floor=security.blind?new Date().toISOString():security.epoch;
  const parsed=[existing,floor].filter(x=>x!==null&&x!==undefined).map(value=>{
    // Malformed legacy epochs fail closed at "now"; do NOT sort strings.
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)||
       !Number.isFinite(Date.parse(value)))return Date.now();
    return Date.parse(value);
  });
  const epoch=parsed.length?new Date(Math.max(...parsed)).toISOString():null;
  if(epoch)db.prepare("INSERT INTO metadata(key,value) VALUES('restore_epoch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(epoch);
}
async function checkpointExclusive(path,{allowMissing=false,allowUnreadable=false}={}){
  if(!await exists(path)){
    if(allowMissing)return {missing:true};
    guardRestore('CHECKPOINT_MISSING','No database available for WAL checkpoint');
  }
  // Exclusive lock before the FIRST rename. If another connection holds a
  // WAL snapshot, TRUNCATE must be able to complete or the operation fails.
  let db;
  try{
    db=new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout=10000; PRAGMA locking_mode=EXCLUSIVE;');
    assertHealthy(db);
    const result=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if(!result||result.busy!==0)
      guardRestore('CHECKPOINT_BUSY','Exclusive WAL checkpoint failed; close other SQLite clients');
  }catch(error){
    if(!allowUnreadable)throw error;
    // A known-corrupt live DB may be quarantined under explicit data-loss
    // consent ONLY when it has no pending WAL to lose.
    if(await exists(path+'-wal')&&(await stat(path+'-wal')).size>0)
      guardRestore('UNREADABLE_WAL','Uncheckpointable WAL contains pending data; refusing data loss');
    return {corruptLive:true};
  }finally{if(db)db.close();}
  if(await exists(path+'-wal')&&(await stat(path+'-wal')).size!==0)
    guardRestore('CHECKPOINT_NONEMPTY','WAL is not empty after checkpoint; refusing to move database');
  return {checkpointed:true};
}
export async function storageRestoreAbort(file=statePath(),{afterRename}={}){
  if(process.env.ZANA_RESTORE_OFFLINE!=='1')
    guardRestore('OFFLINE_REQUIRED','storage-restore-abort requires explicit offline operator mode');
  const path=databasePath(file);
  return abortRestoreMoves(path,{checkpoint:checkpointExclusive,afterRename});
}
export async function storageCleanupArtifacts(file=statePath(),{confirm=false}={}){
  if(process.env.ZANA_RESTORE_OFFLINE!=='1')
    guardRestore('OFFLINE_REQUIRED','Artifact cleanup requires offline operator mode');
  return cleanupRestoreArtifacts(databasePath(file),{confirm});
}

// An offline restore must not erase later receipts or an uncertain WRITE.
// Validate and migrate a temporary copy before quarantining the live database.
function receiptIdentitySet(db){
  const specs=[
    ['work_receipts',['mission_id','unit_id','token','generation']],
    ['review_receipts',['review_id','lens_id','token']],
    ['write_effect_receipts',['mission_id','unit_id','token','generation','effect_id']]
  ];
  const keys=new Set();
  for(const [table,columns] of specs){
    const values=db.prepare('SELECT '+columns.join(',')+' FROM '+table).all();
    for(const row of values)keys.add(table+':'+json(columns.map(c=>row[c])));
  }
  return keys;
}

// The marker is the reader/writer fence around a multi-file SQLite swap.
// Failure restores the quarantined live files; it never clears the marker
// until recovery has been completed or rolled back safely.
export async function restoreBackup(source,file=statePath(),
  {offline=false,forceDataLoss=false,afterQuarantine,afterRename,afterJournalReady}={}){
  if(!offline||process.env.ZANA_RESTORE_OFFLINE!=='1')
    guardRestore('OFFLINE_REQUIRED','Restoration requires an explicit offline operator mode');
  const path=databasePath(file),src=resolve(source);
  if(src===path)guardRestore('SAME_SOURCE','Backup source cannot be the active database');
  if(typeof forceDataLoss!=='boolean')guardRestore('INVALID_FORCE','forceDataLoss must be a boolean');
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  // After SIGKILL, replay the EXACT journal to abort the partial restore
  // first; then inspect the recovered live DB and merge its monotone facts.
  if(await interruptedRestoreJournal(path))
    await storageRestoreAbort(file);
  // Classify prior DB before generating a new .restoring.* candidate.
  const sourceLive=await previousLiveDatabase(path);
  const temp=path+'.restoring.'+randomUUID();
  const quarantine=path+'.quarantine.'+randomUUID();
  try{
    const sourceDb=new DatabaseSync(src,{readOnly:true});
    try{
      assertHealthy(sourceDb);
      const version=sourceDb.prepare('PRAGMA user_version').get().user_version;
      if(version<1||version>SCHEMA_VERSION)guardRestore('SCHEMA','Unsupported backup schema');
      await backup(sourceDb,temp);
    }finally{sourceDb.close();}
    await chmod(temp,0o600);
    const migrating=connect(temp);migrating.close();
    const candidate=connect(temp);
    try{
      assertHealthy(candidate);
      const m=load(candidate);
      if(!m)guardRestore('EMPTY_BACKUP','Backup has no mission');
      if(m.units.some(x=>x.status==='RUNNING')||
          m.review?.lenses?.some(x=>x.state==='RUNNING'))
        guardRestore('BUSY_BACKUP','Backup contains running work');
      const security=inspectLive(candidate,sourceLive,forceDataLoss);
      candidate.exec('BEGIN IMMEDIATE');
      try{
        mergeSecurityFacts(candidate,security);
        candidate.exec('COMMIT');
      }catch(error){rollbackIfOpen(candidate);throw error;}
    }finally{candidate.close();}
    try{
      const result=await beginRestoreMoves({path,temp,quarantine,
        checkpoint:checkpointExclusive,allowUnreadable:forceDataLoss,
        afterQuarantine,afterRename,afterJournalReady});
      return {...result,quarantinePath:result.quarantinePath??(
        sourceLive.quarantine?sourceLive.path:null)};
    }catch(error){
      // Ordinary thrown errors roll back through the journal. SIGKILL leaves
      // it intact and is reconciled by the next operator action.
      if(await interruptedRestoreJournal(path)){
        try{await storageRestoreAbort(file);}
        catch(rollbackError){
          guardRestore('ROLLBACK_INCOMPLETE',
            'Restore journal remains active; abort failed: '+rollbackError.message);
        }
      }
      throw error;
    }
  }finally{
    // Never remove candidate bytes still referenced by an interrupted journal:
    // those are essential to an idempotent rerun or abort after a crash.
    if(!await interruptedRestoreJournal(path)){
      for(const suffix of ['','-wal','-shm'])
        await rm(temp+suffix,{force:true}).catch(()=>{});
    }
  }
}

async function readEffectiveGrant(db,mission){
  if(!process.env.ZANA_OPERATOR_PUBLIC_KEY_PATH)return null;
  const {key,fingerprint}=await operatorPublicKey();
  const row=db.prepare('SELECT * FROM operator_grants WHERE mission_id=? AND revoked=0 ORDER BY created_at DESC LIMIT 1')
    .get(mission.id);
  if(!row || row.fingerprint!==fingerprint)return null;
  return verifyStoredGrant({payload:parse(row.payload),signature:row.signature},mission,key);
}

export async function authorizationStatus(file=statePath()){
  await refuseInterruptedRestore(file);
  if(!await exists(databasePath(file)))return {valid:false,reason:'NO_DATABASE'};
  const db=connect(databasePath(file),true);
  try{
    const m=load(db);
    if(!m)return {valid:false,reason:'NO_ACTIVE_MISSION'};
    const grant=await readEffectiveGrant(db,m);
    return grant?{valid:true,expiresAt:grant.expiresAt,paths:grant.paths,
      missionId:m.id}:{valid:false,reason:'NO_VALID_SIGNED_OPERATOR_GRANT'};
  }finally{db.close();}
}

export async function applyOperatorAction(envelope,file=statePath()){
  const path=databasePath(file);
  return queueLocalWrite(path,async()=>{
    await refuseInterruptedRestore(file);
    if(!await exists(path))fail('No database to authorize');
    const db=connect(path);
  try{
    db.exec('BEGIN IMMEDIATE');
    try{
      const previous=load(db);
      if(!previous)fail('No active mission to authorize');
      const {key,fingerprint}=await operatorPublicKey();
      const p=verifySignedAction(envelope,previous,key);
      const epoch=db.prepare("SELECT value FROM metadata WHERE key='restore_epoch'").get()?.value;
      if(epoch){
        const cutoff=typeof epoch==='string'&&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(epoch)&&
          Number.isFinite(Date.parse(epoch))?Date.parse(epoch):Date.now();
        if(!Number.isFinite(Date.parse(p.issuedAt))||Date.parse(p.issuedAt)<=cutoff)
          fail('Operator action issuedAt precedes restore epoch; obtain a new signature');
      }

      if(db.prepare('SELECT nonce FROM operator_actions WHERE nonce=?').get(p.nonce))
        fail('Operator action nonce already consumed');
      const next=structuredClone(previous);
      let cleanup=null;
      if(p.kind==='GRANT_WRITE'){
        if(next.status!=='ACTIVE')fail('Mission must be active to grant writes');
        if(next.units.some(x=>x.effect==='WRITE'&&x.status==='RUNNING'))
          fail('Cannot replace write permission during active effects');
        db.prepare('UPDATE operator_grants SET revoked=1 WHERE mission_id=?').run(next.id);
        db.prepare('INSERT INTO operator_grants(grant_id,mission_id,payload,signature,fingerprint,revoked,created_at) VALUES(?,?,?,?,?,0,?)')
          .run(p.nonce,next.id,json(p),envelope.signature,fingerprint,now());
      }else if(p.kind==='REVOKE_WRITE'){
        const row=db.prepare('SELECT * FROM operator_grants WHERE grant_id=? AND mission_id=? AND revoked=0')
          .get(p.grantId,next.id);
        if(!row)fail('Write grant missing or revoked');
        db.prepare('UPDATE operator_grants SET revoked=1 WHERE grant_id=?').run(p.grantId);
        revokeRunningWrites(next);
      }else{
        const affected=next.units.find(u=>u.id===p.unitId);
        reconcileWrite(next,p); // first verify signed attempt identity
        const outcome=await pendingTemporary(affected,{remove:true});
        cleanup={pending:Boolean(outcome?.pending),error:outcome?.error??null};
        addEvent(db,next,'RECONCILE_WRITE_CLEANUP',{unitId:p.unitId,cleanup});
      }
      next.revision++;
      persist(db,previous,next,'OPERATOR_'+p.kind);
      db.prepare('INSERT INTO operator_actions(nonce,mission_id,kind,created_at) VALUES(?,?,?,?)')
        .run(p.nonce,next.id,p.kind,now());
      db.exec('COMMIT');
      return {kind:p.kind,missionId:next.id,revision:next.revision,
        actionId:p.nonce,writeGrant:await readEffectiveGrant(db,next),
        ...(p.kind==='RECONCILE_WRITE'?{cleanup}:{})};
    }catch(e){rollbackIfOpen(db);throw e;}
  }finally{db.close();}
  });
}

export async function archiveMission(file=statePath()){
  const path=databasePath(file);
  return queueLocalWrite(path,async()=>{
    await refuseInterruptedRestore(file);
    if(!await exists(path))fail('No database to archive');
    const db=connect(path);
  try{
    db.exec('BEGIN IMMEDIATE');
    try{
      const m=load(db);
      if(!m)fail('No active mission');
      if(!['CLOSED','CANCELLED'].includes(m.status))
        fail('Mission must be closed or cancelled before archive');
      if(m.units.some(x=>['RUNNING','OUTCOME_UNKNOWN'].includes(x.status)))
        fail('Uncertain effects must be reconciled before archive');
      if(m.review?.lenses?.some(x=>x.state==='RUNNING'))
        fail('Active review packets must be reconciled first');
      db.prepare('INSERT INTO mission_archive(mission_id,snapshot,archived_at) VALUES(?,?,?)')
        .run(m.id,json(m),now());
      db.prepare('UPDATE operator_grants SET revoked=1 WHERE mission_id=?').run(m.id);
      db.prepare('DELETE FROM units WHERE mission_id=?').run(m.id);
      db.prepare('DELETE FROM active_review WHERE mission_id=?').run(m.id);
      db.prepare('DELETE FROM active_mission WHERE id=?').run(m.id);
      db.prepare("INSERT INTO metadata(key,value) VALUES('legacy_imported','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
      db.exec('COMMIT');
      return {archived:true,missionId:m.id};
    }catch(e){rollbackIfOpen(db);throw e;}
  }finally{db.close();}
  });
}

export async function readMissionArchive({limit=25,before=null}={},file=statePath()){
  if(!Number.isInteger(limit)||limit<1||limit>100||
      (before!==null&&(!Number.isSafeInteger(before)||before<1)))
    fail('Invalid mission history pagination');
  await refuseInterruptedRestore(file);
  if(!await exists(databasePath(file)))return {items:[],nextCursor:null};
  const db=connect(databasePath(file),true);
  try{
    const rows=before===null
      ?db.prepare('SELECT * FROM mission_archive ORDER BY seq DESC LIMIT ?').all(limit+1)
      :db.prepare('SELECT * FROM mission_archive WHERE seq<? ORDER BY seq DESC LIMIT ?').all(before,limit+1);
    const page=rows.slice(0,limit);
    return {items:page.map(x=>({id:x.seq,missionId:x.mission_id,
      status:parse(x.snapshot).status,archivedAt:x.archived_at})),
      nextCursor:rows.length>limit?page[page.length-1].seq:null};
  }finally{db.close();}
}
