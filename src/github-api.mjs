// Minimal GitHub REST client for remote mode. One instance per token (author
// or reviewer); the token never leaves this module except in the
// Authorization header sent to the configured API origin.
// Request discipline adapted from panter-ai@1a99048
// src/core/github-delivery.ts and src/core/github-workforce.ts (pinned origin,
// no redirects, bounded responses, repository path checks).
import {clean,redactText} from './redact.mjs';

export const REPO=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA=/^[0-9a-f]{40}$/;
const MAX_BYTES=2_000_000;
const REF_SEGMENT=/^[A-Za-z0-9._@+=,-]{1,200}$/;

// Circuit breaker shared by every client of one API origin (author and
// reviewer): consecutive network errors, 5xx or 429 open it for OPEN_MS and
// calls then fail fast instead of piling up behind a slow GitHub.
const BREAKERS=new Map();
const FAILURES_TO_OPEN=5,OPEN_MS=30_000;
export function breakerFor(origin){
  if(!BREAKERS.has(origin))BREAKERS.set(origin,{failures:0,openUntil:0});
  return BREAKERS.get(origin);
}
export class GitHubApiError extends Error{
  // codes: the errors[].code of GitHub's answer (for example too_large).
  constructor(status,message,codes=[]){super(message);this.name='GitHubApiError';this.status=status;this.codes=codes;}
}
export function validRepo(repo){
  return typeof repo==='string'&&REPO.test(repo)&&!repo.split('/').some(p=>p==='.'||p==='..');
}
// Una entrada de la lista de repos permitidos: `owner/repo` exacto u `owner/*`
// (todos los repos de esa cuenta). No hay `*`, `*/*` ni prefijos: el comodín
// solo vale como nombre completo del repo y la cuenta va nombrada con un login de GitHub válido.
// Los logins con `_` (cuentas administradas por una empresa) no calzan: esas
// cuentas nombran sus repos uno por uno.
export const LOGIN=/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
export function validRepoPattern(pattern){
  if(typeof pattern!=='string')return false;
  return pattern.endsWith('/*')?LOGIN.test(pattern.slice(0,-2)):validRepo(pattern);
}
// ¿Algún patrón de la lista cubre este repo? El repo tiene que ser un
// `owner/repo` válido por sí mismo; la comparación no distingue mayúsculas.
// Un patrón que no pasa validRepoPattern no cubre nada: ambos lados son ASCII
// antes de pasar a minúsculas, así que el plegado Unicode no entra en juego.
export function repoMatches(patterns,repo){
  if(!Array.isArray(patterns)||!validRepo(repo))return false;
  const name=repo.toLowerCase(),owner=name.slice(0,name.indexOf('/')+1);
  return patterns.some(p=>{
    if(!validRepoPattern(p))return false;
    const q=p.toLowerCase();
    return q.endsWith('/*')?q.slice(0,-1)===owner:q===name;
  });
}
// A git branch name per check-ref-format, without anything a URL parser could
// reinterpret. Copied from panter-ai github-workforce.ts validRefName.
export function validRefName(name){
  if(typeof name!=='string'||!name||name.length>200||name.endsWith('/')||name.startsWith('/')||
     name.includes('//')||name.includes('@{')||name==='@')return false;
  return name.split('/').every(c=>REF_SEGMENT.test(c)&&!c.startsWith('.')&&!c.endsWith('.')&&
    !c.endsWith('.lock')&&!c.includes('..'));
}
const refPath=name=>name.split('/').map(encodeURIComponent).join('/');
const repoPath=repo=>{
  if(!validRepo(repo))throw new GitHubApiError(400,'Invalid repository name');
  return '/repos/'+repo.split('/').map(encodeURIComponent).join('/');
};
const positive=n=>{if(!Number.isSafeInteger(n)||n<1)throw new GitHubApiError(400,'Invalid number');return n;};
const sha=s=>{if(!SHA.test(String(s)))throw new GitHubApiError(400,'Invalid commit SHA');return s;};

export class GitHubApi{
  constructor({baseUrl='https://api.github.com',token,fetcher=globalThis.fetch,timeoutMs=15000}={}){
    const url=new URL(baseUrl);
    if(url.username||url.password||url.search||url.hash||!['https:','http:'].includes(url.protocol))
      throw new Error('Invalid GitHub API URL');
    this.origin=url.origin+url.pathname.replace(/\/$/,'');
    this.token=token||null;
    this.fetcher=fetcher;
    this.timeoutMs=timeoutMs;
  }
  get configured(){return Boolean(this.token);}
  secrets(){return this.token?[this.token]:[];}
  async request(method,path,{body,accept='application/vnd.github+json',raw=false}={}){
    if(!this.token)throw new GitHubApiError(503,'GitHub token not configured on the server');
    const breaker=breakerFor(this.origin);
    if(Date.now()<breaker.openUntil)
      throw new GitHubApiError(503,'GitHub REST circuit open until '+new Date(breaker.openUntil).toISOString()+' after '+breaker.failures+' failures');
    const failed=()=>{breaker.failures++;if(breaker.failures>=FAILURES_TO_OPEN)breaker.openUntil=Date.now()+OPEN_MS;};
    let res;
    try{
      res=await this.fetcher(this.origin+path,{method,redirect:'error',
        signal:AbortSignal.timeout(this.timeoutMs),
        headers:{accept,'x-github-api-version':'2022-11-28','user-agent':'zana-llaima',
          authorization:'Bearer '+this.token,
          ...(body!==undefined?{'content-type':'application/json'}:{})},
        ...(body!==undefined?{body:JSON.stringify(body)}:{})});
    }catch(error){failed();throw new GitHubApiError(502,'GitHub unreachable: '+clean(error,this.secrets()));}
    const text=await res.text();
    // 5xx, 429 and a rate-limit 403 (primary or secondary) count; any other answer closes it.
    const rateLimited=res.status===403&&(res.headers.get('x-ratelimit-remaining')==='0'||res.headers.has('retry-after')||/rate limit/i.test(text));
    if(res.status>=500||res.status===429||rateLimited)failed();else{breaker.failures=0;breaker.openUntil=0;}
    if(text.length>MAX_BYTES)throw new GitHubApiError(502,'GitHub response too large');
    if(!res.ok){
      let message='',codes=[];
      try{
        const data=JSON.parse(text),errors=Array.isArray(data.errors)?data.errors:[];
        codes=errors.map(e=>String(e?.code));
        // GitHub pone el motivo concreto (por ejemplo, nombre ocupado) en errors[].message.
        const why=errors.map(e=>typeof e?.message==='string'?e.message:'').filter(Boolean).join('; ').slice(0,300);
        message=String(data.message??'')+(why?' ('+why+')':'');
      }catch{message='';}
      throw new GitHubApiError(res.status,'GitHub HTTP '+res.status+(message?': '+clean(message,this.secrets()):''),codes);
    }
    // 'measured' also returns the size of what GitHub sent, before redaction.
    if(raw==='measured')return {text:redactText(text,this.secrets()),bytes:Buffer.byteLength(text,'utf8')};
    if(raw)return redactText(text,this.secrets());
    if(!text)return null;
    try{return JSON.parse(text);}catch{throw new GitHubApiError(502,'GitHub answered without JSON');}
  }
  async repo(repo){return this.request('GET',repoPath(repo));}
  // A small JSON file of the repository at ref (≤4 KB): null if absent (404),
  // INVALID_JSON_FILE if it is not a file, is larger or does not parse.
  async fileJson(repo,path,ref){
    if(typeof path!=='string'||!/^[A-Za-z0-9._-]{1,100}(?:\/[A-Za-z0-9._-]{1,100}){0,9}$/.test(path)||
       path.split('/').some(p=>p==='.'||p==='..')||!validRefName(ref))throw new GitHubApiError(400,'Invalid path or ref');
    let data;
    try{data=await this.request('GET',repoPath(repo)+'/contents/'+refPath(path)+'?ref='+encodeURIComponent(ref));}
    catch(error){if(error.status===404)return null;throw error;}
    if(data?.type!=='file'||data.encoding!=='base64'||typeof data.content!=='string'||!(data.size<=4096))
      throw new GitHubApiError(422,'INVALID_JSON_FILE: '+path+' is not a base64 file of at most 4 KB');
    try{return JSON.parse(Buffer.from(data.content,'base64').toString('utf8'));}
    catch{throw new GitHubApiError(422,'INVALID_JSON_FILE: '+path+' is not valid JSON');}
  }
  async branchHead(repo,branch){
    if(!validRefName(branch))throw new GitHubApiError(400,'Invalid branch name');
    const data=await this.request('GET',repoPath(repo)+'/branches/'+refPath(branch));
    return sha(data?.commit?.sha);
  }
  async pull(repo,number){return this.request('GET',repoPath(repo)+'/pulls/'+positive(number));}
  async pullDiff(repo,number){
    return this.request('GET',repoPath(repo)+'/pulls/'+positive(number),{accept:'application/vnd.github.diff',raw:true});
  }
  // The redacted diff of exactly base...commit (three dots, like a pull request),
  // so a ticket's pages never change while its SHA does not, plus its real size:
  // limits are checked on what GitHub sent.
  async compareDiffMeasured(repo,base,commit){
    if(!validRefName(base))throw new GitHubApiError(400,'Invalid base');
    return this.request('GET',repoPath(repo)+'/compare/'+refPath(base)+'...'+sha(commit),
      {accept:'application/vnd.github.diff',raw:'measured'});
  }
  // Merge-base SHA of base...commit: the base the diff is computed against.
  async mergeBase(repo,base,commit){
    if(!validRefName(base))throw new GitHubApiError(400,'Invalid base');
    return sha((await this.request('GET',repoPath(repo)+'/compare/'+refPath(base)+'...'+sha(commit)+'?per_page=1'))?.merge_base_commit?.sha);
  }
  // Archivos cambiados entre dos commits (compare JSON; per_page=1 recorta los commits,
  // no los archivos). GitHub entrega a lo más 300: con 300 o más la lista queda truncated.
  async compareFiles(repo,from,commit){
    const data=await this.request('GET',repoPath(repo)+'/compare/'+sha(from)+'...'+sha(commit)+'?per_page=1');
    if(!Array.isArray(data?.files))throw new GitHubApiError(502,'Unreadable compare file list');
    const files=data.files.map(f=>({filename:String(f?.filename??''),additions:Number(f?.additions)||0,
      deletions:Number(f?.deletions)||0,status:String(f?.status??''),
      ...(f?.previous_filename?{previousFilename:String(f.previous_filename)}:{})}));
    return Object.assign(files,{status:String(data.status??''),...(files.length>=300?{truncated:true}:{})});
  }
  async openPullsFor(repo,branch){
    const owner=repo.split('/')[0];
    const list=await this.request('GET',repoPath(repo)+'/pulls?state=open&per_page=100&head='+
      encodeURIComponent(owner+':'+branch));
    return Array.isArray(list)?list:[];
  }
  async pullCommits(repo,number){
    const out=[];
    for(let page=1;page<=3;page++){
      const data=await this.request('GET',repoPath(repo)+'/pulls/'+positive(number)+'/commits?per_page=100&page='+page);
      if(!Array.isArray(data))throw new GitHubApiError(502,'Unreadable commit list');
      out.push(...data);
      if(data.length<100)return out;
    }
    throw new GitHubApiError(502,'Pull request has more than 300 commits; authorship cannot be verified');
  }
  // Hasta 30 páginas (3000 archivos, el máximo de GitHub); con la última llena
  // la lista queda truncated y el presupuesto de líneas la trata como over.
  async pullFiles(repo,number){
    const out=[];
    for(let page=1;page<=30;page++){
      const data=await this.request('GET',repoPath(repo)+'/pulls/'+positive(number)+'/files?per_page=100&page='+page);
      if(!Array.isArray(data))throw new GitHubApiError(502,'Unreadable file list');
      out.push(...data.map(f=>({filename:String(f?.filename??''),additions:Number(f?.additions)||0,
        deletions:Number(f?.deletions)||0,status:String(f?.status??''),
        ...(f?.previous_filename?{previousFilename:String(f.previous_filename)}:{})})));
      if(data.length<100)return out;
    }
    return Object.assign(out,{truncated:true});
  }
  async pullReviews(repo,number){
    const out=[];
    for(let page=1;page<=10;page++){
      const data=await this.request('GET',repoPath(repo)+'/pulls/'+positive(number)+'/reviews?per_page=100&page='+page);
      if(!Array.isArray(data))throw new GitHubApiError(502,'Unreadable review list');
      out.push(...data);
      if(data.length<100)return out;
    }
    throw new GitHubApiError(502,'Review list over the 10-page safety limit');
  }
  async pullComment(repo,id){return this.request('GET',repoPath(repo)+'/pulls/comments/'+positive(id));}
  async checkRuns(repo,commit){
    const data=await this.request('GET',repoPath(repo)+'/commits/'+sha(commit)+'/check-runs?per_page=100');
    if(Number(data?.total_count)>100)throw new GitHubApiError(502,'More than 100 check runs; full proof unavailable');
    return Array.isArray(data?.check_runs)?data.check_runs:[];
  }
  async statuses(repo,commit){
    const data=await this.request('GET',repoPath(repo)+'/commits/'+sha(commit)+'/statuses?per_page=100');
    return Array.isArray(data)?data:[];
  }
  async workflowRuns(repo,commit){
    const data=await this.request('GET',repoPath(repo)+'/actions/runs?per_page=50&head_sha='+sha(commit));
    return Array.isArray(data?.workflow_runs)?data.workflow_runs:[];
  }
  async runJobs(repo,runId){
    const data=await this.request('GET',repoPath(repo)+'/actions/runs/'+positive(runId)+'/jobs?per_page=100');
    return Array.isArray(data?.jobs)?data.jobs:[];
  }
  async dispatchWorkflow(repo,workflow,ref){
    if(!/^[A-Za-z0-9._-]{1,100}$/.test(workflow)||!validRefName(ref))
      throw new GitHubApiError(400,'Invalid workflow or ref');
    return this.request('POST',repoPath(repo)+'/actions/workflows/'+encodeURIComponent(workflow)+'/dispatches',
      {body:{ref}});
  }
  async jobLogTail(repo,jobId,lines=60){
    // The logs endpoint redirects to a short-lived storage URL. Follow it
    // without the Authorization header.
    const path=repoPath(repo)+'/actions/jobs/'+positive(jobId)+'/logs';
    let res;
    try{
      res=await this.fetcher(this.origin+path,{redirect:'manual',signal:AbortSignal.timeout(this.timeoutMs),
        headers:{authorization:'Bearer '+this.token,'x-github-api-version':'2022-11-28','user-agent':'zana-llaima'}});
      if(res.status>=300&&res.status<400){
        const location=res.headers.get('location');
        if(!location||!/^https:\/\//.test(location))throw new Error('log redirect refused');
        res=await this.fetcher(location,{redirect:'error',signal:AbortSignal.timeout(this.timeoutMs)});
      }
    }catch(error){throw new GitHubApiError(502,'Job log unavailable: '+clean(error,this.secrets()));}
    if(!res.ok)throw new GitHubApiError(res.status,'Job log unavailable (HTTP '+res.status+')');
    const text=(await res.text()).slice(-200_000);
    return text.replace(/\x1b\[[0-9;]*m/g,'').split(/\r?\n/).filter(Boolean).slice(-lines)
      .map(line=>redactText(line,this.secrets()).slice(0,400));
  }
  async createReview(repo,number,{commitId,event,body}){
    return this.request('POST',repoPath(repo)+'/pulls/'+positive(number)+'/reviews',
      {body:{commit_id:sha(commitId),event,body}});
  }
  async createStatus(repo,commit,{state,description,context='zana/4r'}){
    return this.request('POST',repoPath(repo)+'/statuses/'+sha(commit),{body:{state,description,context}});
  }
  async merge(repo,number,{headSha,method}){
    return this.request('PUT',repoPath(repo)+'/pulls/'+positive(number)+'/merge',
      {body:{sha:sha(headSha),merge_method:method}});
  }
}
