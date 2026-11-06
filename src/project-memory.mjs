// Memoria por proyecto del modo remoto (esquema v8). Un proyecto es un repo
// de GitHub identificado por su id numérico (sobrevive renombres y
// transferencias); el puntero .zanallaima.json en la rama base solo lleva el
// projectId, que sirve únicamente a través del OAuth del servidor. Las
// funciones que reciben `db` corren dentro de un remoteWrite/transact.
import {randomBytes} from 'node:crypto';
import {redactText} from './redact.mjs';
import {nowIso} from './remote-state.mjs';

export const POINTER_PATH='.zanallaima.json';
export const MEMORY_KINDS=Object.freeze(['summary','decision','convention','issue','pending']);
const PROJECT_ID=/^zp_[0-9a-f]{16}$/;
const NOTE='Antes de trabajar en este repositorio, pide zana_memory_context con este projectId a ZanaLLaima.';
// githubRepoId ties the pointer to its repo: a copy in another repo is never adopted.
export const pointerContent=(projectId,githubRepoId)=>({zanallaima:1,projectId,githubRepoId,note:NOTE});

// Red, fuera de toda transacción: id del repo y puntero de la rama base. Un
// puntero ilegible cuenta como ausente (se reescribe) y se informa en `invalid`.
export async function readPointer(github,repo,base){
  const info=await github.repo(repo);
  if(!Number.isSafeInteger(info?.id)||info.id<1)throw new Error('REPO_ID_UNAVAILABLE: GitHub did not return the id of '+repo);
  let pointer=null,invalid=null;
  try{
    pointer=await github.fileJson(repo,POINTER_PATH,base);
    if(pointer!==null&&(pointer?.zanallaima!==1||!PROJECT_ID.test(String(pointer.projectId)))){
      pointer=null;invalid=POINTER_PATH+' is not a ZanaLLaima pointer (zanallaima:1, projectId zp_ + 16 hex)';
    }
  }catch(error){
    if(!/INVALID_JSON_FILE/.test(String(error?.message)))throw error;
    invalid=error.message;
  }
  return {repoId:info.id,repo:typeof info.full_name==='string'?info.full_name:repo,pointer,invalid};
}

// Los seis casos del diseño (§6.3). Devuelve el proyecto y el estado del puntero.
export function resolveProject(db,{repoId,repo,pointer,invalid=null,missionId=null}){
  const byRepo=db.prepare('SELECT * FROM projects WHERE github_repo_id=?').get(repoId);
  const create=id=>{
    db.prepare('INSERT INTO projects(project_id,github_repo_id,repo,created_at,created_mission) VALUES(?,?,?,?,?)')
      .run(id,repoId,repo,nowIso(),missionId);
    return id;
  };
  const fresh=()=>byRepo?.project_id??create('zp_'+randomBytes(8).toString('hex'));
  let projectId,status;
  if(!pointer){projectId=fresh();status='POINTER_MISSING';}
  else{
    const row=db.prepare('SELECT * FROM projects WHERE project_id=?').get(pointer.projectId);
    // Copia o fork: el id es de otro repo; este repo usa (o recibe) el suyo.
    if(row&&row.github_repo_id!==repoId){projectId=fresh();status='POINTER_FOREIGN';}
    else if(row){projectId=row.project_id;status=pointer.githubRepoId===repoId?'OK':'POINTER_STALE';}
    else if(byRepo){projectId=byRepo.project_id;status='POINTER_STALE';}
    // DB restaurada u otro servidor: se adopta el id solo si el puntero es de este
    // mismo repo; un puntero copiado (o sin githubRepoId) recibe un id nuevo.
    else if(pointer.githubRepoId===repoId){projectId=create(pointer.projectId);status='OK';}
    else{projectId=fresh();status=Number.isSafeInteger(pointer.githubRepoId)?'POINTER_FOREIGN':'POINTER_STALE';}
  }
  db.prepare('UPDATE projects SET repo=? WHERE project_id=? AND repo!=?').run(repo,projectId,repo);
  return {projectId,pointer:{status,path:POINTER_PATH,content:pointerContent(projectId,repoId),...(invalid?{invalid}:{})}};
}

export const missionProject=(db,missionId)=>
  db.prepare('SELECT project_id FROM remote_missions WHERE mission_id=?').get(missionId)?.project_id??null;
export const setMissionProject=(db,missionId,projectId)=>
  db.prepare('UPDATE remote_missions SET project_id=? WHERE mission_id=?').run(projectId,missionId);

const view=r=>({seq:r.seq,kind:r.kind,topic:r.topic,body:r.body,missionId:r.mission_id,sha:r.sha,at:r.created_at});
// Bloque de contexto (§6.4): convenciones y decisiones vivas, pendientes sin
// resolver, issues vivos y los últimos 3 resúmenes, cortado a maxBytes.
export function memoryContext(db,projectId,{maxBytes=4096}={}){
  const live='SELECT * FROM project_memory WHERE project_id=? AND superseded_by IS NULL AND ';
  const rows=[
    ...db.prepare(live+"kind IN ('convention','decision') ORDER BY seq DESC LIMIT 200").all(projectId),
    ...db.prepare(live+"kind='pending' AND resolved_at IS NULL ORDER BY seq DESC LIMIT 200").all(projectId),
    ...db.prepare(live+"kind='issue' ORDER BY seq DESC LIMIT 200").all(projectId),
    ...db.prepare(live+"kind='summary' ORDER BY seq DESC LIMIT 3").all(projectId)];
  const entries=[];
  let used=Buffer.byteLength(JSON.stringify({projectId,entries:[],truncated:false})),truncated=false;
  for(const row of rows){
    const entry=view(row),size=Buffer.byteLength(JSON.stringify(entry))+1;
    // An entry that does not fit is skipped, not the rest: smaller ones may still fit.
    if(used+size>maxBytes){truncated=true;continue;}
    entries.push(entry);used+=size;
  }
  return {projectId,entries,truncated};
}

// Memory is durable, so it also drops common credential shapes that are not in
// the server's environment (OpenAI/Anthropic-style keys, AWS, Slack, PEM keys).
const CREDENTIALS=[/\bsk-[A-Za-z0-9_-]{20,}/g,/\bAKIA[0-9A-Z]{16}\b/g,/\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g];
const scrub=text=>CREDENTIALS.reduce((t,re)=>t.replace(re,'[redacted]'),text);

// Una entrada redactada; la viva anterior con el mismo (proyecto, kind, topic)
// queda superseded_by la nueva.
export function saveEntry(db,{projectId,kind,topic,body,missionId=null,sha=null,sessionId=null,secrets=[]}){
  if(!MEMORY_KINDS.includes(kind))throw new Error('INVALID_MEMORY_KIND: '+kind);
  const t=scrub(redactText(topic,secrets)).slice(0,80),b=scrub(redactText(body,secrets)).slice(0,1000);
  const old=db.prepare('SELECT seq FROM project_memory WHERE project_id=? AND kind=? AND topic=? AND superseded_by IS NULL').all(projectId,kind,t);
  const seq=Number(db.prepare('INSERT INTO project_memory(project_id,kind,topic,body,mission_id,sha,session_id,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(projectId,kind,t,b,missionId,sha,sessionId,nowIso()).lastInsertRowid);
  const supersede=db.prepare('UPDATE project_memory SET superseded_by=? WHERE seq=?');
  for(const {seq:prior} of old)supersede.run(seq,prior);
  return {seq,superseded:old.map(x=>x.seq)};
}

// El resumen obligatorio de zana_mission_close (§6.5), en la transacción del cierre.
export function saveSummary(db,{projectId,missionId,summary,sha=null,sessionId=null,secrets=[]}){
  const base={projectId,missionId,sha,sessionId,secrets};
  // The key files survive the 1000-char cap: done is shortened first.
  const files=summary.keyFiles.length?('\nArchivos clave: '+summary.keyFiles.join(', ')).slice(0,400):'';
  const saved=[saveEntry(db,{...base,kind:'summary',topic:missionId,body:summary.done.slice(0,1000-files.length)+files})];
  for(const [field,kind] of [['decisions','decision'],['conventions','convention'],['pending','pending']])
    for(const {topic,body} of summary[field])saved.push(saveEntry(db,{...base,kind,topic,body}));
  return {projectId,saved:saved.length,superseded:saved.reduce((n,s)=>n+s.superseded.length,0)};
}

// Búsqueda (§6.6): FTS5 MATCH por palabras (o LIKE si metadata fts='0'), en el
// proyecto o en todos (all); vivas primero y las supersedidas marcadas.
export function searchMemory(db,{query,projectId=null,limit=10}){
  const fts=db.prepare("SELECT value FROM metadata WHERE key='fts'").get()?.value!=='0';
  const words=String(query).match(/[\p{L}\p{N}_]+/gu)??[];
  const scope=projectId?' AND m.project_id=?':'',args=projectId?[projectId]:[];
  const order=' ORDER BY m.superseded_by IS NOT NULL,';
  let rows;
  if(fts&&words.length){
    rows=db.prepare('SELECT m.* FROM project_memory_fts JOIN project_memory m ON m.seq=project_memory_fts.rowid WHERE project_memory_fts MATCH ?'+
      scope+order+' bm25(project_memory_fts) LIMIT ?').all(words.map(w=>'"'+w+'"').join(' '),...args,limit);
  }else{
    const like='%'+String(query).replace(/[\\%_]/g,c=>'\\'+c)+'%';
    rows=db.prepare("SELECT m.* FROM project_memory m WHERE (m.topic LIKE ? ESCAPE '\\' OR m.body LIKE ? ESCAPE '\\')"+
      scope+order+' m.seq DESC LIMIT ?').all(like,like,...args,limit);
  }
  return {mode:fts&&words.length?'fts':'like',entries:rows.map(r=>({...view(r),projectId:r.project_id,
    ...(r.superseded_by?{superseded:true,supersededBy:r.superseded_by}:{}),...(r.resolved_at?{resolvedAt:r.resolved_at}:{})}))};
}
