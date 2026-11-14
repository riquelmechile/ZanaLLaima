// Remote-mode records in the main SQLite database (schema v7): MCP sessions,
// remote mission bindings, per-session activity and the audit trail.
// Every function taking `db` runs inside a remoteWrite/remoteRead handle.
import {createHmac,randomBytes} from 'node:crypto';
import {remoteRead,remoteWrite} from './store.mjs';
import {canonicalJson} from './actor-assertion.mjs';
import {redactDeep,envSecrets} from './redact.mjs';

export const nowIso=()=>new Date().toISOString();
const SESSION=/^[A-Za-z0-9._:-]{8,200}$/;
// Retention: read-only audit rows are a bounded window; writes, refusals,
// merges and reviews are kept by age. Activity, sessions, checks and terminal
// tickets are pruned by age (activity only for missions that are not active).
export const MAX_READ_AUDIT=5000;
export const RETENTION_DAYS=Object.freeze({audit:365,activity:90,sessions:30,checks:30,tickets:180});
const DAY=86_400_000;

// Bind a transport session id to the OAuth identity that opened it, and keep
// the moment it was created (the "session created before the ticket" rule).
export async function registerSession({sessionId,host,clientId},file){
  if(!SESSION.test(String(sessionId)))throw new Error('Invalid session id');
  return remoteWrite(db=>{
    const old=db.prepare('SELECT * FROM remote_sessions WHERE session_id=?').get(sessionId);
    const epoch=ensureSessionWriterEpoch(db);
    const current=nowIso();
    // La sesión nueva debe ser estrictamente posterior a la época, incluso
    // cuando ambos timestamps caen en el mismo milisegundo.
    const at=current===epoch?new Date(Date.parse(epoch)+1).toISOString():current;
    if(old){
      if(old.host!==host||old.client_id!==clientId)throw new Error('Session belongs to another identity');
      db.prepare('UPDATE remote_sessions SET last_seen_at=? WHERE session_id=?').run(at,sessionId);
      return {sessionId,host,clientId,createdAt:old.created_at};
    }
    db.prepare('INSERT INTO remote_sessions(session_id,host,client_id,created_at,last_seen_at) VALUES(?,?,?,?,?)')
      .run(sessionId,host,clientId,at,at);
    return {sessionId,host,clientId,createdAt:at};
  },file);
}
export const sessionRow=(db,sessionId)=>db?.prepare('SELECT * FROM remote_sessions WHERE session_id=?').get(sessionId)??null;

export function remoteMission(db,missionId){
  const row=db?.prepare('SELECT * FROM remote_missions WHERE mission_id=?').get(missionId);
  return row?{missionId:row.mission_id,repo:row.repo,base:row.base,branch:row.branch,
    codeUnits:JSON.parse(row.code_units),createdSession:row.created_session,createdAt:row.created_at,
    lineBudgetExtension:row.line_budget_extension?JSON.parse(row.line_budget_extension):null}:null;
}
// client_id is kept with the activity because remote_sessions is pruned.
export function recordActivity(db,{sessionId,missionId,kind,tool,clientId=null}){
  db.prepare('INSERT INTO remote_activity(session_id,mission_id,kind,tool,created_at,client_id) VALUES(?,?,?,?,?,?)')
    .run(sessionId,missionId,kind,tool,nowIso(),clientId);
}
// OAuth clients that acted on the mission (creator, unit holders, writers, requesters).
export const missionClients=(db,missionId)=>db.prepare(
  'SELECT DISTINCT client_id FROM remote_activity WHERE mission_id=? AND client_id IS NOT NULL').all(missionId).map(r=>r.client_id);
export const sessionWrote=(db,sessionId,missionId)=>Boolean(db?.prepare(
  'SELECT 1 FROM remote_activity WHERE session_id=? AND mission_id=? LIMIT 1').get(sessionId,missionId));
// Marca monotónica en la misma base: no depende de la retención de actividad.
export const WRITER_EPOCH_KEY='zana:session-writer-epoch';
export function ensureSessionWriterEpoch(db){
  db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)').run(WRITER_EPOCH_KEY,nowIso());
  return db.prepare('SELECT value FROM metadata WHERE key=?').get(WRITER_EPOCH_KEY).value;
}
const writerKey=sessionId=>'zana:session-writer:'+sessionId;
export function markSessionWriter(db,sessionId){
  db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)').run(writerKey(sessionId),nowIso());
}
export const sessionIsWriter=(db,sessionId)=>Boolean(db?.prepare(
  'SELECT 1 FROM metadata WHERE key=?').get(writerKey(sessionId)));
// Un monitor revisor puede vivir durante muchos tickets, pero pierde esta
// excepción al escribir/adoptar en CUALQUIER misión o al haber sido autor.
// La razón permite diagnosticar al monitor sin mutar la sesión.
export function reviewerMonitorStatus(db,sessionId){
  const row=sessionRow(db,sessionId),writerMarked=sessionIsWriter(db,sessionId);
  const reason=writerMarked?'WRITER':
    !row||!(db.prepare('SELECT value FROM metadata WHERE key=?').get(WRITER_EPOCH_KEY)?.value<row.created_at)
      ?'BEFORE_EPOCH':
    !db.prepare('SELECT 1 FROM review_tickets WHERE reviewer_session=? AND claimed_at>=? LIMIT 1')
      .get(sessionId,row.created_at)?'NO_PRIOR_CLAIM':
    db.prepare('SELECT 1 FROM remote_activity WHERE session_id=? LIMIT 1').get(sessionId)||
    db.prepare('SELECT 1 FROM remote_missions WHERE created_session=? LIMIT 1').get(sessionId)||
    db.prepare('SELECT 1 FROM review_tickets WHERE author_session=? LIMIT 1').get(sessionId)
      ?'LEGACY_ROWS':null;
  return {writerMarked,reviewerMonitorEligible:reason===null,...(reason?{reviewerMonitorReason:reason}:{})};
}
export const sessionIsPureReviewer=(db,sessionId)=>reviewerMonitorStatus(db,sessionId).reviewerMonitorEligible;
// Author rule for zana_merge: the session that created the mission, or one
// that held (started or rebound) one of its units.
export const sessionIsMissionAuthor=(db,sessionId,missionId)=>Boolean(db&&(
  db.prepare('SELECT 1 FROM remote_missions WHERE mission_id=? AND created_session=?').get(missionId,sessionId)||
  db.prepare("SELECT 1 FROM remote_activity WHERE session_id=? AND mission_id=? AND kind IN ('UNIT_START','UNIT_REBIND','MISSION_ADOPT') LIMIT 1")
    .get(sessionId,missionId)));
// A session that claimed any ticket of the mission stays read-only on it.
export const sessionReviews=(db,sessionId,missionId)=>Boolean(db?.prepare(
  'SELECT 1 FROM review_tickets WHERE reviewer_session=? AND mission_id=? LIMIT 1').get(sessionId,missionId));

function auditKey(db){
  const row=db.prepare("SELECT value FROM metadata WHERE key='remote_audit_key'").get();
  if(row)return row.value;
  const key=randomBytes(32).toString('hex');
  db.prepare("INSERT INTO metadata(key,value) VALUES('remote_audit_key',?)").run(key);
  return key;
}
// Who (host and session), what tool, mission, outcome and a keyed hash of the
// arguments. Never the arguments themselves and never a token.
export const AUDIT_CATEGORIES=Object.freeze(['read','write','refused','merge','review','operator','github_admin','other']);
export function writeAudit(db,{caller,tool,missionId=null,outcome,args,detail=null,category='other'}){
  if(!AUDIT_CATEGORIES.includes(category))category='other';
  const argsHmac=args===undefined?null:
    createHmac('sha256',auditKey(db)).update(canonicalJson(args)).digest('hex');
  const text=detail===null?null:JSON.stringify(redactDeep(detail,envSecrets()));
  const safe=text!==null&&text.length>2000?JSON.stringify({truncated:true}):text;
  const row=db.prepare('INSERT INTO remote_audit(at,host,session_id,tool,mission_id,outcome,args_hmac,detail,category) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(nowIso(),caller?.host??null,caller?.sessionId??null,String(tool).slice(0,120),missionId,
      String(outcome).slice(0,40),argsHmac,safe,category);
  if(Number(row.lastInsertRowid)%100===0)pruneRemote(db);
}
export function pruneRemote(db,now=Date.now()){
  const before=days=>new Date(now-days*DAY).toISOString();
  const reads=db.prepare("SELECT seq FROM remote_audit WHERE category='read' ORDER BY seq DESC LIMIT 1 OFFSET ?").get(MAX_READ_AUDIT);
  if(reads)db.prepare("DELETE FROM remote_audit WHERE category='read' AND seq<=?").run(reads.seq);
  db.prepare('DELETE FROM remote_audit WHERE at<?').run(before(RETENTION_DAYS.audit));
  const active=db.prepare('SELECT id FROM active_mission WHERE slot=1').get()?.id??'';
  db.prepare('DELETE FROM remote_activity WHERE created_at<? AND mission_id!=?').run(before(RETENTION_DAYS.activity),active);
  db.prepare('DELETE FROM remote_checks WHERE created_at<?').run(before(RETENTION_DAYS.checks));
  const terminal="state IN ('FINALIZED','STALE_SHA','EXPIRED','ABANDONED')";
  // Never the active mission's tickets: they carry its same-SHA blockers.
  const old=db.prepare('SELECT ticket_id FROM review_tickets WHERE '+terminal+' AND updated_at<? AND mission_id!=?').all(before(RETENTION_DAYS.tickets),active);
  for(const {ticket_id} of old){
    db.prepare('DELETE FROM review_diff_pages WHERE ticket_id=?').run(ticket_id);
    // Lens receipts go with the ticket unless the finalized review is archived.
    db.prepare('DELETE FROM review_receipts WHERE review_id=? AND review_id NOT IN (SELECT review_id FROM review_archive)').run(ticket_id);
    db.prepare('DELETE FROM review_tickets WHERE ticket_id=?').run(ticket_id);
  }
  const expired=db.prepare("SELECT session_id FROM remote_sessions WHERE last_seen_at<? AND session_id NOT IN (SELECT author_session FROM review_tickets WHERE state NOT IN ('FINALIZED','STALE_SHA','EXPIRED','ABANDONED')) AND session_id NOT IN (SELECT reviewer_session FROM review_tickets WHERE reviewer_session IS NOT NULL AND state NOT IN ('FINALIZED','STALE_SHA','EXPIRED','ABANDONED'))")
    .all(before(RETENTION_DAYS.sessions));
  for(const {session_id} of expired){
    db.prepare('DELETE FROM remote_sessions WHERE session_id=?').run(session_id);
    // Se elimina con la sesión, en esta misma transacción, nunca por edad de la marca.
    db.prepare('DELETE FROM metadata WHERE key=?').run(writerKey(session_id));
  }
}
export const audit=(entry,file)=>remoteWrite(db=>writeAudit(db,entry),file);
export function readAudit({limit=50,missionId=null}={},file){
  if(!Number.isInteger(limit)||limit<1||limit>500)throw new Error('Invalid audit limit');
  return remoteRead(db=>{
    if(!db)return [];
    const rows=missionId
      ?db.prepare('SELECT * FROM remote_audit WHERE mission_id=? ORDER BY seq DESC LIMIT ?').all(missionId,limit)
      :db.prepare('SELECT * FROM remote_audit ORDER BY seq DESC LIMIT ?').all(limit);
    return rows.map(r=>({id:r.seq,at:r.at,host:r.host,sessionId:r.session_id,tool:r.tool,missionId:r.mission_id,
      outcome:r.outcome,category:r.category,argsHmac:r.args_hmac,detail:r.detail?JSON.parse(r.detail):null}));
  },file);
}
