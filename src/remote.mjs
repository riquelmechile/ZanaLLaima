// Remote MCP mode (ZanaLLaima for the ChatGPT app): tool surface, session
// bookkeeping and wiring of missions, checks, review tickets, delivery,
// merge and the GitHub downstream. Transport and OAuth live in src/http.mjs.
// Not exposed here: zana_apply_write and the local git-evidence review tools
// (stdio only, frozen), storage administration and signed grants (operator
// CLI only).
import {McpServer} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {readFileSync} from 'node:fs';
import {operations} from './actions.mjs';
import {schemas,TOOL_DESCRIPTIONS} from './mcp.mjs';
import {capabilityContract} from './capabilities.mjs';
import {createMission,startBatch,completeUnit,publicStatus} from './core.mjs';
import {transact,readState,remoteRead,remoteWrite} from './store.mjs';
import {GitHubApi,validRefName} from './github-api.mjs';
import {remoteConfig,repoAllowed} from './remote-config.mjs';
import {DownstreamGateway} from './downstream.mjs';
import {createGitHubPolicy,CATALOG,liveProblems,missionBranch} from './github-policy.mjs';
import {createChecks} from './checks.mjs';
import {createReview,LENSES,SEVERITIES,EXECUTIONS,ORIGINS} from './remote-review.mjs';
import {compactWrite} from './downstream-compact.mjs';
import {deliveryStatus,mergeMission,ticketView} from './github-delivery.mjs';
import {listSkills,loadSkill} from './skills.mjs';
import {ActorSigner} from './actor-assertion.mjs';
import {lineBudget,lineLimit,EXTEND_MAX} from './line-budget.mjs';
import {nowIso,recordActivity,remoteMission,sessionReviews,sessionWrote,sessionIsMissionAuthor,writeAudit,readAudit} from './remote-state.mjs';
import {budgetOf,remainingStarts} from './budget.mjs';
import {within,DeadlineError} from './deadline.mjs';
import {clean,redactDeep,envSecrets} from './redact.mjs';
import {closeMission} from './lifecycle.mjs';
import {readPointer,resolveProject,memoryContext,missionProject,setMissionProject,saveSummary,saveEntry,searchMemory} from './project-memory.mjs';

const packageVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
export const REMOTE_INSTRUCTIONS=[
  'ZanaLLaima remoto.',
  'Si el primer mensaje de la conversación trae un ticket ZR-, carga solo la skill zana-4r con zana_skill_load y no llames ninguna tool de misión antes de zana_review_claim.',
  'Si no, al empezar carga zana-odd con zana_skill_load y síguela: con checks verdes, zana_complete_unit antes de zana_review_request.',
  'La verdad es el SHA en GitHub y sus checks de Actions. No hay shell: escribe solo con zana_ds_github en la rama zana/<missionId>.',
  'Lee memory.context de zana_mission_init antes de planificar; si memory.pointer no está OK, escribe primero .zanallaima.json. Guarda con zana_memory_save las decisiones que un próximo desarrollador necesitaría; zana_mission_close exige el resumen.',
  'No pegues el contenido de los archivos en el chat: escribe directo con la tool y responde al usuario con un resumen corto (archivos, SHA, link). No mergees por el downstream; zana_merge solo si el usuario lo pide. No apruebes reviews y no inventes evidencia. El modelo y los subagentes que declares son palabra del anfitrión.',
].join(' ');

const REUSED=['zana_profile','zana_capability_status','zana_mission_status','zana_next_batch','zana_start_batch',
  'zana_complete_unit','zana_unit_heartbeat','zana_recover_expired','zana_unit_retry','zana_mission_cancel',
  'zana_mission_history'];
const uuid=()=>z.string().min(8).max(128);
const missionId=()=>z.string().min(8).max(128);
const ticket=()=>z.string().min(1).max(64);
const note=()=>z.array(z.object({topic:z.string().min(3).max(80),body:z.string().min(3).max(1000)}).strict()).max(20);
// The mandatory close summary (§6.5); the stdio close keeps its frozen schema.
const CLOSE_SCHEMA=z.object({summary:z.object({done:z.string().min(20).max(1000),decisions:note(),conventions:note(),
  pending:note(),keyFiles:z.array(z.string().min(1).max(260)).max(30)}).strict()}).strict();
const projectId=()=>z.string().regex(/^zp_[0-9a-f]{16}$/);
const NOTE_KINDS=['decision','convention','issue','pending'];
const NEW_TOOLS={
  zana_mission_init:['Create one remote mission bound to a GitHub repository and base; code units declare code:true. Returns memory: the project context to read before planning and the .zanallaima.json pointer to write first when its status is not OK',false,
    z.object({spec:z.record(z.string(),z.unknown()),github:z.object({repo:z.string().min(3).max(201),base:z.string().min(1).max(200)}).strict()}).strict()],
  zana_session_status:['Show this MCP session (id, host, creation time) and its role in the active mission',true,z.object({}).strict()],
  zana_skill_list:['List the skills this server serves',true,z.object({}).strict()],
  zana_skill_load:['Load one skill by exact name',true,z.object({name:z.string().min(1).max(100)}).strict()],
  zana_checks_start:['Dispatch (or associate) the checks workflow on the mission branch head; returns checkId and SHA without blocking',false,
    z.object({missionId:missionId()}).strict()],
  zana_checks_status:['Check runs of the exact SHA of a checkId, with the redacted log tail of failed jobs',true,
    z.object({checkId:z.string().min(8).max(64)}).strict()],
  zana_review_request:['Author session: create a one-time review ticket for the open mission PR with green checks, after zana_complete_unit (refused while a code unit is RUNNING)',false,
    z.object({missionId:missionId()}).strict()],
  zana_budget_extend:['Author session, ONLY after the user said yes to the exact number: raise the mission line budget (additions + deletions without lockfiles) after OVER_LINE_BUDGET. Never call it without asking the user',false,
    z.object({missionId:missionId(),lines:z.number().int().min(1).max(EXTEND_MAX),reason:z.string().min(3).max(300)}).strict()],
  zana_review_claim:['Reviewer session (new conversation): claim a ticket; this session becomes read-only on the mission',false,
    z.object({ticket:ticket()}).strict()],
  zana_review_lens_submit:['Reviewer session: submit one 4R lens with located, evidenced findings; each finding has its causal origin (PREEXISTING needs a proof citing file:line of the base, or it is stored as UNKNOWN)',false,
    z.object({ticket:ticket(),lens:z.enum(LENSES),
      findings:z.array(z.object({severity:z.enum(SEVERITIES),location:z.string().min(1).max(260),
        evidence:z.string().min(1).max(4000),title:z.string().max(300).optional(),
        origin:z.enum(ORIGINS),proof:z.string().max(2000).optional()}).strict()).max(50),
      evidence:z.array(z.string().min(1).max(2000)).min(1).max(20)}).strict()],
  zana_review_diff:['Reviewer session: read one page of the ticket diff (per file, paged); finalize requires every page read',true,
    z.object({ticket:ticket(),page:z.number().int().min(0).max(100000)}).strict()],
  zana_correction_start:['Author session: after a REQUEST_CHANGES review, add one PENDING code unit to correct it (normal budget and review rounds)',false,
    z.object({missionId:missionId()}).strict()],
  zana_session_rebind:['After a server restart or a new MCP session: move a RUNNING unit with a live lease to this session without consuming an attempt (expired: zana_recover_expired, zana_unit_retry, zana_start_batch)',false,
    z.object({missionId:missionId(),unitId:z.string().min(1).max(64),token:uuid(),leaseGeneration:z.number().int().positive()}).strict()],
  zana_mission_close:['Close the mission after every unit completed, with the mandatory summary (done, decisions, conventions, pending, keyFiles) saved to the project memory',false,
    CLOSE_SCHEMA],
  zana_mission_archive:['Archive the active remote mission once it is CLOSED or CANCELLED, so a new one can start',false,z.object({}).strict()],
  zana_review_finalize:['Reviewer session: re-read the PR head and publish the review and zana/4r with the reviewer account',false,
    z.object({ticket:ticket(),execution:z.enum(EXECUTIONS)}).strict()],
  zana_delivery_status:['Read-only: exact-SHA approval of the current ticket, CI, zana/4r, mergeable and blocking tickets for the mission PR',true,
    z.object({missionId:missionId()}).strict()],
  zana_merge:['Merge the mission PR only when delivery status is all green on one head SHA (sha-guarded)',false,
    z.object({missionId:missionId()}).strict()],
  zana_memory_context:['Read-only: project memory (conventions, decisions, open pending, issues, last summaries; 16 KB) of projectId, of missionId, or of the active mission',true,
    z.object({projectId:projectId().optional(),missionId:missionId().optional()}).strict()],
  zana_memory_search:['Read-only: full-text search of the project memory (the active mission project, projectId, or every project with all:true); live entries first, superseded ones marked',true,
    z.object({query:z.string().min(2).max(200),projectId:projectId().optional(),all:z.boolean().optional(),limit:z.number().int().min(1).max(50).optional()}).strict()],
  zana_memory_save:['Author session with the mission ACTIVE: save a decision, convention, issue or pending to the mission project; the same kind and topic replaces the previous entry',false,
    z.object({missionId:missionId(),kind:z.enum(NOTE_KINDS),topic:z.string().min(3).max(80),body:z.string().min(3).max(1000)}).strict()],
  zana_memory_resolve:['Author session with the mission ACTIVE: mark a pending entry (seq) of the mission project as resolved',false,
    z.object({missionId:missionId(),seq:z.number().int().positive()}).strict()],
  zana_ds_github:['GitHub MCP downstream router: operation "index" lists tools and their ZanaLLaima class; any other operation calls that tool',false,
    z.object({operation:z.string().min(1).max(64),arguments:z.record(z.string(),z.unknown()).optional(),
      missionId:missionId().optional()}).strict()],
};
export const REMOTE_TOOL_NAMES=Object.freeze([...REUSED,...Object.keys(NEW_TOOLS)].sort());

export function createRemoteRuntime({env=process.env,config=remoteConfig(env),fetcher=globalThis.fetch,
  downstreamFetcher=fetcher,signer=ActorSigner.generate()}={}){
  // State lives where ZANA_STATE_FILE points, like every other mode.
  const github=new GitHubApi({baseUrl:config.apiUrl,token:config.authorToken,fetcher});
  const reviewerGithub=new GitHubApi({baseUrl:config.apiUrl,token:config.reviewerToken,fetcher});
  const secrets=()=>[...envSecrets(env),...[config.authorToken,config.reviewerToken].filter(Boolean)];
  const rw=fn=>remoteWrite(fn),rr=fn=>remoteRead(fn);
  const audit=entry=>rw(db=>writeAudit(db,entry));

  async function missionContext(id,sessionId,{write=false,allowInactive=false}={}){
    return rr((db,mission)=>{
      const rm=db?remoteMission(db,id):null;
      if(!rm)throw new Error('UNKNOWN_MISSION: no remote mission '+id);
      const active=mission?.id===id?mission:null;
      if(!active&&!allowInactive)throw new Error('MISSION_NOT_ACTIVE: mission '+id+' is not the active mission');
      const status=active?(active.status||'ACTIVE'):'INACTIVE';
      const reviewer=sessionId?sessionReviews(db,sessionId,id):false;
      if(write&&status!=='ACTIVE')throw new Error('MISSION_NOT_ACTIVE: mission '+id+' is '+status);
      if(write&&reviewer)throw new Error('REVIEWER_READ_ONLY: this session reviews mission '+id+' and cannot write in it');
      const runningForSession=Boolean(active&&sessionId&&active.units.some(u=>u.status==='RUNNING'&&
        u.run?.sessionId===sessionId&&Date.parse(u.run.expiresAt)>Date.now()));
      return {...rm,status,reviewer,runningForSession,objective:active?.objective??null,
        units:(active?.units??[]).map(u=>({id:u.id,instruction:u.instruction,dependsOn:u.dependsOn,
          status:u.status,code:rm.codeUnits.includes(u.id)}))};
    });
  }
  // A mutating mission tool: remote mission only and never from a reviewer
  // session. allow() only checks; guard() also records the activity and must
  // run in the same transaction as the change, so a failed change records
  // nothing.
  function allow(db,mission,session){
    if(!mission)throw new Error('No mission initialized');
    const rm=remoteMission(db,mission.id);
    if(!rm)throw new Error('NOT_REMOTE_MISSION: the active mission was not created in remote mode');
    if(sessionReviews(db,session.sessionId,mission.id))
      throw new Error('REVIEWER_READ_ONLY: this session reviews mission '+mission.id+' and cannot change it');
    return rm;
  }
  function guard(db,mission,session,tool,kind='MISSION_WRITE'){
    const rm=allow(db,mission,session);
    recordActivity(db,{sessionId:session.sessionId,clientId:session.clientId,missionId:mission.id,kind,tool});
    return rm;
  }
  // Operations that run their own transaction: check first, record only after success.
  async function checked(session,tool,run){
    const missionId=await rr((db,mission)=>{allow(db,mission,session);return mission.id;});
    const result=await run();
    await rw(db=>recordActivity(db,{sessionId:session.sessionId,clientId:session.clientId,missionId,kind:'MISSION_WRITE',tool}));
    return result;
  }

  // The project of the active mission; one without it (created in 0.6.0 or
  // with GitHub down) reads the pointer here, before the transaction.
  async function projectFor(session){
    const pre=await rr((db,mission)=>{const rm=allow(db,mission,session);return {id:mission.id,rm,projectId:missionProject(db,mission.id)};});
    if(!pre.projectId){
      try{pre.found=await readPointer(github,pre.rm.repo,pre.rm.base);}
      catch(error){throw new Error('MEMORY_UNAVAILABLE: the project of this mission cannot be resolved ('+clean(error,secrets())+'); retry');}
    }
    return pre;
  }
  function projectIn(db,mission,pre){
    if(mission.id!==pre.id||(mission.status||'ACTIVE')!=='ACTIVE')throw new Error('MISSION_NOT_ACTIVE: mission '+pre.id+' is not the active mission');
    const id=missionProject(db,mission.id);
    if(id)return {projectId:id};
    const resolved=resolveProject(db,{...pre.found,missionId:mission.id});
    setMissionProject(db,mission.id,resolved.projectId);
    return resolved;
  }

  const githubPolicy=createGitHubPolicy({config,deps:{github,
    // Only a mission that does not exist (or is not active) reads as "no mission";
    // a database error propagates and the gateway fails closed with it.
    missionContext:(id,sid)=>missionContext(id,sid,{allowInactive:true}).catch(error=>{
      if(/^(UNKNOWN_MISSION|MISSION_NOT_ACTIVE):/.test(String(error?.message)))return null;
      throw error;
    })}});
  const gateway=new DownstreamGateway({name:'github',url:config.downstreamUrl,token:config.authorToken,
    writes:'grant',timeoutMs:config.downstreamTimeoutMs,headers:{'X-MCP-Toolsets':config.toolsets},
    description:'GitHub MCP oficial ('+CATALOG.version+')'},{signer,fetcher:downstreamFetcher,
    policy:githubPolicy,
    // A write that reached GitHub (any outcome but REFUSED) is session activity.
    audit:entry=>rw(db=>{
      const wrote=entry.detail?.class==='write'&&entry.outcome!=='REFUSED';
      if(wrote)recordActivity(db,{sessionId:entry.caller.sessionId,clientId:entry.caller.clientId,missionId:entry.missionId,
        kind:'DOWNSTREAM_WRITE',tool:entry.tool});
      writeAudit(db,{caller:entry.caller,tool:entry.tool,missionId:entry.missionId,outcome:entry.outcome,
        args:entry.args,detail:{class:entry.cls,ms:entry.ms,error:entry.error,policy:entry.detail},
        category:entry.outcome==='REFUSED'?'refused':entry.cls==='read'?'read':'write'});
    })});
  const checks=createChecks({github,config,remoteWrite:rw,remoteRead:rr,missionContext,recordActivity});
  const review=createReview({github,reviewerGithub,config,checks,remoteWrite:rw,remoteRead:rr,transact,missionContext});

  const ops={
    zana_profile:()=>operations.profile(),
    zana_capability_status:args=>capabilityContract(args.hostReport??{}),
    zana_mission_status:()=>operations.status(),
    zana_next_batch:args=>operations.next(args),
    zana_mission_history:args=>operations.missionHistory(args),
    async zana_mission_init({spec,github:target},session){
      if(!repoAllowed(config,target.repo))throw new Error('REPO_NOT_ALLOWED: '+target.repo+' is not in ZANA_GITHUB_REPOS');
      if(!validRefName(target.base))throw new Error('Invalid base branch');
      const units=Array.isArray(spec?.units)?spec.units:[];
      if(units.some(u=>u?.effect==='WRITE'))
        throw new Error('Remote missions use READ units; mark the units that change code with code:true (writes go through the GitHub downstream)');
      const codeUnits=units.filter(u=>u?.code===true).map(u=>u.id);
      const cleanSpec={...spec,units:units.map(u=>{if(!u||typeof u!=='object')return u;const {code,...rest}=u;return rest;})};
      // Memory never blocks the mission: a GitHub failure is reported in memory.error.
      let found=null,memory;
      try{found=await readPointer(github,target.repo,target.base);}
      catch(error){memory={error:clean(error,secrets())};}
      const mission=await transact((existing,ctx)=>{
        if(existing)throw new Error('Mission exists; finish or archive it before starting another');
        const m=createMission(cleanSpec);
        ctx.db.prepare('INSERT INTO remote_missions(mission_id,repo,base,branch,code_units,created_session,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(m.id,target.repo,target.base,missionBranch(m.id),JSON.stringify(codeUnits),session.sessionId,m.createdAt);
        if(found){
          const {projectId,pointer}=resolveProject(ctx.db,{...found,missionId:m.id});
          setMissionProject(ctx.db,m.id,projectId);
          memory={projectId,pointer,context:memoryContext(ctx.db,projectId,{maxBytes:4096})};
        }
        recordActivity(ctx.db,{sessionId:session.sessionId,clientId:session.clientId,missionId:m.id,kind:'MISSION_WRITE',tool:'zana_mission_init'});
        return m;
      });
      return {...publicStatus(mission),github:{repo:target.repo,base:target.base,branch:missionBranch(mission.id)},codeUnits,memory};
    },
    async zana_start_batch({hostReport={},leaseSeconds},session){
      let batch;
      await transact((existing,ctx)=>{
        guard(ctx.db,existing,session,'zana_start_batch','UNIT_START');
        const changed=startBatch(existing,hostReport,null,leaseSeconds);
        for(const packet of changed.batch.packets){
          const unit=changed.mission.units.find(u=>u.id===packet.unitId);
          unit.run.sessionId=session.sessionId;unit.run.host=session.host;
        }
        batch=changed.batch;
        return changed.mission;
      });
      return batch;
    },
    async zana_complete_unit({unitId,token,leaseGeneration,outcome},session){
      const state=await readState();
      if(!state)throw new Error('No mission initialized');
      const ctx=await missionContext(state.id,session.sessionId,{write:true});
      let checkedSha=null;
      if(ctx.codeUnits.includes(unitId)&&outcome?.success===true){
        checkedSha=await github.branchHead(ctx.repo,ctx.branch);
        const verdict=await checks.verdict(ctx.repo,checkedSha);
        if(verdict.state!=='SUCCESS')
          throw new Error('CHECKS_NOT_GREEN: code unit '+unitId+' needs a green check on its final SHA '+checkedSha+' (now '+verdict.state+'); run zana_checks_start');
        // A write that landed while the checks were read would leave the final
        // commit unverified: the head must still be the checked SHA.
        const after=await github.branchHead(ctx.repo,ctx.branch);
        if(after!==checkedSha)
          throw new Error('HEAD_MOVED: '+ctx.branch+' moved from '+checkedSha+' to '+after+' while checks were read; run zana_checks_start again');
      }
      const mission=await transact((existing,txc)=>{
        guard(txc.db,existing,session,'zana_complete_unit');
        return completeUnit(existing,unitId,token,outcome,leaseGeneration,null);
      });
      return {...publicStatus(mission),...(checkedSha?{checkedSha,checks:'SUCCESS'}:{})};
    },
    zana_unit_heartbeat:(args,session)=>checked(session,'zana_unit_heartbeat',()=>operations.heartbeat(args)),
    zana_recover_expired:(args,session)=>checked(session,'zana_recover_expired',()=>operations.recoverExpired()),
    zana_unit_retry:(args,session)=>checked(session,'zana_unit_retry',()=>operations.retry(args)),
    zana_mission_cancel:(args,session)=>checked(session,'zana_mission_cancel',()=>operations.cancel()),
    // Summary first (dispatch does not validate schemas), then the project:
    // a mission created without one (0.6.0 or a GitHub failure) resolves it now.
    async zana_mission_close(args,session){
      const parsed=CLOSE_SCHEMA.safeParse(args);
      if(!parsed.success)throw new Error('SUMMARY_REQUIRED: zana_mission_close needs summary {done, decisions, conventions, pending, keyFiles}: '+
        parsed.error.issues.map(i=>i.path.join('.')+' '+i.message).join('; ').slice(0,200));
      const {summary}=parsed.data;
      const pre=await projectFor(session);
      let status,memory;
      await transact((existing,txc)=>{
        guard(txc.db,existing,session,'zana_mission_close');
        const {projectId,pointer}=projectIn(txc.db,existing,pre);
        status=closeMission(existing);
        const sha=txc.db.prepare('SELECT sha FROM review_tickets WHERE mission_id=? ORDER BY created_at DESC LIMIT 1').get(existing.id)?.sha??null;
        memory={...saveSummary(txc.db,{projectId,missionId:existing.id,summary,sha,sessionId:session.sessionId,secrets:secrets()}),
          ...(pointer?{pointer}:{})};
        return existing;
      });
      return {...status,memory};
    },
    async zana_mission_archive(args,session){
      await rr((db,mission)=>{
        allow(db,mission,session);
        if(!['CLOSED','CANCELLED'].includes(mission.status))
          throw new Error('MISSION_NOT_FINISHED: archive needs a CLOSED or CANCELLED mission (it is '+mission.status+')');
      });
      return operations.archive();
    },
    // Add one PENDING code unit after a REQUEST_CHANGES review. It consumes
    // the normal budget when started (maxWorkStarts, maxUnitAttempts) and the
    // next ticket consumes a review round (maxReviewRounds).
    async zana_correction_start({missionId:id},session){
      // Only the unit id comes from this read; the authoritative check runs
      // inside the mission transaction below.
      const last=await review.latest(id);
      if(!last)throw new Error('NO_CHANGES_REQUESTED: mission '+id+' has no review ticket');
      const unitId='fix-'+last.ticket_id.slice(0,8);
      let added;
      await transact((existing,txc)=>{
        if(existing?.id!==id)throw new Error('MISSION_NOT_ACTIVE: mission '+id+' is not the active mission');
        guard(txc.db,existing,session,'zana_correction_start');
        // Revalidate inside the mission transaction: the pre-check above ran
        // before it, and a newer ticket may have appeared meanwhile (TOCTOU).
        const now=review.latestIn(txc.db,id);
        if(now?.ticket_id!==last.ticket_id||now.state!=='FINALIZED'||now.verdict!=='REQUEST_CHANGES')
          throw new Error('NO_CHANGES_REQUESTED: the latest ticket of mission '+id+' changed and did not end in REQUEST_CHANGES');
        if((existing.status||'ACTIVE')!=='ACTIVE')throw new Error('MISSION_NOT_ACTIVE: mission '+id+' is '+existing.status);
        if(!remoteMission(txc.db,id).codeUnits.length)throw new Error('NO_CODE_UNITS: mission '+id+' has no code units to correct');
        if(existing.units.some(u=>u.id===unitId))throw new Error('CORRECTION_EXISTS: unit '+unitId+' already corrects that review');
        if((existing.reviewCount||0)>=budgetOf(existing).maxReviewRounds)
          throw new Error('REVIEW_ROUNDS_EXHAUSTED: no review round left for a corrected candidate');
        if(remainingStarts(existing)<=0)throw new Error('Mission work-start budget exhausted');
        if(existing.units.length>=100)throw new Error('Mission already has 100 units');
        existing.units.push({id:unitId,instruction:'Corregir los hallazgos BLOCKER/CRITICAL de la review del ticket '+last.ticket_id+
          ' (SHA '+last.sha+') en la rama de la misión: zana_start_batch → escribir → zana_checks_* hasta verde → zana_complete_unit → zana_review_request (ticket nuevo).',
          effect:'READ',dependsOn:[],paths:[],status:'PENDING',attempts:0,run:null,result:null});
        existing.revision++;
        const rm=remoteMission(txc.db,id);
        txc.db.prepare('UPDATE remote_missions SET code_units=? WHERE mission_id=?').run(JSON.stringify([...rm.codeUnits,unitId]),id);
        added=existing;
        return existing;
      });
      return {missionId:id,unitId,correctsTicket:last.ticket_id,sha:last.sha,mission:publicStatus(added),
        next:'zana_start_batch → write on the mission branch → zana_checks_start/zana_checks_status until green → zana_complete_unit → zana_review_request'};
    },
    // Move a RUNNING unit to this session (after a restart or a new MCP
    // session) without consuming an attempt. The new session counts as a
    // holder of the unit: it can never claim a ticket of this mission.
    async zana_session_rebind({missionId:id,unitId,token,leaseGeneration},session){
      let packet;
      await transact((existing,txc)=>{
        if(existing?.id!==id)throw new Error('MISSION_NOT_ACTIVE: mission '+id+' is not the active mission');
        guard(txc.db,existing,session,'zana_session_rebind','UNIT_REBIND');
        const unit=existing.units.find(u=>u.id===unitId);
        if(unit?.status!=='RUNNING'||unit.run?.token!==token||unit.run?.leaseGeneration!==leaseGeneration)
          throw new Error('Invalid or stale run token');
        if(!(Date.parse(unit.run.expiresAt)>Date.now()))throw new Error('Lease expired; reconciliation required');
        unit.run.previousSessionId=unit.run.sessionId??null;
        unit.run.sessionId=session.sessionId;unit.run.host=session.host;
        existing.revision++;
        packet={missionId:id,unitId,leaseGeneration,expiresAt:unit.run.expiresAt,previousSessionId:unit.run.previousSessionId};
        return existing;
      });
      return {...packet,rebound:true,attempts:'unchanged'};
    },
    zana_session_status:(args,session)=>rr((db,mission)=>({
      session:{id:session.sessionId,host:session.host,createdAt:session.createdAt},
      activeMission:mission&&db?{id:mission.id,remote:remoteMission(db,mission.id),
        wrote:sessionWrote(db,session.sessionId,mission.id),reviewer:sessionReviews(db,session.sessionId,mission.id)}:null,
      note:'Separate conversations must show different session ids; that is what review separation relies on.'})),
    zana_skill_list:()=>({skills:listSkills()}),
    zana_skill_load:({name})=>loadSkill(name),
    zana_checks_start:({missionId:id},session)=>checks.start(id,session),
    zana_checks_status:({checkId})=>checks.status(checkId),
    zana_review_request:({missionId:id},session)=>review.request(id,session),
    // The server cannot verify the user's consent: the tool is a write (ChatGPT
    // asks for confirmation), needs a reason and is audited as 'write'.
    async zana_budget_extend({missionId:id,lines,reason},session){
      let previous;
      await transact((existing,txc)=>{
        if(existing?.id!==id)throw new Error('MISSION_NOT_ACTIVE: mission '+id+' is not the active mission');
        const rm=guard(txc.db,existing,session,'zana_budget_extend');
        // Same sessions that may merge: the creator or a holder of one of its units.
        if(!sessionIsMissionAuthor(txc.db,session.sessionId,id))
          throw new Error('NOT_AUTHOR: only the session that created the mission or held one of its units may extend its line budget');
        if((existing.status||'ACTIVE')!=='ACTIVE')throw new Error('MISSION_NOT_ACTIVE: mission '+id+' is '+existing.status);
        previous=lineLimit(rm,config);
        txc.db.prepare('UPDATE remote_missions SET line_budget_extension=? WHERE mission_id=?')
          .run(JSON.stringify({limit:lines,reason,sessionId:session.sessionId,at:nowIso()}),id);
        existing.revision++;
        return existing;
      });
      return {missionId:id,lineBudget:{limit:lines,previous,reason}};
    },
    zana_review_claim:({ticket:code},session)=>review.claim(code,session),
    zana_review_lens_submit:(args,session)=>review.lensSubmit(args,session),
    zana_review_diff:(args,session)=>review.diff(args,session),
    zana_review_finalize:(args,session)=>review.finalize(args,session),
    async zana_delivery_status({missionId:id}){
      const ctx=await missionContext(id,null,{allowInactive:true});
      // Informative only: the budget is enforced at zana_review_request, not at the merge.
      const lineBudgetOf=async pull=>{
        try{return lineBudget(await github.pullFiles(ctx.repo,pull.number),{limit:lineLimit(ctx,config),changedFiles:pull.changed_files});}
        catch(error){return {error:clean(error,secrets())};}
      };
      return deliveryStatus({github,config,ctx,openBlockingTickets:await review.openBlocking(id),currentTicket:await review.latest(id),lineBudgetOf});
    },
    async zana_merge({missionId:id},session){
      const ctx=await missionContext(id,session.sessionId,{allowInactive:true});
      if(!session.operator){
        if(ctx.reviewer)throw new Error('REVIEWER_READ_ONLY: a reviewer session cannot merge');
        if(!await rr(db=>sessionIsMissionAuthor(db,session.sessionId,id)))
          throw new Error('NOT_AUTHOR: only the session that created the mission, a session that held one of its units, or the operator may merge');
      }
      let result;
      // Serialized with ticket requests and publications of this mission; the
      // DB re-read before the merge call also covers other processes.
      try{
        result=await review.withMissionLock(id,async()=>{
          const evaluated=await review.latest(id);
          return mergeMission({github,config,ctx,openBlockingTickets:await review.openBlocking(id),currentTicket:evaluated,
            revalidate:async()=>{
              const now=await review.latest(id);
              // Any live (possibly blocking) ticket would be newer than the evaluated one.
              return ticketView(now)!==ticketView(evaluated)
                ?'Current review ticket changed during the merge checks ('+(now?now.ticket_id+' '+now.state:'none')+'); evaluate again':null;
            },
            onAttempt:headSha=>audit({caller:session,tool:'zana_merge.attempt',missionId:id,outcome:'ATTEMPT',
              args:{missionId:id},detail:{headSha,method:config.mergeMethod},category:'merge'})});
        });
      }catch(error){
        await audit({caller:session,tool:'zana_merge.result',missionId:id,outcome:'ERROR',args:{missionId:id},
          detail:{error:clean(error,secrets())},category:'merge'});
        throw error;
      }
      await audit({caller:session,tool:'zana_merge.result',missionId:id,outcome:result.state,args:{missionId:id},
        detail:{headSha:result.headSha??null,mergeCommitSha:result.mergeCommitSha??null,method:result.method??null,
          recovered:result.recovered??false},category:'merge'});
      return result;
    },
    zana_memory_context:({projectId:pid,missionId:id},session)=>rr((db,mission)=>{
      if(pid&&id)throw new Error('INVALID_ARGUMENTS: pass projectId or missionId, not both');
      const wanted=pid??missionProject(db,id??mission?.id??'');
      const project=wanted?db.prepare('SELECT project_id,repo FROM projects WHERE project_id=?').get(wanted):null;
      if(!project)throw new Error('NO_PROJECT: '+(pid?'unknown project '+pid:'that mission has no project yet (it is resolved at zana_mission_close)'));
      return {repo:project.repo,...memoryContext(db,project.project_id,{maxBytes:16384})};
    }),
    zana_memory_search:({query,projectId:pid,all=false,limit=10},session)=>rr((db,mission)=>{
      if(typeof query!=='string'||query.trim().length<2||query.length>200)throw new Error('INVALID_QUERY: query needs 2 to 200 characters');
      const scope=all===true?null:pid??missionProject(db,mission?.id??'');
      if(all!==true&&!scope)throw new Error('NO_PROJECT: pass projectId or all:true (no active mission with a project)');
      return {query,scope:scope??'all',...searchMemory(db,{query,projectId:scope,limit:Number.isInteger(limit)&&limit>=1&&limit<=50?limit:10})};
    }),
    async zana_memory_save({missionId:id,kind,topic,body},session){
      if(!NOTE_KINDS.includes(kind))throw new Error('INVALID_MEMORY_KIND: use '+NOTE_KINDS.join(', ')+' (the summary goes in zana_mission_close)');
      const pre=await projectFor(session);
      return rw((db,mission)=>{
        guard(db,mission,session,'zana_memory_save');
        if(mission.id!==id)throw new Error('MISSION_NOT_ACTIVE: mission '+id+' is not the active mission');
        const {projectId:project,pointer}=projectIn(db,mission,pre);
        return {missionId:id,projectId:project,...saveEntry(db,{projectId:project,kind,topic,body,missionId:id,sessionId:session.sessionId,secrets:secrets()}),
          ...(pointer?{pointer}:{})};
      });
    },
    zana_memory_resolve:({missionId:id,seq},session)=>rw((db,mission)=>{
      guard(db,mission,session,'zana_memory_resolve');
      if(mission.id!==id||(mission.status||'ACTIVE')!=='ACTIVE')throw new Error('MISSION_NOT_ACTIVE: mission '+id+' is not the active mission');
      const project=missionProject(db,id);
      const row=db.prepare('SELECT * FROM project_memory WHERE seq=? AND project_id=?').get(seq,project);
      if(row?.kind!=='pending'||row.superseded_by)throw new Error('NOT_PENDING: '+seq+' is not a live pending entry of the project of mission '+id);
      const resolvedAt=row.resolved_at??nowIso();
      db.prepare('UPDATE project_memory SET resolved_at=? WHERE seq=?').run(resolvedAt,seq);
      return {missionId:id,projectId:project,seq,resolvedAt};
    }),
    async zana_ds_github({operation,arguments:args={},missionId:id},session){
      if(operation==='index'){
        await gateway.ensureFresh();
        const tools=gateway.tools();
        const name=typeof args.operation==='string'?args.operation:null;
        const describe=t=>{const e=CATALOG.tools[t.name];return {name:t.name,cls:t.cls,zana:e?.zana??'unclassified',
          ...(e?.rule?{rule:e.rule}:{}),...(e?.reason?{reason:e.reason}:{})};};
        if(name){
          const t=tools.find(x=>x.name===name);
          if(!t)throw new Error('Unknown tool '+name);
          return {...describe(t),description:t.description,inputSchema:t.inputSchema};
        }
        return {server:gateway.status(),catalogVersion:CATALOG.version,tools:tools.map(describe),problems:liveProblems(tools)};
      }
      const reviewer=id?await rr(db=>Boolean(db&&sessionReviews(db,session.sessionId,id))):false;
      const result=await gateway.call({host:session.host,sessionId:session.sessionId,clientId:session.clientId,role:reviewer?'reviewer':'author'},
        operation,args,{missionId:id??null});
      // Successful writes come back compact (paths, SHA, link); reads stay whole.
      return {passthrough:CATALOG.tools[operation]?.zana==='write'?compactWrite(operation,args,result):result};
    },
  };

  const readOnlyTool=name=>Boolean(NEW_TOOLS[name]?.[1]??TOOL_DESCRIPTIONS[name]?.[2]);
  const categoryOf=name=>/^zana_review_/.test(name)?'review':name==='zana_merge'?'merge':readOnlyTool(name)?'read':'write';
  // Every tool has a total deadline (ZANA_TOOL_DEADLINE_MS). A late operation
  // may still finish on its own; the caller is told to read state first.
  async function dispatch(name,args,session){
    const fn=ops[name];
    if(!fn)return {isError:true,content:[{type:'text',text:'Unknown tool'}]};
    let outcome='OK',data=null,result;
    try{
      data=await within(Promise.resolve().then(()=>fn(args??{},session)),config.toolDeadlineMs,name);
      result=data?.passthrough?redactDeep(data.passthrough,secrets()):redactDeep(data,secrets());
    }catch(error){
      outcome='ERROR';
      const text=error instanceof DeadlineError
        ?'TOOL_DEADLINE: '+name+' exceeded '+config.toolDeadlineMs+' ms; the operation may still complete, read state before retrying'
        :clean(error,secrets());
      result={isError:true,content:[{type:'text',text}]};
    }
    let auditFailed=false;
    // The downstream router is audited per forwarded call by the gateway.
    if(name!=='zana_ds_github'){
      try{
        // The mission the call belongs to: named, returned, or the active one.
        const missionId=args?.missionId??data?.missionId??(await readState().catch(()=>null))?.id??null;
        await audit({caller:session,tool:name,missionId,outcome,args,category:categoryOf(name)});
      }catch(error){
        auditFailed=true;
        console.error('ZanaLLaima audit write failed:',clean(error,secrets()));
      }
    }
    if(result.isError){
      if(auditFailed)result.content[0].text+=' (audit write failed)';
      return result;
    }
    if(data?.passthrough)return auditFailed?{...result,_meta:{...(result._meta??{}),'zana-llaima/auditFailed':true}}:result;
    const safe=auditFailed?{...result,auditFailed:true}:result;
    return {content:[{type:'text',text:JSON.stringify(safe)}],structuredContent:safe};
  }
  // One McpServer per MCP session; getSession() returns the bound identity.
  function createServer(getSession){
    const server=new McpServer({name:'zana-llaima',version:packageVersion},
      {maxToolInputElements:1000,instructions:REMOTE_INSTRUCTIONS});
    const register=(name,description,readOnly,inputSchema)=>server.registerTool(name,{description,inputSchema,
      annotations:{readOnlyHint:readOnly,destructiveHint:!readOnly,idempotentHint:readOnly}},
      async args=>dispatch(name,args,getSession()));
    for(const name of REUSED){const [,description,readOnly]=TOOL_DESCRIPTIONS[name];register(name,description,readOnly,schemas[name]);}
    for(const [name,[description,readOnly,schema]] of Object.entries(NEW_TOOLS))register(name,description,readOnly,schema);
    return server;
  }
  // Health: degraded when the database cannot be read or a token is missing.
  async function health(){
    const problems=[];
    let schemaVersion=null,staleTickets=null;
    try{
      ({schemaVersion,staleTickets}=await rr(db=>{
        if(!db)throw new Error('database not created yet');
        const cutoff=new Date(Date.now()-config.claimTtlMinutes*60_000).toISOString();
        return {schemaVersion:db.prepare('PRAGMA user_version').get().user_version,
          staleTickets:db.prepare("SELECT COUNT(*) n FROM review_tickets WHERE state IN ('CLAIMED','FINALIZING') AND claimed_at<=?").get(cutoff).n};
      }));
    }catch(error){problems.push('database: '+clean(error,secrets()));}
    if(!config.authorToken)problems.push('ZANA_DOWNSTREAM_GITHUB_TOKEN missing');
    if(!config.reviewerToken)problems.push('ZANA_REVIEWER_TOKEN missing');
    if(!config.reviewerLogin)problems.push('ZANA_REVIEWER_LOGIN missing');
    return {status:problems.length?'degraded':'ok',problems,schemaVersion,staleTickets,
      authorToken:config.authorToken?'configured':'missing',reviewerToken:config.reviewerToken?'configured':'missing',
      downstream:gateway.status().state};
  }
  return {config,github,reviewerGithub,gateway,checks,review,ops,dispatch,createServer,missionContext,health,
    actorKeys:()=>({keys:[signer.jwk()]}),readAudit:opts=>readAudit(opts),
    close:()=>gateway.close()};
}
