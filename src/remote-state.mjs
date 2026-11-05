// Remote-mode records in the main SQLite database (schema v7): MCP sessions,
// remote mission bindings, per-session activity and the audit trail.
// Every function taking `db` runs inside a remoteWrite/remoteRead handle.
import {createHmac,randomBytes} from 'node:crypto';
import {remoteRead,remoteWrite} from './store.mjs';
import {canonicalJson} from './actor-assertion.mjs';
import {redactDeep,envSecrets} from './redact.mjs';

export const nowIso=()=>new Date().toISOString();
const SESSION=/^[A-Za-z0-9._:-]{8,200}$/;

// Bind a transport session id to the OAuth identity that opened it, and keep
// the moment it was created (the "session created before the ticket" rule).
export async function registerSession({sessionId,host,clientId},file){
  if(!SESSION.test(String(sessionId)))throw new Error('Invalid session id');
  return remoteWrite(db=>{
    const old=db.prepare('SELECT * FROM remote_sessions WHERE session_id=?').get(sessionId);
    const at=nowIso();
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
    codeUnits:JSON.parse(row.code_units),createdSession:row.created_session,createdAt:row.created_at}:null;
}
export function recordActivity(db,{sessionId,missionId,kind,tool}){
  db.prepare('INSERT INTO remote_activity(session_id,mission_id,kind,tool,created_at) VALUES(?,?,?,?,?)')
    .run(sessionId,missionId,kind,tool,nowIso());
}
export const sessionWrote=(db,sessionId,missionId)=>Boolean(db?.prepare(
  'SELECT 1 FROM remote_activity WHERE session_id=? AND mission_id=? LIMIT 1').get(sessionId,missionId));
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
export function writeAudit(db,{caller,tool,missionId=null,outcome,args,detail=null}){
  const argsHmac=args===undefined?null:
    createHmac('sha256',auditKey(db)).update(canonicalJson(args)).digest('hex');
  const text=detail===null?null:JSON.stringify(redactDeep(detail,envSecrets()));
  const safe=text!==null&&text.length>2000?JSON.stringify({truncated:true}):text;
  db.prepare('INSERT INTO remote_audit(at,host,session_id,tool,mission_id,outcome,args_hmac,detail) VALUES(?,?,?,?,?,?,?,?)')
    .run(nowIso(),caller?.host??null,caller?.sessionId??null,String(tool).slice(0,120),missionId,
      String(outcome).slice(0,40),argsHmac,safe);
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
      outcome:r.outcome,argsHmac:r.args_hmac,detail:r.detail?JSON.parse(r.detail):null}));
  },file);
}
