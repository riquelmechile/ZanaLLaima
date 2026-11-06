import { DEFAULT_BUDGET } from './budget.mjs';
import { DatabaseSync, backup } from 'node:sqlite';
import { constants } from 'node:fs';
import { access, chmod, copyFile, link, mkdir, open, readFile, rename, rm, stat, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { operatorPublicKey, verifySignedAction, verifyStoredGrant } from './operator.mjs';
import { reconcileWrite, revokeRunningWrites } from './lifecycle.mjs';
import {inspectEffectTemporary} from './write-effect.mjs';
import {beginRestoreMoves,abortRestoreMoves,classifyRestoreArtifacts,cleanupRestoreArtifacts,interruptedRestoreJournal} from './restore-journal.mjs';
import {withRestoreLock} from './restore-lock.mjs';

const SCHEMA_VERSION = 8;
const MAX_EVENTS = 2000;
const MAX_ARCHIVES = 200;
const BUSY_MS = 10000;
const now = () => new Date().toISOString();
const RESTORE_EPOCH_KEY='restore_epoch';
const parseEpoch=(value,at=Date.now())=>{
  if(typeof value!=='string'||
     !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))return at;
  const ts=Date.parse(value);
  return Number.isFinite(ts)&&ts<=at?ts:at;
};

// Schema v7 (remote MCP mode): sessions, remote mission bindings, session
// activity, check requests, review tickets and audit; v8 adds project
// memory and remote_missions.project_id. Lens receipts reuse
// review_receipts (review_id = ticket id) and finalized reviews reuse
// review_archive (review_id = ticket id).
const REMOTE_TABLES=[
  'CREATE TABLE IF NOT EXISTS remote_sessions (session_id TEXT PRIMARY KEY, host TEXT NOT NULL, client_id TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS remote_missions (mission_id TEXT PRIMARY KEY, repo TEXT NOT NULL, base TEXT NOT NULL, branch TEXT NOT NULL, code_units TEXT NOT NULL, created_session TEXT NOT NULL, created_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS remote_activity (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, mission_id TEXT NOT NULL, kind TEXT NOT NULL, tool TEXT NOT NULL, created_at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS remote_activity_session ON remote_activity(mission_id,session_id)',
  'CREATE TABLE IF NOT EXISTS remote_checks (check_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, sha TEXT NOT NULL, workflow TEXT NOT NULL, dispatched INTEGER NOT NULL, session_id TEXT NOT NULL, created_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS review_tickets (ticket_id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, mission_id TEXT NOT NULL, repo TEXT NOT NULL, pr_number INTEGER NOT NULL, sha TEXT NOT NULL, author_session TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, state TEXT NOT NULL, reviewer_session TEXT, claimed_at TEXT, finalized_at TEXT, verdict TEXT, execution TEXT, github_review_id INTEGER, status_posted INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, author_client TEXT)',
  'CREATE TABLE IF NOT EXISTS review_diff_pages (ticket_id TEXT NOT NULL, page INTEGER NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, read_at TEXT, PRIMARY KEY(ticket_id,page))',
  'CREATE TABLE IF NOT EXISTS remote_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, host TEXT, session_id TEXT, tool TEXT NOT NULL, mission_id TEXT, outcome TEXT NOT NULL, args_hmac TEXT, detail TEXT, category TEXT NOT NULL DEFAULT \'other\')',
  // v8: project memory (src/project-memory.mjs). Never pruned by pruneRemote.
  'CREATE TABLE IF NOT EXISTS projects (project_id TEXT PRIMARY KEY, github_repo_id INTEGER NOT NULL UNIQUE, repo TEXT NOT NULL, created_at TEXT NOT NULL, created_mission TEXT)',
  "CREATE TABLE IF NOT EXISTS project_memory (seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('summary','decision','convention','issue','pending')), topic TEXT NOT NULL, body TEXT NOT NULL, mission_id TEXT, sha TEXT, session_id TEXT, created_at TEXT NOT NULL, superseded_by INTEGER, resolved_at TEXT)",
  'CREATE INDEX IF NOT EXISTS project_memory_live ON project_memory(project_id,kind,topic) WHERE superseded_by IS NULL',
];
const TICKET_RANK={OPEN:0,CLAIMED:1,FINALIZING:2,FINALIZED:3,STALE_SHA:3,EXPIRED:3,ABANDONED:3};
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
          'CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
          ...REMOTE_TABLES
        ].join(';') + ';');
        const columns=db.prepare('PRAGMA table_info(active_mission)').all().map(x=>x.name);
        if(!columns.includes('lifecycle')) db.exec("ALTER TABLE active_mission ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'ACTIVE'");
        if(!columns.includes('closed_at')) db.exec('ALTER TABLE active_mission ADD COLUMN closed_at TEXT');
        if(!columns.includes('review_count')) db.exec('ALTER TABLE active_mission ADD COLUMN review_count INTEGER NOT NULL DEFAULT 0');
        if(!columns.includes('budget')) db.exec('ALTER TABLE active_mission ADD COLUMN budget TEXT');
        const effectColumns=db.prepare('PRAGMA table_info(write_effect_receipts)').all().map(x=>x.name);
        if(!effectColumns.includes('pre_mode'))db.exec('ALTER TABLE write_effect_receipts ADD COLUMN pre_mode INTEGER');
        if(!effectColumns.includes('post_mode'))db.exec('ALTER TABLE write_effect_receipts ADD COLUMN post_mode INTEGER');
        const ticketColumns=db.prepare('PRAGMA table_info(review_tickets)').all().map(x=>x.name);
        if(!ticketColumns.includes('author_client'))db.exec('ALTER TABLE review_tickets ADD COLUMN author_client TEXT');
        if(!ticketColumns.includes('operator_released'))db.exec('ALTER TABLE review_tickets ADD COLUMN operator_released INTEGER NOT NULL DEFAULT 0');
        if(!ticketColumns.includes('line_budget'))db.exec('ALTER TABLE review_tickets ADD COLUMN line_budget TEXT');
        const missionColumns=db.prepare('PRAGMA table_info(remote_missions)').all().map(x=>x.name);
        if(!missionColumns.includes('line_budget_extension'))db.exec('ALTER TABLE remote_missions ADD COLUMN line_budget_extension TEXT');
        if(!missionColumns.includes('project_id'))db.exec('ALTER TABLE remote_missions ADD COLUMN project_id TEXT');
        const activityColumns=db.prepare('PRAGMA table_info(remote_activity)').all().map(x=>x.name);
        if(!activityColumns.includes('client_id'))db.exec('ALTER TABLE remote_activity ADD COLUMN client_id TEXT');
        // Rows written before client_id existed get it from their session
        // (once; sessions are pruned later, so do it while they are there).
        if(!db.prepare("SELECT 1 FROM metadata WHERE key='activity_client_backfill'").get()){
          db.exec('UPDATE remote_activity SET client_id=(SELECT s.client_id FROM remote_sessions s WHERE s.session_id=remote_activity.session_id) WHERE client_id IS NULL');
          db.exec("INSERT INTO metadata(key,value) VALUES('activity_client_backfill','1')");
        }
        const auditColumns=db.prepare('PRAGMA table_info(remote_audit)').all().map(x=>x.name);
        if(!auditColumns.includes('category'))db.exec("ALTER TABLE remote_audit ADD COLUMN category TEXT NOT NULL DEFAULT 'other'");
        db.exec('CREATE INDEX IF NOT EXISTS remote_audit_category ON remote_audit(category,seq)');
        setupMemoryFts(db);
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

// FTS5 index of project_memory (external content, kept by triggers). If this
// Node's SQLite lacks FTS5, metadata fts='0' and search falls back to LIKE.
export function setupMemoryFts(db){
  const existed=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name='project_memory_fts'").get());
  let fts='1';
  try{
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS project_memory_fts USING fts5(topic,body,content='project_memory',content_rowid='seq')");
    db.exec('CREATE TRIGGER IF NOT EXISTS project_memory_ai AFTER INSERT ON project_memory BEGIN INSERT INTO project_memory_fts(rowid,topic,body) VALUES(new.seq,new.topic,new.body); END');
    db.exec("CREATE TRIGGER IF NOT EXISTS project_memory_ad AFTER DELETE ON project_memory BEGIN INSERT INTO project_memory_fts(project_memory_fts,rowid,topic,body) VALUES('delete',old.seq,old.topic,old.body); END");
    db.exec("CREATE TRIGGER IF NOT EXISTS project_memory_au AFTER UPDATE OF topic,body ON project_memory BEGIN INSERT INTO project_memory_fts(project_memory_fts,rowid,topic,body) VALUES('delete',old.seq,old.topic,old.body); INSERT INTO project_memory_fts(rowid,topic,body) VALUES(new.seq,new.topic,new.body); END");
    if(!existed)db.exec("INSERT INTO project_memory_fts(project_memory_fts) VALUES('rebuild')");
  }catch{fts='0';}
  db.prepare("INSERT INTO metadata(key,value) VALUES('fts',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(fts);
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
  db.prepare('DELETE FROM review_receipts WHERE review_id != ? AND review_id NOT IN (SELECT review_id FROM review_archive) AND review_id NOT IN (SELECT ticket_id FROM review_tickets)').run(current);
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
  // Reject only a write that RAISES total starts above the limit. Restore can
  // fuse divergent histories (max per unit) above it; such a mission must still
  // be cancellable, expirable and archivable, it just can never start again.
  const startsOf=m=>m.units.reduce((n,u)=>n+(u.attempts||0),0);
  if(allowedStarts!==undefined && startsOf(next)>allowedStarts &&
     (!previous || startsOf(next)>startsOf(previous)))
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
      const updated = await change(previous ? structuredClone(previous) : null,{writeGrant:grant,db});
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
  restoreArtifacts.quarantineDetails=await describeQuarantines(path,restoreArtifacts.quarantines);
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
    const facts=securityFacts(live,{rebuild:forceDataLoss});
    if(!forceDataLoss)refuseConsumedBudget(load(candidate),facts.budget);
    return {blind:false,...facts};
  }catch(error){
    if(error instanceof RestoreGuardError)throw error;
    if(source.quarantine)
      guardRestore('QUARANTINE_UNREADABLE','Quarantined live database cannot be inspected; use storage-restore-abort');
    if(!forceDataLoss)
      guardRestore('LIVE_UNREADABLE','Live database cannot be inspected; explicit --force-data-loss required');
    return {blind:true,actions:[],revoked:[],epoch:null};
  }finally{if(live)live.close();}
}
// Consumed work budget is a monotone fact, like a consumed nonce. Per unit,
// attempts and leaseGeneration never move backwards across restore or
// adoption; total starts is derived as the sum of attempts, so it is monotone
// too. The mission revision is always fused to land above every source.
// Otherwise an offline restore would hand out fresh attempts without any
// operator signature (R11-C1).
//
// The single active-mission slot is not enough to remember consumption: a
// restore to another mission would drop it, and a later restore of an old
// backup would refund it (A -> B -> A, R11-C1b). So every database carries a
// ledger in metadata (CONSUMED_BUDGET_KEY), keyed by mission and then by unit
// or a reserved key (FENCE_UNIT, REVIEW_ROUNDS_KEY), that
// restore and adoption merge like nonces and never shrink.
const CONSUMED_BUDGET_KEY='consumed_budget';
// Ledger keys come from database bytes an operator may have been handed, so
// they live in null-prototype maps so no key can reach Object.prototype, and
// must be bounded strings. "__proto__" is still refused: a plain object built
// from the same JSON elsewhere would treat it as the prototype setter. Any id the store itself accepts (including legacy snapshots with
// non-UUID mission ids) stays valid.
const ledgerKey=k=>typeof k==='string'&&k.length>=1&&k.length<=200&&k!=='__proto__';
// Mission-wide fence: its consumption is unknown (a corrupt archived
// snapshot was set aside). Never a unit id: createMission ids are [a-z]...
const FENCE_UNIT='*';
// Consumed review rounds (reviewCount) of a mission, kept in the same ledger
// under a key no unit id can take (createMission ids start with [a-z]).
const REVIEW_ROUNDS_KEY='#review-rounds';
const invalidLedger=()=>guardRestore('INVALID_LEDGER','Consumed-budget ledger is malformed; preserve the database and inspect it');
const counter=v=>{
  if(v===undefined)return 0;
  if(!Number.isSafeInteger(v)||v<0)invalidLedger();
  return v;
};
function raise(ledger,missionId,unitId,attempts,leaseGeneration){
  if(!ledgerKey(missionId)||!ledgerKey(unitId))invalidLedger();
  const mission=Object.hasOwn(ledger,missionId)?ledger[missionId]:(ledger[missionId]=Object.create(null));
  const old=Object.hasOwn(mission,unitId)?mission[unitId]:{attempts:0,leaseGeneration:0};
  mission[unitId]={attempts:Math.max(old.attempts,counter(attempts)),
    leaseGeneration:Math.max(old.leaseGeneration,counter(leaseGeneration))};
}
function mergeLedgers(target,source){
  for(const [missionId,units] of Object.entries(source)){
    if(!units||typeof units!=='object'||Array.isArray(units))invalidLedger();
    for(const [unitId,u] of Object.entries(units)){
      if(!u||typeof u!=='object'||Array.isArray(u))invalidLedger();
      raise(target,missionId,unitId,u.attempts,u.leaseGeneration);
    }
  }
  return target;
}
function readLedger(db){
  const raw=db.prepare('SELECT value FROM metadata WHERE key=?').get(CONSUMED_BUDGET_KEY)?.value;
  const ledger=Object.create(null);
  if(raw===undefined)return ledger;
  let value;
  try{value=JSON.parse(raw);}catch{value=null;}
  if(!value||typeof value!=='object'||Array.isArray(value))invalidLedger();
  return mergeLedgers(ledger,value);
}
// Facts of one database: its ledger plus what its active and archived
// missions consumed (an archived mission keeps its units in the snapshot).
// With rebuild (only under --force-data-loss) a corrupt stored ledger or
// archived snapshot is dropped and the ledger is rebuilt from what the
// database still proves; the caller reports ledgerRebuilt.
function budgetFacts(db,{rebuild=false}={}){
  let ledger,rebuilt=false;
  const corruptArchive=[],damagedUnits=[];
  let damagedReview=false;
  try{ledger=readLedger(db);}
  catch(error){
    if(!rebuild||error.code!=='INVALID_LEDGER')throw error;
    ledger=Object.create(null);rebuilt=true;
  }
  const mission=load(db);
  const consume=m=>{
    for(const u of m?.units??[])raise(ledger,m.id,u.id,u.attempts||0,u.run?.leaseGeneration||0);
    if(m?.reviewCount!==undefined&&m.reviewCount!==0)raise(ledger,m.id,REVIEW_ROUNDS_KEY,m.reviewCount,0);
  };
  // Damaged counters on the active mission: under rebuild keep every unit
  // that is still valid and drop only the damaged ones, so recovery under
  // --force-data-loss is always possible.
  if(mission){
    const rounds=mission.reviewCount;
    if(!(Number.isSafeInteger(rounds)&&rounds>=0)){
      // Damaged review counter: unknown consumption. Never ignore it (a
      // negative value would hand out rounds); under rebuild fence it.
      if(!rebuild)invalidLedger();
      rebuilt=true;damagedReview=true;
      raise(ledger,mission.id,REVIEW_ROUNDS_KEY,reviewRoundCap(mission.budget),0);
    }else if(rounds>0)raise(ledger,mission.id,REVIEW_ROUNDS_KEY,rounds,0);
  }
  if(mission)for(const u of mission.units){
    try{raise(ledger,mission.id,u.id,u.attempts||0,u.run?.leaseGeneration||0);}
    catch(error){if(!rebuild||error.code!=='INVALID_LEDGER')throw error;rebuilt=true;damagedUnits.push(u.id);}
  }
  for(const row of db.prepare('SELECT seq,mission_id,snapshot FROM mission_archive').all()){
    let archived;
    try{archived=JSON.parse(row.snapshot);}catch{archived=null;}
    try{
      if(!archived||typeof archived.id!=='string'||!Array.isArray(archived.units))
        guardRestore('INVALID_LEDGER','Archived mission snapshot is malformed; preserve the database and inspect it');
      consume(archived);
    }catch(error){
      if(!rebuild||error.code!=='INVALID_LEDGER')throw error;
      rebuilt=true;
      // The snapshot was the only record of what that mission consumed.
      // Fence it instead of forgetting it: a backup of that mission is then
      // refused without --force-data-loss and exhausted with it. A row whose
      // mission id is unusable cannot be fenced, so it stays where it is.
      if(ledgerKey(row.mission_id)){
        raise(ledger,row.mission_id,FENCE_UNIT,1,0);
        corruptArchive.push(row.seq);
      }
    }
  }
  return {revision:mission?.revision??null,running:!!mission?.units.some(u=>u.status==='RUNNING'),
    ledger,rebuilt,corruptArchive,damagedUnits,damagedReview};
}
function refuseConsumedBudget(backupMission,liveBudget){
  if(liveBudget.running)
    guardRestore('CONSUMED_BUDGET','Live database has RUNNING work; restore refused. With --force-data-loss the consumed attempts are kept as max(live, backup)');
  const consumed=backupMission&&Object.hasOwn(liveBudget.ledger,backupMission.id)?liveBudget.ledger[backupMission.id]:null;
  if(!consumed)return;
  if(Object.hasOwn(consumed,FENCE_UNIT))
    guardRestore('CONSUMED_BUDGET','Consumption of mission '+backupMission.id+' is unknown (a corrupt archived snapshot was set aside); restore refused. With --force-data-loss the mission is restored exhausted');
  if(Object.hasOwn(consumed,REVIEW_ROUNDS_KEY)&&consumed[REVIEW_ROUNDS_KEY].attempts>(backupMission.reviewCount||0))
    guardRestore('CONSUMED_BUDGET','Mission '+backupMission.id+' consumed review rounds not present in the backup; restore refused. With --force-data-loss they are kept as max(live, backup)');
  for(const u of backupMission.units){
    const used=Object.hasOwn(consumed,u.id)?consumed[u.id]:null;
    if(used&&(used.attempts>(u.attempts||0)||used.leaseGeneration>(u.run?.leaseGeneration||0)))
      guardRestore('CONSUMED_BUDGET','Unit '+u.id+' of mission '+backupMission.id+' consumed attempts not present in the backup; restore refused. With --force-data-loss they are kept as max(live, backup)');
  }
}
// Fuse facts into the candidate database. The ledger and the revision are
// fused on every restore or adoption. Attempts/leaseGeneration of the
// candidate's own units are raised too; without --force-data-loss that is a
// no-op because refuseConsumedBudget already proved they are not lower.
function mergeBudgetFacts(db,facts,{ownLedger}={}){
  if(!facts)return;
  const ledger=mergeLedgers(ownLedger??readLedger(db),facts.ledger);
  db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(CONSUMED_BUDGET_KEY,json(ledger));
  const m=db.prepare('SELECT id,revision FROM active_mission WHERE slot=1').get();
  if(!m)return;
  if(facts.revision!==null&&facts.revision>=m.revision)
    db.prepare('UPDATE active_mission SET revision=? WHERE slot=1').run(facts.revision+1);
  const own=Object.hasOwn(ledger,m.id)?ledger[m.id]:Object.create(null);
  if(Object.hasOwn(own,FENCE_UNIT)){
    // Unknown consumption: exhaust every unit so nothing can start again.
    const cap=unitAttemptCap(parse(db.prepare('SELECT budget FROM active_mission WHERE slot=1').get()?.budget??'null'));
    db.prepare('UPDATE units SET attempts=MAX(attempts,?) WHERE mission_id=?').run(cap,m.id);
    db.prepare('UPDATE active_mission SET review_count=MAX(review_count,?) WHERE slot=1')
      .run(reviewRoundCap(parse(db.prepare('SELECT budget FROM active_mission WHERE slot=1').get()?.budget??'null')));
  }
  if(Object.hasOwn(own,REVIEW_ROUNDS_KEY))
    db.prepare('UPDATE active_mission SET review_count=MAX(review_count,?) WHERE slot=1').run(own[REVIEW_ROUNDS_KEY].attempts);
  const read=db.prepare('SELECT status,attempts,run FROM units WHERE mission_id=? AND id=?');
  const write=db.prepare('UPDATE units SET attempts=?,run=? WHERE mission_id=? AND id=?');
  for(const [unitId,used] of Object.entries(own)){
    const row=read.get(m.id,unitId);
    if(!row)continue;
    const run=parse(row.run);
    const attempts=Math.max(row.attempts||0,used.attempts);
    // An OUTCOME_UNKNOWN write keeps its exact token/generation: signed
    // reconciliation (reconcileWrite, reconcile-view) must still match it,
    // and the unit cannot start again until reconciled anyway. Only its
    // attempts are raised.
    const generation=row.status==='OUTCOME_UNKNOWN'?(run?.leaseGeneration||0):
      Math.max(run?.leaseGeneration||0,used.leaseGeneration);
    if(attempts===(row.attempts||0)&&generation===(run?.leaseGeneration||0))continue;
    // Any other unit may end up with a run object holding only leaseGeneration
    // (e.g. a PENDING unit from the backup). startBatch issues the next
    // generation from run?.leaseGeneration, and lifecycle reads the rest of run
    // only for RUNNING or OUTCOME_UNKNOWN units, so this keeps old lease
    // tokens stale without inventing a lease.
    write.run(attempts,json(generation?{...(run??{}),leaseGeneration:generation}:run),m.id,unitId);
  }
}
// Per-unit attempt limit of a stored mission budget (grandfathered default).
const reviewRoundCap=budget=>Number.isSafeInteger(budget?.maxReviewRounds)?budget.maxReviewRounds:DEFAULT_BUDGET.maxReviewRounds;
const unitAttemptCap=budget=>Number.isSafeInteger(budget?.maxUnitAttempts)?budget.maxUnitAttempts:DEFAULT_BUDGET.maxUnitAttempts;
// The monotone facts every restore and adoption source contributes.
function securityFacts(db,{rebuild=false}={}){
  return {
    actions:db.prepare('SELECT nonce,mission_id,kind,created_at FROM operator_actions').all(),
    revoked:db.prepare('SELECT grant_id,mission_id,payload,signature,fingerprint,revoked,created_at FROM operator_grants WHERE revoked=1').all(),
    epoch:db.prepare('SELECT value FROM metadata WHERE key=?').get(RESTORE_EPOCH_KEY)?.value??null,
    budget:budgetFacts(db,{rebuild}),
    remote:remoteFacts(db)};
}
// Remote review facts are monotone too: a consumed (claimed, finalized, stale
// or expired) ticket must never become claimable again because an older
// backup was restored. Sessions, activity, checks and audit rows are unioned.
// Hooked only through securityFacts/mergeSecurityFacts, so the restore and
// adopt flows themselves are unchanged.
function remoteFacts(db){
  return {
    sessions:db.prepare('SELECT * FROM remote_sessions').all(),
    missions:db.prepare('SELECT * FROM remote_missions').all(),
    activity:db.prepare('SELECT session_id,mission_id,kind,tool,created_at,client_id FROM remote_activity').all(),
    checks:db.prepare('SELECT * FROM remote_checks').all(),
    tickets:db.prepare('SELECT * FROM review_tickets').all(),
    lenses:db.prepare('SELECT r.* FROM review_receipts r JOIN review_tickets t ON t.ticket_id=r.review_id').all(),
    archive:db.prepare('SELECT a.mission_id,a.review_id,a.content,a.created_at FROM review_archive a JOIN review_tickets t ON t.ticket_id=a.review_id').all(),
    audit:db.prepare('SELECT at,host,session_id,tool,mission_id,outcome,args_hmac,detail,category FROM remote_audit').all(),
    diffPages:db.prepare('SELECT * FROM review_diff_pages').all(),
    auditKey:db.prepare("SELECT value FROM metadata WHERE key='remote_audit_key'").get()?.value??null,
  };
}
const insertRow=(db,table,row,mode='OR IGNORE')=>{
  const keys=Object.keys(row);
  db.prepare('INSERT '+mode+' INTO '+table+'('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')')
    .run(...keys.map(k=>row[k]));
};
function mergeRemoteFacts(db,facts){
  if(!facts)return;
  for(const row of facts.sessions)insertRow(db,'remote_sessions',row);
  for(const row of facts.missions)insertRow(db,'remote_missions',row);
  for(const row of facts.checks)insertRow(db,'remote_checks',row);
  const findTicket=db.prepare('SELECT state FROM review_tickets WHERE ticket_id=?');
  for(const row of facts.tickets){
    const old=findTicket.get(row.ticket_id);
    if(!old||(TICKET_RANK[row.state]??3)>=(TICKET_RANK[old.state]??3))
      insertRow(db,'review_tickets',row,'OR REPLACE');
  }
  for(const row of facts.lenses)insertRow(db,'review_receipts',row);
  // A page read is a monotone fact too.
  for(const row of facts.diffPages??[]){
    insertRow(db,'review_diff_pages',row);
    if(row.read_at)db.prepare('UPDATE review_diff_pages SET read_at=COALESCE(read_at,?) WHERE ticket_id=? AND page=?').run(row.read_at,row.ticket_id,row.page);
  }
  for(const row of facts.archive)insertRow(db,'review_archive',row);
  const sameActivity=db.prepare('SELECT 1 FROM remote_activity WHERE session_id=? AND mission_id=? AND kind=? AND tool=? AND created_at=?');
  for(const row of facts.activity)
    if(!sameActivity.get(row.session_id,row.mission_id,row.kind,row.tool,row.created_at))
      insertRow(db,'remote_activity',row,'');
  const sameAudit=db.prepare('SELECT 1 FROM remote_audit WHERE at=? AND tool=? AND outcome=? AND session_id IS ? AND args_hmac IS ?');
  for(const row of facts.audit)
    if(!sameAudit.get(row.at,row.tool,row.outcome,row.session_id,row.args_hmac))
      insertRow(db,'remote_audit',row,'');
  if(facts.auditKey)db.prepare("INSERT INTO metadata(key,value) VALUES('remote_audit_key',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(facts.auditKey);
}
// Without readable live history, no restored ticket may still be claimable.
function fenceRemoteTickets(db){
  db.prepare("UPDATE review_tickets SET state='EXPIRED',updated_at=? WHERE state IN ('OPEN','CLAIMED','FINALIZING')").run(now());
}
// Remote mode helpers. The callback receives the open handle and the active
// mission (read-only view). Writes run inside the same serialized
// BEGIN IMMEDIATE discipline as transact().
export async function remoteWrite(fn,file=statePath()){
  const path=databasePath(file);
  return queueLocalWrite(path,async()=>{
    await refuseInterruptedRestore(file);
    await ensureFile(path);
    const db=connect(path);
    try{
      db.exec('BEGIN IMMEDIATE');
      try{
        const result=await fn(db,load(db));
        db.exec('COMMIT');
        return result;
      }catch(e){rollbackIfOpen(db);throw e;}
    }finally{db.close();}
  });
}
export async function remoteRead(fn,file=statePath()){
  await refuseInterruptedRestore(file);
  const path=databasePath(file);
  if(!await exists(path))return fn(null,null);
  const db=connect(path,true);
  try{return await fn(db,load(db));}finally{db.close();}
}
export async function ensureSchema(file=statePath()){
  const path=databasePath(file);
  return queueLocalWrite(path,async()=>{
    await refuseInterruptedRestore(file);
    await ensureFile(path);
    connect(path).close();
    return {databasePath:path,schemaVersion:SCHEMA_VERSION};
  });
}
function mergeSecurityFacts(db,security){
  if(security.blind){
    db.exec('UPDATE operator_grants SET revoked=1');
    fenceRemoteTickets(db);
  }else{
    mergeRemoteFacts(db,security.remote);
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
  const existing=db.prepare('SELECT value FROM metadata WHERE key=?').get(RESTORE_EPOCH_KEY)?.value;
  const floor=security.blind?new Date().toISOString():security.epoch;
  const currentTime=Date.now();
  const parsed=[existing,floor].filter(x=>x!==null&&x!==undefined)
    .map(x=>parseEpoch(x,currentTime));
  const epoch=parsed.length?new Date(Math.max(...parsed)).toISOString():null;
  if(epoch)db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(RESTORE_EPOCH_KEY,epoch);
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
// Call this only while holding the same cross-process lock as restoreBackup.
// The public entry points acquire it; restore's internal auto-abort must not
// acquire it twice (flock is non-reentrant across child processes).
async function abortRestoreUnlocked(file,{afterRename}={}){
  const path=databasePath(file);
  return abortRestoreMoves(path,{checkpoint:checkpointExclusive,afterRename});
}
export async function storageRestoreAbort(file=statePath(),options={}){
  if(process.env.ZANA_RESTORE_OFFLINE!=='1')
    guardRestore('OFFLINE_REQUIRED','storage-restore-abort requires explicit offline operator mode');
  return withRestoreLock(databasePath(file),()=>abortRestoreUnlocked(file,options));
}
export async function storageCleanupArtifacts(file=statePath(),{confirm=false}={}){
  if(process.env.ZANA_RESTORE_OFFLINE!=='1')
    guardRestore('OFFLINE_REQUIRED','Artifact cleanup requires offline operator mode');
  return withRestoreLock(databasePath(file),
    ()=>cleanupRestoreArtifacts(databasePath(file),{confirm}));
}

// A quarantine status must expose enough chronology for an operator to choose
// consciously. Never infer authority from a filename, mtime or malformed DB.
const restoreArtifactUUID=/^\.(?:quarantine|aborted)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const exactRestoreArtifacts=(base,paths)=>paths.filter(x=>
  x.startsWith(base)&&restoreArtifactUUID.test(x.slice(base.length)));
async function describeQuarantines(base,paths){
  const output=[];
  for(const path of exactRestoreArtifacts(base,paths)){
    let db;
    try{
      const f=await lstat(path);
      if(!f.isFile()||f.isSymbolicLink())throw Error('Not a regular quarantine file');
      db=connect(path,true);
      assertHealthy(db);
      const m=db.prepare('SELECT revision,updated_at FROM active_mission LIMIT 1').get();
      const revocations=db.prepare('SELECT COUNT(*) AS n FROM operator_grants WHERE revoked=1').get().n;
      output.push({path,revision:m?.revision??null,updatedAt:m?.updated_at??null,revocations});
    }catch(error){output.push({path,error:'UNREADABLE_QUARANTINE'});}
    finally{if(db)db.close();}
  }
  return output;
}
async function otherQuarantineSecurity(base,selected){
  const artifacts=await classifyRestoreArtifacts(base);
  const paths=exactRestoreArtifacts(base,[...artifacts.quarantines,...artifacts.aborted])
    .filter(path=>path!==selected);
  const sources=[],skipped=[];
  for(const path of paths){
    let db;
    try{
      const st=await lstat(path);
      if(!st.isFile()||st.isSymbolicLink()){skipped.push({path,reason:'NOT_REGULAR'});continue;}
      db=connect(path,true);
      assertHealthy(db);
      sources.push({path,...securityFacts(db)});
    }catch(error){
      // Only legible, integrity-checked sources can contribute facts. Unreadable
      // sources never authorize writes (blind fencing revokes ALL grants), but
      // their consumed budget is unknown, so callers must surface them.
      skipped.push({path,reason:error?.code==='INVALID_LEDGER'?'INVALID_LEDGER':'UNREADABLE'});
    }finally{if(db)db.close();}
  }
  return {sources,skipped};
}
// The detail recorded by the latest QUARANTINE_ADOPTED event for this exact
// quarantine, or null.
const ADOPTION_PREPARED_KEY='adoption_prepared';
// Clear the prepared marker once the adopted DB is published, so a later
// backup of it never looks like an interrupted adoption.
function clearAdoptionPrepared(path){
  const db=connect(path);
  try{db.prepare('DELETE FROM metadata WHERE key=?').run(ADOPTION_PREPARED_KEY);}
  finally{db.close();}
}
function adoptionRecord(db,id){
  for(const row of db.prepare("SELECT detail FROM state_events WHERE category='QUARANTINE_ADOPTED' ORDER BY seq DESC").all()){
    let detail;
    try{detail=JSON.parse(row.detail);}catch{continue;}
    if(detail?.quarantineId===id)return detail;
  }
  return null;
}
// Opt-in disaster recovery ONLY when the live DB is missing and no journal
// owns a quarantine. An exact operator-provided UUID replaces mtime heuristics.
// The revocations and consumed nonces already present in that quarantine
// become the live security history. Record the adoption event DURABLY before
// publishing the checkpointed database; crash/retry cannot erase the event.
export async function storageAdoptQuarantine(id,file=statePath(),{confirm=false,forceDataLoss=false}={}){
  if(!confirm)guardRestore('CONFIRM_REQUIRED','storage-adopt-quarantine requires --confirm');
  if(typeof forceDataLoss!=='boolean')guardRestore('INVALID_FORCE','forceDataLoss must be a boolean');
  if(process.env.ZANA_RESTORE_OFFLINE!=='1')
    guardRestore('OFFLINE_REQUIRED','Quarantine adoption requires offline operator mode');
  if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    guardRestore('INVALID_UUID','Invalid quarantine UUID');
  const path=databasePath(file),quarantine=path+'.quarantine.'+id;
  return withRestoreLock(path,async()=>{
    if(await interruptedRestoreJournal(path))
      guardRestore('JOURNAL_ACTIVE','Recovery journal active; run storage-restore-abort first');
    // After SIGKILL between publishing via link() and removing quarantine,
    // both paths name the exact same inode. Safely complete unlink, never
    // replace a different live database.
    if(await exists(path)){
      if(await exists(quarantine)){
        const live=await stat(path),retained=await stat(quarantine);
        if(live.dev===retained.dev&&live.ino===retained.ino){
          // Same order as the main path: clear the marker before dropping
          // the second name, so a failure here can be retried.
          clearAdoptionPrepared(path);
          await rm(quarantine);
          const fd=await open(dirname(path),'r');
          try{await fd.sync();}finally{await fd.close();}
          // Return what the completed adoption recorded, so a rerun after a
          // crash shows the same skipped sources and rebuild as the first run.
          const done=connect(path,true);
          let first;
          try{first=adoptionRecord(done,id)??{};}finally{done.close();}
          return {adopted:true,recovered:true,quarantineId:id,databasePath:path,
            skippedSources:first.skippedSources??[],ledgerRebuilt:!!first.ledgerRebuilt};
        }
      }
      guardRestore('LIVE_PRESENT','No se puede adoptar: existe una DB viva');
    }
    if(!await exists(quarantine))
      guardRestore('NOT_FOUND','No existe la cuarentena solicitada: '+id);
    const st=await lstat(quarantine);
    if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)
      guardRestore('UNSAFE_QUARANTINE','Quarantine must be a unique regular SQLite database');
    await checkpointExclusive(quarantine,{allowMissing:false});
    const {sources:securitySources,skipped}=await otherQuarantineSecurity(path,quarantine);
    // An unreadable sibling may hold newer consumed budget that adoption
    // would silently refund; adopting past it is explicit data loss.
    if(skipped.length&&!forceDataLoss)
      guardRestore('UNREADABLE_SOURCE','Unreadable or irregular restore artifacts may hold newer consumed budget: '+
        skipped.map(x=>x.path+' ('+x.reason+')').join(', ')+'; inspect them or repeat with --force-data-loss');
    const db=connect(quarantine);
    let recorded=null,detail=null;
    try{
      assertHealthy(db);
      const mission=load(db);
      if(!mission)guardRestore('EMPTY_QUARANTINE','Quarantine contains no active mission');
      // Validate the chosen copy's own ledger before publishing it: a corrupt
      // ledger would make every later restore fail with INVALID_LEDGER.
      // Under --force-data-loss it is rebuilt from the copy's units.
      const own=budgetFacts(db,{rebuild:forceDataLoss});
      detail={quarantineId:id,source:'OPERATOR_EXPLICIT_CONFIRMATION',
        securitySources:securitySources.map(x=>x.path),skippedSources:skipped,
        ledgerRebuilt:own.rebuilt,corruptArchiveRows:own.corruptArchive.length,blindFence:true};
      db.exec('BEGIN IMMEDIATE');
      try{
        // Write the chosen copy's own (validated or rebuilt) ledger first: an
        // empty fact set makes mergeBudgetFacts persist ownLedger unchanged.
        mergeBudgetFacts(db,{revision:null,ledger:Object.create(null)},{ownLedger:own.ledger});
        // A unit whose counters were damaged has unknown consumption: publish
        // it exhausted (never with credit such as attempts=-1) and with a
        // sane generation, and record that in the ledger.
        if(own.damagedUnits.length){
          const cap=unitAttemptCap(mission.budget);
          const read=db.prepare('SELECT run FROM units WHERE mission_id=? AND id=?');
          const write=db.prepare('UPDATE units SET attempts=?,run=? WHERE mission_id=? AND id=?');
          const ledger=readLedger(db);
          for(const unitId of own.damagedUnits){
            const run=parse(read.get(mission.id,unitId)?.run??'null');
            const gen=Number.isSafeInteger(run?.leaseGeneration)&&run.leaseGeneration>=0?run.leaseGeneration:0;
            write.run(cap,json(run?{...run,leaseGeneration:gen}:run),mission.id,unitId);
            raise(ledger,mission.id,unitId,cap,gen);
          }
          db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
            .run(CONSUMED_BUDGET_KEY,json(ledger));
        }
        // A damaged review counter is published exhausted, written explicitly
        // (MAX() would keep a text value, which sorts above integers).
        if(own.damagedReview)
          db.prepare('UPDATE active_mission SET review_count=? WHERE slot=1').run(reviewRoundCap(mission.budget));
        // Heal what the rebuild skipped: corrupt archive rows move to their
        // own table (kept for inspection) so later restores need no force.
        if(own.corruptArchive.length){
          db.exec('CREATE TABLE IF NOT EXISTS mission_archive_corrupt (seq INTEGER PRIMARY KEY, mission_id TEXT NOT NULL, snapshot TEXT NOT NULL, archived_at TEXT NOT NULL, moved_at TEXT NOT NULL)');
          const move=db.prepare('INSERT OR REPLACE INTO mission_archive_corrupt(seq,mission_id,snapshot,archived_at,moved_at) SELECT seq,mission_id,snapshot,archived_at,? FROM mission_archive WHERE seq=?');
          const drop=db.prepare('DELETE FROM mission_archive WHERE seq=?');
          for(const seq of own.corruptArchive){move.run(now(),seq);drop.run(seq);}
        }
        // Merge monotone revocations, consumed nonces and consumed work budget
        // from every readable quarantine and aborted DB, then revoke all grants because a lost
        // live DB cannot prove its absent authorization history.
        for(const security of securitySources){
          mergeSecurityFacts(db,{...security,blind:false});
          mergeBudgetFacts(db,security.budget);
        }
        mergeSecurityFacts(db,{blind:true,actions:[],revoked:[],epoch:null});
        // One event per adoption run. A rerun after a crash between COMMIT
        // and link() finds this copy marked as prepared for the same UUID and
        // reuses what the first run recorded. Any other copy (even one that
        // reuses an adopted UUID) records its own event.
        const prepared=db.prepare('SELECT value FROM metadata WHERE key=?').get(ADOPTION_PREPARED_KEY)?.value;
        recorded=prepared===id?adoptionRecord(db,id):null;
        if(!recorded){
          addEvent(db,mission,'QUARANTINE_ADOPTED',detail);
          db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
            .run(ADOPTION_PREPARED_KEY,id);
        }
        db.exec('COMMIT');
      }catch(error){rollbackIfOpen(db);throw error;}
    }finally{db.close();}
    await checkpointExclusive(quarantine,{allowMissing:false});
    // An empty WAL is never required to recover committed bytes; do not
    // move sidecars without the main DB. Fail closed if it has pending data.
    if(await exists(quarantine+'-wal')&&(await stat(quarantine+'-wal')).size!==0)
      guardRestore('WAL_NOT_EMPTY','Quarantine WAL not fully checkpointed');
    for(const suffix of ['-wal','-shm'])
      await rm(quarantine+suffix,{force:true});
    // link() publishes exclusively: unlike rename, it cannot overwrite
    // a database another process created during offline recovery.
    await link(quarantine,path);
    const d=await open(dirname(path),'r');
    try{await d.sync();}finally{await d.close();}
    // Clear the marker while both names still point to the same inode: if
    // this fails or the process dies here, a rerun takes the same-inode
    // "recovered" branch instead of LIVE_PRESENT.
    clearAdoptionPrepared(path);
    await rm(quarantine);
    const d2=await open(dirname(path),'r');
    try{await d2.sync();}finally{await d2.close();}
    const outcome=recorded??detail;
    return {adopted:true,quarantineId:id,databasePath:path,
      skippedSources:outcome.skippedSources??[],ledgerRebuilt:!!outcome.ledgerRebuilt,
      note:'Explicit quarantine adoption; audit event persisted before publication'};
  });
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
async function restoreBackupUnlocked(source,file=statePath(),
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
    await abortRestoreUnlocked(file);
  // Classify prior DB before generating a new .restoring.* candidate.
  const sourceLive=await previousLiveDatabase(path);
  const temp=path+'.restoring.'+randomUUID();
  const quarantine=path+'.quarantine.'+randomUUID();
  // What this restore could not prove, returned so the operator sees it.
  const report={blind:false,ledgerRebuilt:false,skippedSources:[]};
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
      // The backup's own ledger and archive must be valid in EVERY restore,
      // blind included; a corrupt backup is never published (pick another).
      budgetFacts(candidate);
      const security=inspectLive(candidate,sourceLive,forceDataLoss);
      // A blind restore cannot read the live history. Merge what readable
      // aborted copies still prove; consumption only the lost DB knew is the
      // data loss --force-data-loss accepts (documented in sqlite-storage.md).
      const scan=security.blind?await otherQuarantineSecurity(path,null):{sources:[],skipped:[]};
      const siblings=scan.sources;
      Object.assign(report,{blind:!!security.blind,ledgerRebuilt:!!security.budget?.rebuilt,
        skippedSources:scan.skipped});
      candidate.exec('BEGIN IMMEDIATE');
      try{
        mergeSecurityFacts(candidate,security);
        // Always fuse, blind included: an empty live fact set still makes the
        // backup's own ledger raise its own units (Codex P1 via GPT-A).
        mergeBudgetFacts(candidate,security.budget??{revision:null,ledger:Object.create(null)});
        for(const sibling of siblings){
          mergeSecurityFacts(candidate,{...sibling,blind:false});
          mergeBudgetFacts(candidate,sibling.budget);
        }
        candidate.exec('COMMIT');
      }catch(error){rollbackIfOpen(candidate);throw error;}
    }finally{candidate.close();}
    try{
      const result=await beginRestoreMoves({path,temp,quarantine,
        checkpoint:checkpointExclusive,allowUnreadable:forceDataLoss,
        afterQuarantine,afterRename,afterJournalReady});
      return {...result,...report,quarantinePath:result.quarantinePath??(
        sourceLive.quarantine?sourceLive.path:null)};
    }catch(error){
      // Ordinary thrown errors roll back through the journal. SIGKILL leaves
      // it intact and is reconciled by the next operator action.
      if(await interruptedRestoreJournal(path)){
        try{await abortRestoreUnlocked(file);}
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

// One flock covers the complete offline restore: source validation, checkpoint,
// journal creation, every DB/WAL/SHM rename, rollback and artifact cleanup.
// The lock is released automatically when the caller exits or is SIGKILLed.
export async function restoreBackup(source,file=statePath(),options={}){
  if(process.env.ZANA_RESTORE_OFFLINE!=='1'||options.offline!==true)
    guardRestore('OFFLINE_REQUIRED','Restoration requires explicit offline operator mode');
  return withRestoreLock(databasePath(file),
    ()=>restoreBackupUnlocked(source,file,options));
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

// Future or malformed restore_epoch values are a deny-by-default fence,
// but they must not remain in SQLite forever. Persist the clamped bound in
// its own autocommitted statement before validating a new signed action;
// even a rejected action must not roll the correction back.
function clampPersistedEpoch(db){
  const row=db.prepare('SELECT value FROM metadata WHERE key=?').get(RESTORE_EPOCH_KEY);
  if(!row)return null;
  const numeric=parseEpoch(row.value);
  const clamped=new Date(numeric).toISOString();
  if(clamped!==row.value)
    db.prepare('UPDATE metadata SET value=? WHERE key=?').run(clamped,RESTORE_EPOCH_KEY);
  return clamped;
}
export async function applyOperatorAction(envelope,file=statePath()){
  const path=databasePath(file);
  return queueLocalWrite(path,async()=>{
    await refuseInterruptedRestore(file);
    if(!await exists(path))fail('No database to authorize');
    const db=connect(path);
  try{
    clampPersistedEpoch(db);
    db.exec('BEGIN IMMEDIATE');
    try{
      const previous=load(db);
      if(!previous)fail('No active mission to authorize');
      const {key,fingerprint}=await operatorPublicKey();
      const p=verifySignedAction(envelope,previous,key);
      const epoch=db.prepare('SELECT value FROM metadata WHERE key=?').get(RESTORE_EPOCH_KEY)?.value;
      if(epoch){
        const cutoff=parseEpoch(epoch);
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
