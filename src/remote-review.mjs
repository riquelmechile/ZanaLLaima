// Review tickets: the author session asks for one, the user pastes it in a NEW
// conversation, that conversation's session claims it (and becomes read-only
// on the mission), submits the four lenses with evidence, and finalize
// publishes the review signed by the reviewer account on the exact SHA.
// Lens receipts reuse review_receipts (review_id = ticket id); the finalized
// consolidated review is archived in review_archive.
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {canonicalJson} from './actor-assertion.mjs';
import {missionPull} from './github-delivery.mjs';
import {recordActivity,sessionRow,sessionWrote,nowIso,writeAudit,missionClients,remoteMission} from './remote-state.mjs';
import {budgetOf} from './budget.mjs';
import {redactText,envSecrets} from './redact.mjs';
import {lineBudget,lineLimit} from './line-budget.mjs';

export const LENSES=Object.freeze(['risk','readability','reliability','resilience']);
export const SEVERITIES=Object.freeze(['BLOCKER','CRITICAL','WARNING','SUGGESTION']);
export const EXECUTIONS=Object.freeze(['PARALLEL_SUBAGENTS','SEQUENTIAL_SAME_CONVERSATION']);
const LOCATION=/^[^\s:][^:\n]{0,239}:\d{1,7}(?:-\d{1,7})?$/;
const CODE=/^ZR-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/;
const MAX_BODY=60_000;
export const DIFF_PAGE_BYTES=60_000;
const TERMINAL=['FINALIZED','STALE_SHA','EXPIRED','ABANDONED'];
const LIVE="state IN ('OPEN','CLAIMED','FINALIZING')";
const hash=s=>createHash('sha256').update(s).digest('hex');
const B32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function ticketCode(bytes=randomBytes(16)){
  const chars=[...bytes].map(b=>B32[b&31]).join('');
  return 'ZR-'+chars.slice(0,4)+'-'+chars.slice(4,8)+'-'+chars.slice(8,12)+'-'+chars.slice(12,16);
}
export class ReviewError extends Error{constructor(code,message){super(code+': '+message);this.code=code;}}
const fail=(code,message)=>{throw new ReviewError(code,message);};

export function validateLens(lens,findings,evidence){
  if(!LENSES.includes(lens))fail('INVALID_LENS','lens must be one of '+LENSES.join(', '));
  if(!Array.isArray(findings)||findings.length>50)fail('INVALID_FINDINGS','findings must be a list of at most 50');
  findings.forEach((f,i)=>{
    if(!f||typeof f!=='object')fail('INVALID_FINDING','finding '+i+' is not an object');
    if(!SEVERITIES.includes(f.severity))fail('MISSING_SEVERITY','finding '+i+' needs severity '+SEVERITIES.join('|'));
    if(typeof f.location!=='string'||!LOCATION.test(f.location))fail('MISSING_LOCATION','finding '+i+' needs location file:line');
    if(typeof f.evidence!=='string'||!f.evidence.trim()||f.evidence.length>4000)fail('MISSING_EVIDENCE','finding '+i+' needs concrete evidence');
    if(f.title!==undefined&&(typeof f.title!=='string'||f.title.length>300))fail('INVALID_FINDING','finding '+i+' title too long');
  });
  if(!Array.isArray(evidence)||!evidence.length||evidence.length>20||
     evidence.some(e=>typeof e!=='string'||!e.trim()||e.length>2000))
    fail('MISSING_EVIDENCE','lens evidence must list 1-20 concrete items');
}
// Split a unified diff into pages: per file, then by lines up to
// DIFF_PAGE_BYTES. Each page has a SHA-256 so a re-fetch can be checked.
export function diffPages(text,pageBytes=DIFF_PAGE_BYTES){
  const files=String(text).split(/(?=^diff --git )/m).filter(x=>x.length);
  if(!files.length)files.push('');
  const pages=[];
  for(const chunk of files){
    const m=/^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    const path=m?m[2]:'(sin archivo)';
    const parts=[];let current='';
    for(const line of chunk.split(/(?<=\n)/)){
      for(let piece=line;piece.length;){
        const room=pageBytes-Buffer.byteLength(current);
        if(Buffer.byteLength(piece)<=room){current+=piece;piece='';}
        else if(current){parts.push(current);current='';}
        else{parts.push(piece.slice(0,pageBytes));piece=piece.slice(pageBytes);}
      }
    }
    if(current||!parts.length)parts.push(current);
    parts.forEach((text,i)=>pages.push({page:pages.length,path,part:i+1,parts:parts.length,text,sha256:hash(text)}));
  }
  return pages;
}
export function diffManifest(pages){
  const files=[];
  for(const p of pages){
    let f=files.find(x=>x.path===p.path);
    if(!f){f={path:p.path,pages:[]};files.push(f);}
    f.pages.push(p.page);
  }
  return {totalPages:pages.length,pageBytes:DIFF_PAGE_BYTES,files};
}
const blocking=findings=>findings.some(f=>f.severity==='BLOCKER'||f.severity==='CRITICAL');

export function reviewBody({code,ticket,lenses,execution,event}){
  const count=(l,s)=>l.findings.filter(f=>f.severity===s).length;
  const lines=['## ZanaLLaima 4R','','<!-- zana-ticket:'+ticket.ticket_id+' -->',
    'Ticket `'+code+'` · PR #'+ticket.pr_number+' · SHA `'+ticket.sha+'`',
    'Ejecución declarada por el anfitrión: '+(execution==='PARALLEL_SUBAGENTS'?
      '4 subagentes en paralelo con contexto fresco':'4 lentes en secuencia en la misma conversación revisora'),
    '','| Lente | BLOCKER | CRITICAL | WARNING | SUGGESTION | hash |','| --- | --- | --- | --- | --- | --- |',
    ...lenses.map(l=>'| '+l.lens+' | '+SEVERITIES.map(s=>count(l,s)).join(' | ')+' | `'+l.hash.slice(0,16)+'` |'),''];
  for(const l of lenses){
    lines.push('### '+l.lens);
    if(!l.findings.length)lines.push('Sin hallazgos. Evidencia: '+l.evidence.join('; '));
    for(const f of l.findings)lines.push('- **'+f.severity+'** `'+f.location+'`'+(f.title?' — '+f.title:'')+'. Evidencia: '+f.evidence);
    lines.push('');
  }
  lines.push('Veredicto: **'+event+'**.','',
    'Prueba: sesión revisora distinta de la autora, sin escrituras en la misión, creada después del ticket, sobre este SHA exacto con CI verde y 4 lentes con evidencia. No prueba el modelo ni el contexto fresco de los subagentes (palabra del anfitrión).');
  const body=redactText(lines.join('\n'),envSecrets());
  return body.length>MAX_BODY?body.slice(0,MAX_BODY-40)+'\n\n[cuerpo recortado por tamaño]':body;
}

// Per-key FIFO lock inside one process. The map holds the tail of each key's
// chain; the last holder of a key deletes it, so idle keys never accumulate.
export function makeExclusive(){
  const locks=new Map();
  async function exclusive(key,fn){
    const before=locks.get(key)??Promise.resolve();
    let release;
    const mine=new Promise(r=>{release=r;});
    const chained=before.then(()=>mine);
    locks.set(key,chained);
    await before;
    try{return await fn();}
    finally{release();if(locks.get(key)===chained)locks.delete(key);}
  }
  return {exclusive,pending:()=>locks.size};
}
export const latestIn=(db,missionId)=>db?.prepare('SELECT * FROM review_tickets WHERE mission_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(missionId)??null;
export function createReview({github,reviewerGithub,config,checks,remoteWrite,remoteRead,transact,missionContext}){
  const {exclusive}=makeExclusive();
  const pageCache=new Map();
  const ticketBy=(db,code)=>{
    if(typeof code!=='string'||!CODE.test(code))fail('TICKET_NOT_FOUND','unknown ticket');
    const row=db.prepare('SELECT * FROM review_tickets WHERE code_hash=?').get(hash(code));
    if(!row)fail('TICKET_NOT_FOUND','unknown ticket');
    return row;
  };
  const lensRows=(db,ticketId)=>db.prepare('SELECT lens_id,token,result FROM review_receipts WHERE review_id=?')
    .all(ticketId).map(r=>({lens:r.lens_id,hash:r.token,...JSON.parse(r.result)}));
  const hasBlocking=(db,ticketId)=>lensRows(db,ticketId).some(l=>blocking(l.findings));
  const sameShaBlocker=(db,missionId,sha)=>db.prepare('SELECT * FROM review_tickets WHERE mission_id=? AND sha=? AND operator_released=0')
    .all(missionId,sha).find(t=>t.verdict==='REQUEST_CHANGES'||hasBlocking(db,t.ticket_id))?.ticket_id??null;
  // Lazy expiry: OPEN past its deadline -> EXPIRED; CLAIMED/FINALIZING older
  // than the claim TTL -> ABANDONED (terminal, never blocks a merge).
  function expire(db,now=Date.now()){
    const at=nowIso();
    db.prepare("UPDATE review_tickets SET state='EXPIRED',updated_at=? WHERE state='OPEN' AND expires_at<=?")
      .run(at,new Date(now).toISOString());
    db.prepare("UPDATE review_tickets SET state='ABANDONED',updated_at=? WHERE state IN ('CLAIMED','FINALIZING') AND claimed_at<=?")
      .run(at,new Date(now-config.claimTtlMinutes*60_000).toISOString());
  }
  const missionLock=id=>'mission:'+id;
  // The authoritative publication check: still FINALIZING by this reviewer and
  // the current (latest, not superseded) ticket of its mission.
  const current=(db,t,session)=>{
    const row=db.prepare('SELECT * FROM review_tickets WHERE ticket_id=?').get(t.ticket_id);
    const latest=latestIn(db,t.mission_id);
    return row?.state==='FINALIZING'&&row.reviewer_session===session.sessionId&&latest?.ticket_id===row.ticket_id?row:null;
  };
  const superseded=(code,t,state)=>({ticket:code,state,published:false,ticketSha:t.sha,
    note:'This ticket was superseded or abandoned while finalizing; nothing was published. Ask the author for the current ticket.'});
  // Cache by repo:base:sha, so request() (which measures the diff before the
  // ticket exists) warms what claim() and diff() read.
  async function fetchPages(repo,base,sha){
    let diff;
    try{diff=await github.compareDiff(repo,base,sha);}
    catch(error){
      if(/response too large/.test(String(error?.message)))
        fail('DIFF_TOO_LARGE','el diff pesa más de 2000000 bytes y el tope es '+config.reviewMaxDiffBytes+'; divide el cambio en misiones secuenciales');
      throw error;
    }
    const entry={key:repo+':'+base+':'+sha,pages:diffPages(diff),bytes:Buffer.byteLength(diff,'utf8')};
    pageCache.set(entry.key,entry);
    if(pageCache.size>50)pageCache.delete(pageCache.keys().next().value);
    return entry;
  }
  async function loadPages(t){
    const ctx=await missionContext(t.mission_id,null,{allowInactive:true});
    return pageCache.get(t.repo+':'+ctx.base+':'+t.sha)??fetchPages(t.repo,ctx.base,t.sha);
  }
  // Record the manifest once; a later fetch must produce the same pages.
  async function ensureManifest(t){
    const entry=await loadPages(t),pages=entry.pages;
    return remoteWrite(db=>{
      const stored=db.prepare('SELECT page,sha256 FROM review_diff_pages WHERE ticket_id=? ORDER BY page').all(t.ticket_id);
      if(!stored.length){
        const put=db.prepare('INSERT INTO review_diff_pages(ticket_id,page,path,sha256,read_at) VALUES(?,?,?,?,NULL)');
        for(const p of pages)put.run(t.ticket_id,p.page,p.path,p.sha256);
      }else if(stored.length!==pages.length||stored.some((r,i)=>r.sha256!==pages[i].sha256)){
        pageCache.delete(entry.key);
        fail('DIFF_CHANGED','the diff of '+t.sha+' no longer matches the recorded manifest');
      }
      return entry;
    });
  }
  return {
    expire:()=>remoteWrite(db=>expire(db)),
    async request(missionId,session){
      const ctx=await missionContext(missionId,session.sessionId,{write:true});
      const pull=await missionPull(github,ctx);
      if(!pull||pull.state!=='open')fail('NO_PULL_REQUEST','open a pull request from '+ctx.branch+' to '+ctx.base+' first');
      const sha=String(pull.head?.sha??'');
      const verdict=await checks.verdict(ctx.repo,sha);
      if(verdict.state!=='SUCCESS')fail('CHECKS_NOT_GREEN','checks on '+sha+' are '+verdict.state);
      // Size limits before the ticket: the diff cap has no exception; the line
      // budget can only be raised with zana_budget_extend (user's yes).
      const diffBytes=(await fetchPages(ctx.repo,ctx.base,sha)).bytes;
      if(diffBytes>config.reviewMaxDiffBytes)
        fail('DIFF_TOO_LARGE','el diff pesa '+diffBytes+' bytes y el tope es '+config.reviewMaxDiffBytes+'; divide el cambio en misiones secuenciales');
      const budget=lineBudget(await github.pullFiles(ctx.repo,pull.number),{limit:lineLimit(ctx,config)});
      if(budget.over)fail('OVER_LINE_BUDGET','el PR cambia '+(budget.truncated?'más de ':'')+budget.lines+' líneas (sin lockfiles) y el presupuesto es '+budget.limit+
        '; pregúntale al usuario si autoriza '+budget.lines+' líneas y, solo con su sí, llama zana_budget_extend');
      const code=ticketCode(),ticketId=randomUUID();
      let expiresAt;
      let superseded=[];
      // Superseding tickets and publishing a review are serialized per mission,
      // so a finalize never publishes for a ticket replaced meanwhile.
      await exclusive(missionLock(missionId),()=>transact((mission,txc)=>{
        const db=txc.db;
        if(!mission||mission.id!==missionId)fail('MISSION_NOT_ACTIVE','mission '+missionId+' is not the active mission');
        // W3 order: the code unit is completed (green checks on the head) before the ticket.
        const codeUnits=remoteMission(db,missionId).codeUnits;
        const running=mission.units.filter(u=>codeUnits.includes(u.id)&&u.status==='RUNNING').map(u=>u.id);
        if(running.length)fail('UNIT_STILL_RUNNING','complete '+running.join(', ')+' with zana_complete_unit (green checks on the head) before asking for a ticket; if its lease expired: zana_recover_expired → zana_unit_retry → zana_start_batch');
        expire(db);
        // Timestamps once the mission lock is held: tickets are ordered by creation.
        const at=Date.now();
        expiresAt=new Date(at+config.ticketTtlMinutes*60_000).toISOString();
        // Same SHA with requested changes (a REQUEST_CHANGES verdict or a
        // BLOCKER/CRITICAL lens, in ANY state: abandoned, expired, stale or
        // finalized): the code must change before another review. Waiting for
        // a TTL never releases it; only an explicit operator abandon does.
        const blocker=sameShaBlocker(db,missionId,sha);
        if(blocker)fail('CHANGES_REQUESTED_SAME_SHA','a review requested changes on '+sha+' (ticket '+blocker+'); push a change before asking for a new ticket');
        const cap=budgetOf(mission).maxReviewRounds;
        if((mission.reviewCount||0)>=cap)fail('REVIEW_ROUNDS_EXHAUSTED','mission used its '+cap+' review rounds');
        // One live ticket per mission: older ones become STALE_SHA (other SHA) or ABANDONED (same SHA).
        superseded=db.prepare('SELECT ticket_id,sha FROM review_tickets WHERE mission_id=? AND '+LIVE).all(missionId);
        for(const old of superseded)
          db.prepare('UPDATE review_tickets SET state=?,updated_at=? WHERE ticket_id=?')
            .run(old.sha===sha?'ABANDONED':'STALE_SHA',nowIso(),old.ticket_id);
        recordActivity(db,{sessionId:session.sessionId,clientId:session.clientId,missionId,kind:'REVIEW_REQUEST',tool:'zana_review_request'});
        db.prepare('INSERT INTO review_tickets(ticket_id,code_hash,mission_id,repo,pr_number,sha,author_session,author_client,created_at,expires_at,state,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(ticketId,hash(code),missionId,ctx.repo,pull.number,sha,session.sessionId,session.clientId??null,
            new Date(at).toISOString(),expiresAt,'OPEN',nowIso());
        mission.reviewCount=(mission.reviewCount||0)+1;
        mission.revision++;
        return mission;
      }));
      return {ticket:code,missionId,repo:ctx.repo,pullNumber:pull.number,sha,expiresAt,lineBudget:budget,diffBytes,
        superseded:superseded.map(x=>x.ticket_id),
        message:'Revisa el ticket '+code+' con ZanaLLaima',
        instructions:'Entrega este mensaje exacto al usuario para que lo pegue en una conversación NUEVA. Esta sesión no puede reclamarlo.'};
    },
    async claim(code,session){
      const claimed=await remoteWrite(db=>{
        expire(db);
        const t=ticketBy(db,code);
        if(t.state==='EXPIRED')return {error:['TICKET_EXPIRED','ticket expired']};
        if(t.state!=='OPEN')return {error:['TICKET_ALREADY_CLAIMED','ticket already used ('+t.state+')']};
        if(t.author_session===session.sessionId)return {error:['AUTHOR_SESSION','the author session cannot claim its own ticket']};
        // The reviewer's OAuth client must differ from the requester's and from
        // every client that acted on the mission (creator, unit holders, writers).
        if(config.distinctReviewerClient&&(t.author_client===session.clientId||missionClients(db,t.mission_id).includes(session.clientId)))
          return {error:['SAME_CLIENT','ZANA_DISTINCT_REVIEWER_CLIENT requires another registered OAuth client than any client that acted on the mission']};
        if(sessionWrote(db,session.sessionId,t.mission_id))
          return {error:['SESSION_WROTE','this session wrote in mission '+t.mission_id]};
        const me=sessionRow(db,session.sessionId);
        if(!me)return {error:['SESSION_UNKNOWN','session not registered']};
        if(Date.parse(me.created_at)<=Date.parse(t.created_at))
          return {error:['SESSION_PREDATES_TICKET','this session was created before the ticket; open a new conversation']};
        db.prepare("UPDATE review_tickets SET state='CLAIMED',reviewer_session=?,claimed_at=?,updated_at=? WHERE ticket_id=?")
          .run(session.sessionId,nowIso(),nowIso(),t.ticket_id);
        return {ticket:t};
      });
      if(claimed.error)fail(...claimed.error);
      const t=claimed.ticket;
      const ctx=await missionContext(t.mission_id,null,{allowInactive:true});
      let manifest=null,manifestError=null,diffBytes=null,budget=null;
      try{const entry=await ensureManifest(t);manifest=diffManifest(entry.pages);diffBytes=entry.bytes;}
      catch(error){manifestError=String(error?.message??error).slice(0,300);}
      try{budget=lineBudget(await github.pullFiles(t.repo,t.pr_number),{limit:lineLimit(ctx,config)});}catch{budget=null;}
      const verdict=await checks.verdict(t.repo,t.sha);
      return {ticket:code,state:'CLAIMED',missionId:t.mission_id,repo:t.repo,pullNumber:t.pr_number,sha:t.sha,
        spec:{objective:ctx.objective,units:ctx.units},diffManifest:manifest,diffBytes,lineBudget:budget,
        ...(manifestError?{diffManifestError:manifestError+'; zana_review_diff retries'}:{}),checks:verdict,
        lenses:LENSES,skills:['review-discipline',...LENSES.map(l=>'review-'+l)],
        instructions:'Load zana-4r. Read EVERY diff page with zana_review_diff (finalize refuses otherwise). One lens per fresh subagent with only spec, diff and checks; this conversation submits each lens once, then finalizes once.'};
    },
    async diff({ticket:code,page},session){
      if(!Number.isSafeInteger(page)||page<0)fail('INVALID_PAGE','page must be an integer >= 0');
      const t=await remoteWrite(db=>{expire(db);return ticketBy(db,code);});
      if(t.state!=='CLAIMED')fail('TICKET_NOT_CLAIMED','ticket is '+t.state);
      if(t.reviewer_session!==session.sessionId)fail('NOT_REVIEWER','only the session that claimed the ticket may read its diff');
      const {pages}=await ensureManifest(t);
      if(page>=pages.length)fail('INVALID_PAGE','page '+page+' does not exist (total '+pages.length+')');
      const remaining=await remoteWrite(db=>{
        db.prepare('UPDATE review_diff_pages SET read_at=COALESCE(read_at,?) WHERE ticket_id=? AND page=?').run(nowIso(),t.ticket_id,page);
        return db.prepare('SELECT page FROM review_diff_pages WHERE ticket_id=? AND read_at IS NULL ORDER BY page').all(t.ticket_id).map(r=>r.page);
      });
      const p=pages[page];
      return {ticket:code,page,path:p.path,part:p.part,parts:p.parts,sha256:p.sha256,text:p.text,
        unread:remaining,manifest:diffManifest(pages)};
    },
    async lensSubmit({ticket:code,lens,findings,evidence},session){
      validateLens(lens,findings,evidence);
      return remoteWrite(db=>{
        expire(db);
        const t=ticketBy(db,code);
        if(t.state!=='CLAIMED')fail('TICKET_NOT_CLAIMED','ticket is '+t.state);
        if(t.reviewer_session!==session.sessionId)fail('NOT_REVIEWER','only the session that claimed the ticket may submit lenses');
        if(db.prepare('SELECT 1 FROM review_receipts WHERE review_id=? AND lens_id=?').get(t.ticket_id,lens))
          fail('LENS_ALREADY_SUBMITTED','lens '+lens+' was already submitted');
        const clean=findings.map(f=>({severity:f.severity,location:f.location,evidence:f.evidence,...(f.title?{title:f.title}:{})}));
        const lensHash=hash(canonicalJson({ticket:t.ticket_id,sha:t.sha,lens,findings:clean,evidence}));
        db.prepare('INSERT INTO review_receipts(review_id,lens_id,token,result,created_at) VALUES(?,?,?,?,?)')
          .run(t.ticket_id,lens,lensHash,JSON.stringify({findings:clean,evidence,submittedAt:nowIso()}),nowIso());
        const done=db.prepare('SELECT lens_id FROM review_receipts WHERE review_id=?').all(t.ticket_id).map(r=>r.lens_id);
        return {ticket:code,lens,hash:lensHash,blocking:blocking(clean),submitted:done,
          remaining:LENSES.filter(l=>!done.includes(l))};
      });
    },
    async finalize({ticket:code,execution},session){
      if(!EXECUTIONS.includes(execution))fail('INVALID_EXECUTION','execution must be '+EXECUTIONS.join(' or '));
      if(!reviewerGithub.configured)fail('REVIEWER_TOKEN_MISSING','ZANA_REVIEWER_TOKEN is not set on the server');
      if(!config.reviewerLogin)fail('REVIEWER_LOGIN_MISSING','ZANA_REVIEWER_LOGIN is not set on the server');
      const mid=await remoteWrite(db=>ticketBy(db,code).mission_id);
      return exclusive(missionLock(mid),async()=>{
        const {t,lenses,unread}=await remoteWrite(db=>{
          expire(db);
          const row=ticketBy(db,code);
          const pages=db.prepare('SELECT page,read_at FROM review_diff_pages WHERE ticket_id=?').all(row.ticket_id);
          return {t:row,lenses:lensRows(db,row.ticket_id),
            unread:pages.length?pages.filter(p=>!p.read_at).map(p=>p.page):null};
        });
        if(t.state==='FINALIZED')return {ticket:code,state:'FINALIZED',verdict:t.verdict,githubReviewId:t.github_review_id,published:true};
        if(!['CLAIMED','FINALIZING'].includes(t.state))fail('TICKET_NOT_CLAIMED','ticket is '+t.state);
        if(t.reviewer_session!==session.sessionId)fail('NOT_REVIEWER','only the session that claimed the ticket may finalize');
        const missing=LENSES.filter(l=>!lenses.some(x=>x.lens===l));
        if(missing.length)fail('LENSES_INCOMPLETE','missing lenses: '+missing.join(', '));
        if(unread===null)fail('DIFF_NOT_FULLY_READ','no diff manifest recorded; read the diff with zana_review_diff');
        if(unread.length)fail('DIFF_NOT_FULLY_READ','unread diff pages: '+unread.join(', '));
        const pull=await github.pull(t.repo,t.pr_number);
        const head=String(pull?.head?.sha??'');
        if(head!==t.sha&&t.github_review_id===null){
          await remoteWrite(db=>db.prepare("UPDATE review_tickets SET state='STALE_SHA',updated_at=? WHERE ticket_id=?").run(nowIso(),t.ticket_id));
          return {ticket:code,state:'STALE_SHA',published:false,ticketSha:t.sha,headSha:head,
            note:'The pull request head changed; nothing was published. Ask the author for a new ticket.'};
        }
        const verdict=await checks.verdict(t.repo,t.sha);
        if(verdict.state!=='SUCCESS')fail('CHECKS_NOT_GREEN','checks on '+t.sha+' are '+verdict.state+'; nothing was published');
        const ordered=LENSES.map(l=>lenses.find(x=>x.lens===l));
        const event=ordered.some(l=>blocking(l.findings))?'REQUEST_CHANGES':'APPROVE';
        const moved=await remoteWrite(db=>{
          expire(db);
          if(latestIn(db,t.mission_id)?.ticket_id!==t.ticket_id)return 0;
          return db.prepare("UPDATE review_tickets SET state='FINALIZING',execution=?,verdict=?,updated_at=? WHERE ticket_id=? AND state IN ('CLAIMED','FINALIZING') AND reviewer_session=?")
            .run(execution,event,nowIso(),t.ticket_id,session.sessionId).changes;
        });
        if(!moved)return superseded(code,t,(await remoteRead(db=>db.prepare('SELECT state FROM review_tickets WHERE ticket_id=?').get(t.ticket_id)))?.state??'UNKNOWN');
        // Something outside this process (TTL expiry, operator) may still
        // change the ticket while GitHub answers: revalidate right before each
        // publication, and make every later state change conditional.
        const stillCurrent=()=>remoteWrite(db=>{expire(db);return current(db,t,session);});
        const inconsistent=async what=>{
          const now=await remoteRead(db=>db.prepare('SELECT state,github_review_id FROM review_tickets WHERE ticket_id=?').get(t.ticket_id));
          await remoteWrite(db=>writeAudit(db,{caller:{host:'zana-review',sessionId:session.sessionId},tool:'zana_review_finalize',
            missionId:t.mission_id,outcome:'INCONSISTENT',args:{ticketId:t.ticket_id},
            detail:{published:what,state:now?.state??null,githubReviewId:now?.github_review_id??null,sha:t.sha},category:'review'}));
          return {...superseded(code,t,now?.state??'UNKNOWN'),published:what.includes('review'),inconsistent:true,
            note:'The ticket stopped being current while GitHub published its review; it was recorded as an inconsistency and does not count for the merge.'};
        };
        let reviewId=t.github_review_id,reviewUrl=null,adopted=false;
        if(reviewId===null){
          // A lost response must not publish twice: adopt our own review of this commit with this ticket's marker.
          const marker='<!-- zana-ticket:'+t.ticket_id+' -->';
          const existing=(await reviewerGithub.pullReviews(t.repo,t.pr_number)).find(r=>
            config.reviewerLogin&&String(r?.user?.login??'').toLowerCase()===config.reviewerLogin.toLowerCase()&&
            r?.commit_id===t.sha&&String(r?.body??'').includes(marker));
          if(existing){reviewId=Number(existing.id);reviewUrl=existing.html_url??null;adopted=true;}
          else{
            if(!await stillCurrent())return superseded(code,t,(await remoteRead(db=>db.prepare('SELECT state FROM review_tickets WHERE ticket_id=?').get(t.ticket_id)))?.state??'UNKNOWN');
            const review=await reviewerGithub.createReview(t.repo,t.pr_number,{commitId:t.sha,event,
              body:reviewBody({code,ticket:t,lenses:ordered,execution,event})});
            reviewId=Number(review?.id);reviewUrl=review?.html_url??null;
          }
          // The review id is a fact even if the ticket stopped being current.
          await remoteWrite(db=>db.prepare('UPDATE review_tickets SET github_review_id=?,updated_at=? WHERE ticket_id=?')
            .run(reviewId,nowIso(),t.ticket_id));
        }
        const statusState=event==='APPROVE'?'success':'failure';
        if(!await stillCurrent())return inconsistent(['review']);
        if(!t.status_posted){
          await reviewerGithub.createStatus(t.repo,t.sha,{state:statusState,
            description:'ZanaLLaima 4R '+event+' (ticket '+code.slice(0,7)+'…)'});
        }
        const archived={ticket:code,ticketId:t.ticket_id,missionId:t.mission_id,repo:t.repo,pullNumber:t.pr_number,
          sha:t.sha,event,execution,githubReviewId:reviewId,lenses:ordered.map(l=>({lens:l.lens,hash:l.hash,
            findings:l.findings,evidence:l.evidence})),finalizedAt:nowIso(),authorSession:t.author_session,
          reviewerSession:t.reviewer_session};
        const done=await remoteWrite(db=>{
          const changed=db.prepare("UPDATE review_tickets SET state='FINALIZED',status_posted=1,finalized_at=?,updated_at=? WHERE ticket_id=? AND state='FINALIZING' AND reviewer_session=?")
            .run(nowIso(),nowIso(),t.ticket_id,session.sessionId).changes;
          if(changed)db.prepare('INSERT OR IGNORE INTO review_archive(mission_id,review_id,content,created_at) VALUES(?,?,?,?)')
            .run(t.mission_id,t.ticket_id,JSON.stringify(archived),nowIso());
          return changed;
        });
        if(!done)return inconsistent(['review','zana/4r']);
        return {ticket:code,state:'FINALIZED',published:true,event,githubReviewId:reviewId,reviewUrl,adoptedExistingReview:adopted,
          status:{context:'zana/4r',state:statusState},sha:t.sha,lensHashes:Object.fromEntries(ordered.map(l=>[l.lens,l.hash]))};
      });
    },
    // Live tickets (after expiry) whose submitted lenses carry BLOCKER or CRITICAL.
    async openBlocking(missionId){
      return remoteWrite(db=>{
        expire(db);
        const rows=db.prepare('SELECT ticket_id FROM review_tickets WHERE mission_id=? AND '+LIVE).all(missionId);
        return rows.filter(r=>hasBlocking(db,r.ticket_id)).map(r=>r.ticket_id);
      });
    },
    // Latest ticket of the mission (for zana_correction_start). latestIn()
    // reads it inside the caller's transaction.
    latest:missionId=>remoteRead(db=>latestIn(db,missionId)),
    // zana_merge runs under the same per-mission lock as request/finalize.
    withMissionLock:(missionId,fn)=>exclusive(missionLock(missionId),fn),
    latestIn,
    // Operator: list tickets and abandon one by id (audited by the caller).
    async list(missionId=null){
      return remoteWrite(db=>{
        expire(db);
        const rows=missionId?db.prepare('SELECT * FROM review_tickets WHERE mission_id=? ORDER BY created_at DESC').all(missionId)
          :db.prepare('SELECT * FROM review_tickets ORDER BY created_at DESC LIMIT 200').all();
        return rows.map(r=>({ticketId:r.ticket_id,missionId:r.mission_id,pullNumber:r.pr_number,sha:r.sha,state:r.state,
          verdict:r.verdict,createdAt:r.created_at,claimedAt:r.claimed_at,blocking:hasBlocking(db,r.ticket_id),
          releasedByOperator:Boolean(r.operator_released)}));
      });
    },
    async abandon(ticketId,caller){
      return remoteWrite(db=>{
        const t=db.prepare('SELECT * FROM review_tickets WHERE ticket_id=?').get(ticketId);
        if(!t)fail('TICKET_NOT_FOUND','unknown ticket id '+ticketId);
        // A finalized review stays; any other ticket is abandoned AND released,
        // so its blockers no longer stop a new review of the same SHA.
        if(t.state==='FINALIZED')fail('TICKET_TERMINAL','a finalized review cannot be abandoned');
        if(t.operator_released)fail('TICKET_TERMINAL','ticket was already released by the operator');
        // A review already on GitHub is a fact: abandoning would hide it.
        if(t.github_review_id!==null)fail('TICKET_TERMINAL','ticket already published GitHub review '+t.github_review_id);
        db.prepare("UPDATE review_tickets SET state='ABANDONED',operator_released=1,updated_at=? WHERE ticket_id=?").run(nowIso(),ticketId);
        writeAudit(db,{caller,tool:'remote-ticket-abandon',missionId:t.mission_id,outcome:'ABANDONED',
          args:{ticketId},detail:{previousState:t.state,sha:t.sha,released:true},category:'operator'});
        return {ticketId,previousState:t.state,state:'ABANDONED',released:true};
      });
    },
  };
}
