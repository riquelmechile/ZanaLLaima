// Review tickets: the author session asks for one, the user pastes it in a NEW
// conversation, that conversation's session claims it (and becomes read-only
// on the mission), submits the four lenses with evidence, and finalize
// publishes the review signed by the reviewer account on the exact SHA.
// Lens receipts reuse review_receipts (review_id = ticket id); the finalized
// consolidated review is archived in review_archive.
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {canonicalJson} from './actor-assertion.mjs';
import {missionPull} from './github-delivery.mjs';
import {recordActivity,sessionRow,sessionWrote,nowIso} from './remote-state.mjs';
import {redactText,envSecrets} from './redact.mjs';

export const LENSES=Object.freeze(['risk','readability','reliability','resilience']);
export const SEVERITIES=Object.freeze(['BLOCKER','CRITICAL','WARNING','SUGGESTION']);
export const EXECUTIONS=Object.freeze(['PARALLEL_SUBAGENTS','SEQUENTIAL_SAME_CONVERSATION']);
const LOCATION=/^[^\s:][^:\n]{0,239}:\d{1,7}(?:-\d{1,7})?$/;
const CODE=/^ZR-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/;
const MAX_DIFF=150_000,MAX_BODY=60_000;
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
const blocking=findings=>findings.some(f=>f.severity==='BLOCKER'||f.severity==='CRITICAL');

export function reviewBody({code,ticket,lenses,execution,event}){
  const count=(l,s)=>l.findings.filter(f=>f.severity===s).length;
  const lines=['## ZanaLLaima 4R','',
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

export function createReview({github,reviewerGithub,config,checks,remoteWrite,remoteRead,missionContext}){
  const locks=new Map();
  const ticketBy=(db,code)=>{
    if(typeof code!=='string'||!CODE.test(code))fail('TICKET_NOT_FOUND','unknown ticket');
    const row=db.prepare('SELECT * FROM review_tickets WHERE code_hash=?').get(hash(code));
    if(!row)fail('TICKET_NOT_FOUND','unknown ticket');
    return row;
  };
  const lensRows=(db,ticketId)=>db.prepare('SELECT lens_id,token,result FROM review_receipts WHERE review_id=?')
    .all(ticketId).map(r=>({lens:r.lens_id,hash:r.token,...JSON.parse(r.result)}));
  async function exclusive(key,fn){
    const before=locks.get(key)??Promise.resolve();
    let release;
    const mine=new Promise(r=>{release=r;});
    locks.set(key,before.then(()=>mine));
    await before;
    try{return await fn();}finally{release();if(locks.get(key)===mine)locks.delete(key);}
  }
  return {
    async request(missionId,session){
      const ctx=await missionContext(missionId,session.sessionId,{write:true});
      const pull=await missionPull(github,ctx);
      if(!pull||pull.state!=='open')fail('NO_PULL_REQUEST','open a pull request from '+ctx.branch+' to '+ctx.base+' first');
      const sha=String(pull.head?.sha??'');
      const verdict=await checks.verdict(ctx.repo,sha);
      if(verdict.state!=='SUCCESS')fail('CHECKS_NOT_GREEN','checks on '+sha+' are '+verdict.state);
      const code=ticketCode(),at=Date.now();
      const expiresAt=new Date(at+config.ticketTtlMinutes*60_000).toISOString();
      const ticketId=randomUUID();
      await remoteWrite(db=>{
        recordActivity(db,{sessionId:session.sessionId,missionId,kind:'REVIEW_REQUEST',tool:'zana_review_request'});
        db.prepare('INSERT INTO review_tickets(ticket_id,code_hash,mission_id,repo,pr_number,sha,author_session,created_at,expires_at,state,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(ticketId,hash(code),missionId,ctx.repo,pull.number,sha,session.sessionId,new Date(at).toISOString(),expiresAt,'OPEN',nowIso());
      });
      return {ticket:code,missionId,repo:ctx.repo,pullNumber:pull.number,sha,expiresAt,
        message:'Revisa el ticket '+code+' con ZanaLLaima',
        instructions:'Entrega este mensaje exacto al usuario para que lo pegue en una conversación NUEVA. Esta sesión no puede reclamarlo.'};
    },
    async claim(code,session){
      const claimed=await remoteWrite(db=>{
        const t=ticketBy(db,code);
        if(t.state==='OPEN'&&Date.parse(t.expires_at)<=Date.now()){
          db.prepare("UPDATE review_tickets SET state='EXPIRED',updated_at=? WHERE ticket_id=?").run(nowIso(),t.ticket_id);
          return {error:['TICKET_EXPIRED','ticket expired at '+t.expires_at]};
        }
        if(t.state==='EXPIRED')return {error:['TICKET_EXPIRED','ticket expired']};
        if(t.state!=='OPEN')return {error:['TICKET_ALREADY_CLAIMED','ticket already used ('+t.state+')']};
        if(t.author_session===session.sessionId)return {error:['AUTHOR_SESSION','the author session cannot claim its own ticket']};
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
      let diff='',truncated=false;
      try{diff=await github.pullDiff(t.repo,t.pr_number);}catch(error){diff='(diff unavailable: '+error.message+')';}
      if(diff.length>MAX_DIFF){diff=diff.slice(0,MAX_DIFF);truncated=true;}
      const verdict=await checks.verdict(t.repo,t.sha);
      return {ticket:code,state:'CLAIMED',missionId:t.mission_id,repo:t.repo,pullNumber:t.pr_number,sha:t.sha,
        spec:{objective:ctx.objective,units:ctx.units},diff,diffTruncated:truncated,checks:verdict,
        lenses:LENSES,skills:['review-discipline',...LENSES.map(l=>'review-'+l)],
        instructions:'Load zana-4r. One lens per fresh subagent with only spec, diff and checks; submit each lens once, then finalize once.'};
    },
    async lensSubmit({ticket:code,lens,findings,evidence},session){
      validateLens(lens,findings,evidence);
      return remoteWrite(db=>{
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
      return exclusive(code,async()=>{
        const {t,lenses}=await remoteRead(db=>{
          const row=ticketBy(db,code);
          return {t:row,lenses:lensRows(db,row.ticket_id)};
        });
        if(t.state==='FINALIZED')return {ticket:code,state:'FINALIZED',verdict:t.verdict,githubReviewId:t.github_review_id,published:true};
        if(!['CLAIMED','FINALIZING'].includes(t.state))fail('TICKET_NOT_CLAIMED','ticket is '+t.state);
        if(t.reviewer_session!==session.sessionId)fail('NOT_REVIEWER','only the session that claimed the ticket may finalize');
        const missing=LENSES.filter(l=>!lenses.some(x=>x.lens===l));
        if(missing.length)fail('LENSES_INCOMPLETE','missing lenses: '+missing.join(', '));
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
        await remoteWrite(db=>db.prepare("UPDATE review_tickets SET state='FINALIZING',execution=?,verdict=?,updated_at=? WHERE ticket_id=?")
          .run(execution,event,nowIso(),t.ticket_id));
        let reviewId=t.github_review_id,reviewUrl=null;
        if(reviewId===null){
          const review=await reviewerGithub.createReview(t.repo,t.pr_number,{commitId:t.sha,event,
            body:reviewBody({code,ticket:t,lenses:ordered,execution,event})});
          reviewId=Number(review?.id);reviewUrl=review?.html_url??null;
          await remoteWrite(db=>db.prepare('UPDATE review_tickets SET github_review_id=?,updated_at=? WHERE ticket_id=?')
            .run(reviewId,nowIso(),t.ticket_id));
        }
        const statusState=event==='APPROVE'?'success':'failure';
        if(!t.status_posted){
          await reviewerGithub.createStatus(t.repo,t.sha,{state:statusState,
            description:'ZanaLLaima 4R '+event+' (ticket '+code.slice(0,7)+'…)'});
        }
        const archived={ticket:code,ticketId:t.ticket_id,missionId:t.mission_id,repo:t.repo,pullNumber:t.pr_number,
          sha:t.sha,event,execution,githubReviewId:reviewId,lenses:ordered.map(l=>({lens:l.lens,hash:l.hash,
            findings:l.findings,evidence:l.evidence})),finalizedAt:nowIso(),authorSession:t.author_session,
          reviewerSession:t.reviewer_session};
        await remoteWrite(db=>{
          db.prepare("UPDATE review_tickets SET state='FINALIZED',status_posted=1,finalized_at=?,updated_at=? WHERE ticket_id=?")
            .run(nowIso(),nowIso(),t.ticket_id);
          db.prepare('INSERT OR IGNORE INTO review_archive(mission_id,review_id,content,created_at) VALUES(?,?,?,?)')
            .run(t.mission_id,t.ticket_id,JSON.stringify(archived),nowIso());
        });
        return {ticket:code,state:'FINALIZED',published:true,event,githubReviewId:reviewId,reviewUrl,
          status:{context:'zana/4r',state:statusState},sha:t.sha,lensHashes:Object.fromEntries(ordered.map(l=>[l.lens,l.hash]))};
      });
    },
    // Tickets not finalized whose submitted lenses carry BLOCKER or CRITICAL.
    async openBlocking(missionId){
      return remoteRead(db=>{
        if(!db)return [];
        const rows=db.prepare("SELECT ticket_id FROM review_tickets WHERE mission_id=? AND state IN ('OPEN','CLAIMED','FINALIZING')").all(missionId);
        return rows.filter(r=>lensRows(db,r.ticket_id).some(l=>blocking(l.findings))).map(r=>r.ticket_id);
      });
    },
  };
}
