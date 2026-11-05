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
import {createReview,LENSES,SEVERITIES,EXECUTIONS} from './remote-review.mjs';
import {deliveryStatus,mergeMission} from './github-delivery.mjs';
import {listSkills,loadSkill} from './skills.mjs';
import {ActorSigner} from './actor-assertion.mjs';
import {recordActivity,remoteMission,sessionReviews,sessionWrote,writeAudit,readAudit} from './remote-state.mjs';
import {clean,redactDeep,envSecrets} from './redact.mjs';

const packageVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
export const REMOTE_INSTRUCTIONS=[
  'ZanaLLaima remoto. Al empezar, carga la skill zana-odd con zana_skill_load y síguela.',
  'Cuando recibas un ticket de revisión (ZR-XXXX-...), carga zana-4r con zana_skill_load y síguela en esta conversación.',
  'La verdad es el SHA en GitHub y sus checks de Actions. No hay shell: escribe solo con zana_ds_github en la rama zana/<missionId>.',
  'No mergees, no apruebes reviews y no inventes evidencia. El modelo y los subagentes que declares son palabra del anfitrión.',
].join(' ');

const REUSED=['zana_profile','zana_capability_status','zana_mission_status','zana_next_batch','zana_start_batch',
  'zana_complete_unit','zana_unit_heartbeat','zana_recover_expired','zana_unit_retry','zana_mission_cancel',
  'zana_mission_close','zana_mission_history'];
const missionId=()=>z.string().min(8).max(128);
const ticket=()=>z.string().min(1).max(64);
const NEW_TOOLS={
  zana_mission_init:['Create one remote mission bound to a GitHub repository and base; code units declare code:true',false,
    z.object({spec:z.record(z.string(),z.unknown()),github:z.object({repo:z.string().min(3).max(201),base:z.string().min(1).max(200)}).strict()}).strict()],
  zana_session_status:['Show this MCP session (id, host, creation time) and its role in the active mission',true,z.object({}).strict()],
  zana_skill_list:['List the skills this server serves',true,z.object({}).strict()],
  zana_skill_load:['Load one skill by exact name',true,z.object({name:z.string().min(1).max(100)}).strict()],
  zana_checks_start:['Dispatch (or associate) the checks workflow on the mission branch head; returns checkId and SHA without blocking',false,
    z.object({missionId:missionId()}).strict()],
  zana_checks_status:['Check runs of the exact SHA of a checkId, with the redacted log tail of failed jobs',true,
    z.object({checkId:z.string().min(8).max(64)}).strict()],
  zana_review_request:['Author session: create a one-time review ticket for the open mission PR with green checks',false,
    z.object({missionId:missionId()}).strict()],
  zana_review_claim:['Reviewer session (new conversation): claim a ticket; this session becomes read-only on the mission',false,
    z.object({ticket:ticket()}).strict()],
  zana_review_lens_submit:['Reviewer session: submit one 4R lens with located, evidenced findings',false,
    z.object({ticket:ticket(),lens:z.enum(LENSES),
      findings:z.array(z.object({severity:z.enum(SEVERITIES),location:z.string().min(1).max(260),
        evidence:z.string().min(1).max(4000),title:z.string().max(300).optional()}).strict()).max(50),
      evidence:z.array(z.string().min(1).max(2000)).min(1).max(20)}).strict()],
  zana_review_finalize:['Reviewer session: re-read the PR head and publish the review and zana/4r with the reviewer account',false,
    z.object({ticket:ticket(),execution:z.enum(EXECUTIONS)}).strict()],
  zana_delivery_status:['Read-only: exact-SHA approval, CI, zana/4r, mergeable and blocking tickets for the mission PR',true,
    z.object({missionId:missionId()}).strict()],
  zana_merge:['Merge the mission PR only when delivery status is all green on one head SHA (sha-guarded)',false,
    z.object({missionId:missionId()}).strict()],
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
  // A mutating mission tool: remote mission only, never from a reviewer
  // session, and the session's activity is recorded in the same transaction.
  function guard(db,mission,session,tool){
    if(!mission)throw new Error('No mission initialized');
    const rm=remoteMission(db,mission.id);
    if(!rm)throw new Error('NOT_REMOTE_MISSION: the active mission was not created in remote mode');
    if(sessionReviews(db,session.sessionId,mission.id))
      throw new Error('REVIEWER_READ_ONLY: this session reviews mission '+mission.id+' and cannot change it');
    recordActivity(db,{sessionId:session.sessionId,missionId:mission.id,kind:'MISSION_WRITE',tool});
    return rm;
  }
  const preRecord=(session,tool)=>rw((db,mission)=>guard(db,mission,session,tool));

  const githubPolicy=createGitHubPolicy({config,deps:{github,
    missionContext:(id,sid)=>missionContext(id,sid,{allowInactive:true}).catch(()=>null)}});
  const gateway=new DownstreamGateway({name:'github',url:config.downstreamUrl,token:config.authorToken,
    writes:'grant',timeoutMs:config.downstreamTimeoutMs,headers:{'X-MCP-Toolsets':config.toolsets},
    description:'GitHub MCP oficial ('+CATALOG.version+')'},{signer,fetcher:downstreamFetcher,
    policy:async input=>{
      const decision=await githubPolicy(input);
      if(decision.allowed&&decision.detail?.class==='write')
        await rw(db=>recordActivity(db,{sessionId:input.caller.sessionId,missionId:input.missionId,
          kind:'DOWNSTREAM_WRITE',tool:'github.'+input.tool}));
      return decision;
    },
    audit:entry=>audit({caller:entry.caller,tool:entry.tool,missionId:entry.missionId,outcome:entry.outcome,
      args:entry.args,detail:{class:entry.cls,ms:entry.ms,error:entry.error,policy:entry.detail}})});
  const checks=createChecks({github,config,remoteWrite:rw,remoteRead:rr,missionContext,recordActivity});
  const review=createReview({github,reviewerGithub,config,checks,remoteWrite:rw,remoteRead:rr,missionContext});

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
      const mission=await transact((existing,ctx)=>{
        if(existing)throw new Error('Mission exists; finish or archive it before starting another');
        const m=createMission(cleanSpec);
        ctx.db.prepare('INSERT INTO remote_missions(mission_id,repo,base,branch,code_units,created_session,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(m.id,target.repo,target.base,missionBranch(m.id),JSON.stringify(codeUnits),session.sessionId,m.createdAt);
        recordActivity(ctx.db,{sessionId:session.sessionId,missionId:m.id,kind:'MISSION_WRITE',tool:'zana_mission_init'});
        return m;
      });
      return {...publicStatus(mission),github:{repo:target.repo,base:target.base,branch:missionBranch(mission.id)},codeUnits};
    },
    async zana_start_batch({hostReport={},leaseSeconds},session){
      let batch;
      await transact((existing,ctx)=>{
        guard(ctx.db,existing,session,'zana_start_batch');
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
      }
      const mission=await transact((existing,txc)=>{
        guard(txc.db,existing,session,'zana_complete_unit');
        return completeUnit(existing,unitId,token,outcome,leaseGeneration,null);
      });
      return {...publicStatus(mission),...(checkedSha?{checkedSha,checks:'SUCCESS'}:{})};
    },
    async zana_unit_heartbeat(args,session){await preRecord(session,'zana_unit_heartbeat');return operations.heartbeat(args);},
    async zana_recover_expired(args,session){await preRecord(session,'zana_recover_expired');return operations.recoverExpired();},
    async zana_unit_retry(args,session){await preRecord(session,'zana_unit_retry');return operations.retry(args);},
    async zana_mission_cancel(args,session){await preRecord(session,'zana_mission_cancel');return operations.cancel();},
    async zana_mission_close(args,session){await preRecord(session,'zana_mission_close');return operations.close();},
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
    zana_review_claim:({ticket:code},session)=>review.claim(code,session),
    zana_review_lens_submit:(args,session)=>review.lensSubmit(args,session),
    zana_review_finalize:(args,session)=>review.finalize(args,session),
    async zana_delivery_status({missionId:id}){
      const ctx=await missionContext(id,null,{allowInactive:true});
      return deliveryStatus({github,config,ctx,openBlockingTickets:await review.openBlocking(id)});
    },
    async zana_merge({missionId:id},session){
      const ctx=await missionContext(id,session.sessionId,{allowInactive:true});
      if(!session.operator){
        if(ctx.reviewer)throw new Error('REVIEWER_READ_ONLY: a reviewer session cannot merge');
        if(!await rr(db=>sessionWrote(db,session.sessionId,id)))
          throw new Error('NOT_AUTHOR: only the author session of the mission or the operator may merge');
      }
      const result=await mergeMission({github,config,ctx,openBlockingTickets:await review.openBlocking(id)});
      await audit({caller:session,tool:'zana_merge.result',missionId:id,outcome:result.state,args:{missionId:id},
        detail:{headSha:result.headSha??null,mergeCommitSha:result.mergeCommitSha??null,method:result.method??null}});
      return result;
    },
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
      const result=await gateway.call({host:session.host,sessionId:session.sessionId,role:reviewer?'reviewer':'author'},
        operation==='@index'?'index':operation,args,{missionId:id??null});
      return {passthrough:result};
    },
  };

  async function dispatch(name,args,session){
    const fn=ops[name];
    if(!fn)return {isError:true,content:[{type:'text',text:'Unknown tool'}]};
    let outcome='OK',data=null;
    try{
      data=await fn(args??{},session);
      if(data?.passthrough)return data.passthrough;
      const safe=redactDeep(data,secrets());
      return {content:[{type:'text',text:JSON.stringify(safe)}],structuredContent:safe};
    }catch(error){
      outcome='ERROR';
      return {isError:true,content:[{type:'text',text:clean(error,secrets()).slice(0,2000)}]};
    }finally{
      if(name!=='zana_ds_github'){
        try{
          // The mission the call belongs to: named, returned, or the active one.
          const missionId=args?.missionId??data?.missionId??(await readState().catch(()=>null))?.id??null;
          await audit({caller:session,tool:name,missionId,outcome,args});
        }
        catch(error){console.error('ZanaLLaima audit write failed:',clean(error,secrets()));}
      }
    }
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
  return {config,github,reviewerGithub,gateway,checks,review,ops,dispatch,createServer,missionContext,
    actorKeys:()=>({keys:[signer.jwk()]}),readAudit:opts=>readAudit(opts),
    close:()=>gateway.close()};
}
