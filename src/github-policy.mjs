// ZanaLLaima's own GitHub policy on top of the downstream gateway: allowlist,
// fail closed. Reads are always allowed; writes only for the calling session
// while it holds a RUNNING unit of the mission, only on the mission branch
// zana/<missionId> of the mission repository; everything else (merge, author
// reviews, default branch, .github/workflows, deleting branches or repos,
// settings, unclassified tools) is denied with a readable reason.
// Branch/path rules adapted from panter-ai@1a99048
// src/core/github-workforce.ts (own branch only, never default or CI files).
import {readFileSync} from 'node:fs';
import {validRefName} from './github-api.mjs';
import {checksForRepo} from './checks-policy.mjs';

export const CATALOG=JSON.parse(readFileSync(new URL('../data/github-mcp-tools.json',import.meta.url),'utf8'));
export const WRITE_RULES=Object.freeze(['branch','file','files','pr-create','pr-edit','pr-title','pr-body',
  'pr-reply','pr-comment','checks-dispatch']);

export const missionBranch=missionId=>'zana/'+missionId;
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();

// A file path the author may change: relative, no traversal, never under
// .github/workflows and never inside a .git directory.
export function safeRepoPath(path){
  // No backslash, URL syntax (% ? #) or control characters: the downstream may
  // decode or reinterpret them (%2e%2e, %2F, a query string).
  if(typeof path!=='string'||!path||path.length>400||path.startsWith('/')||path.endsWith('/')||
     /[\\%?#\u0000-\u001f\u007f]/.test(path))return false;
  const parts=path.split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'))return false;
  const lower=parts.map(p=>p.normalize('NFKC').toLowerCase().replace(/[\s.]+$/,''));
  if(lower[0]==='.github'&&lower[1]==='workflows')return false;
  return !lower.includes('.git');
}

// Every catalog entry must be classified; a write must name a known rule.
export function catalogProblems(catalog=CATALOG){
  const problems=[];
  for(const [name,t] of Object.entries(catalog.tools)){
    if(!['read','write','deny'].includes(t.zana))problems.push(name+': unclassified');
    if(t.zana==='read'&&t.readOnlyHint!==true)problems.push(name+': read without readOnlyHint');
    if(t.zana==='write'&&!WRITE_RULES.includes(t.rule))problems.push(name+': unknown write rule '+t.rule);
    if(t.zana==='write'&&!Object.hasOwn(ALLOWED_KEYS,name))problems.push(name+': write without ALLOWED_KEYS');
    if(t.zana==='deny'&&!t.reason)problems.push(name+': deny without reason');
  }
  return problems;
}
// Tools the live server lists that the catalog cannot classify safely.
export function liveProblems(tools,catalog=CATALOG){
  return tools.flatMap(t=>{
    const entry=catalog.tools[t.name];
    if(!entry)return [{tool:t.name,cls:t.cls,problem:'UNCLASSIFIED'}];
    if(entry.zana==='read'&&t.cls!=='read')return [{tool:t.name,cls:t.cls,problem:'CLASSIFICATION_DRIFT'}];
    return [];
  });
}

const deny=(code,reason)=>({allowed:false,code,reason:code+': '+reason});
const onlyKeys=(args,allowed)=>Object.keys(args).every(k=>allowed.includes(k));
// Exact argument keys each allowed write may carry (from the v2.1.0 schemas,
// minus the ones the policy does not allow: reactions, reviewers, symlink
// writes, workflow inputs, state/base/draft changes).
export const ALLOWED_KEYS=Object.freeze({
  create_branch:['owner','repo','branch','from_branch'],
  create_or_update_file:['owner','repo','path','content','message','branch','sha'],
  delete_file:['owner','repo','path','message','branch'],
  push_files:['owner','repo','branch','files','message'],
  create_pull_request:['owner','repo','title','head','base','body','draft'],
  update_pull_request:['owner','repo','pullNumber','title','body'],
  update_pull_request_title:['owner','repo','pullNumber','title'],
  update_pull_request_body:['owner','repo','pullNumber','body'],
  add_reply_to_pull_request_comment:['owner','repo','pullNumber','commentId','body'],
  add_issue_comment:['owner','repo','issue_number','body'],
  actions_run_trigger:['owner','repo','method','workflow_id','ref'],
});

// deps.missionContext(missionId,sessionId) -> {missionId,status,repo,base,branch,
//   runningForSession,reviewer} or throws; deps.github is the author REST client.
export function createGitHubPolicy({deps,config,catalog=CATALOG}){
  async function pullOfMission(ctx,number){
    if(!Number.isSafeInteger(number)||number<1)return 'pull request number required';
    const pull=await deps.github.pull(ctx.repo,number);
    if(pull?.state!=='open')return 'pull request #'+number+' is not open';
    if(pull?.head?.ref!==ctx.branch||!same(pull?.head?.repo?.full_name,ctx.repo))
      return 'pull request #'+number+' does not come from the mission branch '+ctx.branch;
    if(pull?.base?.ref!==ctx.base)return 'pull request #'+number+' does not target the mission base '+ctx.base;
    return null;
  }
  async function notDefault(ctx){
    const repo=await deps.github.repo(ctx.repo);
    return repo?.default_branch===ctx.branch?'the mission branch is the default branch':null;
  }
  async function rule(name,args,ctx){
    switch(name){
      case 'branch':
        if(args.branch!==ctx.branch)return deny('OUTSIDE_MISSION_BRANCH','branch must be exactly '+ctx.branch);
        if(args.from_branch!==ctx.base)return deny('WRONG_BASE','from_branch must be the mission base '+ctx.base);
        return null;
      case 'file':
        if(args.branch!==ctx.branch)return deny('OUTSIDE_MISSION_BRANCH','writes only on '+ctx.branch);
        if(!safeRepoPath(args.path))return deny('PROTECTED_PATH','path '+JSON.stringify(String(args.path).slice(0,120))+' is outside the allowed surface (.github/workflows, .git or traversal)');
        return null;
      case 'files':
        if(args.branch!==ctx.branch)return deny('OUTSIDE_MISSION_BRANCH','writes only on '+ctx.branch);
        if(!Array.isArray(args.files)||!args.files.length||args.files.length>100)
          return deny('INVALID_FILES','files must list 1-100 entries');
        for(const f of args.files){
          if(!f||typeof f!=='object'||!onlyKeys(f,['path','content']))return deny('FIELD_NOT_ALLOWED','each file has only path and content');
          if(!safeRepoPath(f.path))
          return deny('PROTECTED_PATH','path '+JSON.stringify(String(f?.path).slice(0,120))+' is outside the allowed surface (.github/workflows, .git or traversal)');
        }
        return null;
      case 'pr-create':{
        // Exact branch; only the owner prefix compares case-insensitively.
        const head=String(args.head??'');
        const i=head.indexOf(':');
        const branch=i<0?head:head.slice(i+1),owner=i<0?null:head.slice(0,i);
        if(branch!==ctx.branch||(owner!==null&&!same(owner,ctx.repo.split('/')[0])))
          return deny('OUTSIDE_MISSION_BRANCH','head must be exactly '+ctx.branch);
        if(args.base!==ctx.base)return deny('WRONG_BASE','base must be '+ctx.base);
        // Un borrador no se puede mergear y esta política no permite sacarlo de ahí.
        if(args.draft!==undefined&&args.draft!==false)
          return deny('DRAFT_NOT_ALLOWED','abre el PR listo para revisión (sin draft): un borrador no se puede mergear y ZanaLLaima no puede cambiar ese estado');
        return null;
      }
      case 'pr-edit':
        if(args.title===undefined&&args.body===undefined)return deny('FIELD_NOT_ALLOWED','nothing to change');
        return pullDenied(await pullOfMission(ctx,args.pullNumber));
      case 'pr-title':case 'pr-body':
        return pullDenied(await pullOfMission(ctx,args.pullNumber));
      case 'pr-reply':{
        if(args.reaction!==undefined||typeof args.body!=='string'||!args.body)
          return deny('FIELD_NOT_ALLOWED','only a text reply is allowed (no reactions)');
        const bad=await pullOfMission(ctx,args.pullNumber);
        if(bad)return pullDenied(bad);
        const comment=await deps.github.pullComment(ctx.repo,args.commentId);
        if(!String(comment?.pull_request_url??'').endsWith('/pulls/'+args.pullNumber))
          return deny('OUTSIDE_MISSION_PR','comment '+args.commentId+' does not belong to the mission pull request');
        return null;
      }
      case 'pr-comment':
        if(args.reaction!==undefined||args.comment_id!==undefined||typeof args.body!=='string'||!args.body)
          return deny('FIELD_NOT_ALLOWED','only a text comment on the mission pull request is allowed');
        return pullDenied(await pullOfMission(ctx,args.issue_number));
      case 'checks-dispatch':
        if(args.method!=='run_workflow')return deny('METHOD_NOT_ALLOWED','only run_workflow of the checks workflow is allowed');
        const workflow=checksForRepo(config,ctx.repo).workflow;
        if(args.workflow_id!==workflow)return deny('WORKFLOW_NOT_ALLOWED','only '+workflow+' may be dispatched');
        if(args.ref!==ctx.branch)return deny('OUTSIDE_MISSION_BRANCH','ref must be '+ctx.branch);
        return null;
      default:
        return deny('UNCLASSIFIED','unknown write rule '+name);
    }
  }
  const pullDenied=message=>message?deny('OUTSIDE_MISSION_PR',message):null;
  return async function githubPolicy({caller,tool,args,cls,missionId}){
    const entry=catalog.tools[tool];
    if(!entry)return deny('UNCLASSIFIED',tool+' is not classified in data/github-mcp-tools.json ('+catalog.version+'); denied');
    if(entry.zana==='read'){
      if(cls!=='read')return deny('CLASSIFICATION_DRIFT',tool+' no longer declares readOnlyHint; denied until reclassified');
      return {allowed:true,detail:{class:'read'}};
    }
    if(entry.zana==='deny')return deny('ALWAYS_DENIED',entry.reason);
    // Fail closed: a write the policy has no exact argument keys for is denied.
    if(!Object.hasOwn(ALLOWED_KEYS,tool))return deny('UNCLASSIFIED',tool+' has no ALLOWED_KEYS entry; denied');
    if(typeof missionId!=='string'||!missionId)return deny('MISSION_REQUIRED','writes must name their missionId');
    if(!args||typeof args!=='object'||Array.isArray(args))return deny('INVALID_ARGUMENTS','arguments must be an object');
    const ctx=await deps.missionContext(missionId,caller.sessionId);
    if(!ctx)return deny('UNKNOWN_MISSION','no active remote mission '+missionId);
    if(ctx.status!=='ACTIVE')return deny('MISSION_NOT_ACTIVE','mission '+missionId+' is '+ctx.status);
    if(ctx.reviewer)return deny('REVIEWER_READ_ONLY','this session reviews mission '+missionId+' and cannot write in it');
    if(!ctx.runningForSession)return deny('NO_RUNNING_UNIT','this session holds no RUNNING unit of mission '+missionId);
    if(!same(args.owner,ctx.repo.split('/')[0])||!same(args.repo,ctx.repo.split('/')[1]))
      return deny('OUTSIDE_MISSION_REPO','writes only in '+ctx.repo);
    if(!validRefName(ctx.branch))return deny('OUTSIDE_MISSION_BRANCH','invalid mission branch');
    const keys=ALLOWED_KEYS[tool];
    if(keys&&!onlyKeys(args,keys)){
      const extra=Object.keys(args).filter(k=>!keys.includes(k));
      return deny('FIELD_NOT_ALLOWED',tool+' does not accept '+extra.join(', ')+' through ZanaLLaima (allowed: '+keys.join(', ')+')');
    }
    const refused=await rule(entry.rule,args,ctx);
    if(refused)return refused;
    if(['branch','file','files','checks-dispatch'].includes(entry.rule)){
      const isDefault=await notDefault(ctx);
      if(isDefault)return deny('DEFAULT_BRANCH',isDefault);
    }
    return {allowed:true,detail:{class:'write',rule:entry.rule,missionId}};
  };
}
