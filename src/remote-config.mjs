// Remote-mode configuration from the server environment. Fails closed on
// anything unclear. Secrets are referenced by variable name only; their values
// stay in the environment file outside the repository.
import {validRepo,validRefName} from './github-api.mjs';
import {allowedUrl} from './downstream.mjs';
import {parseRepoChecks} from './checks-policy.mjs';

const LOGIN=/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const list=v=>String(v??'').split(',').map(x=>x.trim()).filter(Boolean);
const int=(v,def,min,max,name)=>{
  if(v===undefined||v==='')return def;
  const n=Number(v);
  if(!Number.isInteger(n)||n<min||n>max)throw new Error(name+' must be an integer '+min+'-'+max);
  return n;
};

export function remoteConfig(env=process.env){
  const repos=list(env.ZANA_GITHUB_REPOS);
  for(const r of repos)if(!validRepo(r))throw new Error('ZANA_GITHUB_REPOS has an invalid repository: '+r);
  // No default: the reviewer account is the operator's own and is set only in
  // the server env. Missing → null: the server refuses to start, /health is
  // degraded and delivery is never ready; read-only operator CLI still works.
  const reviewerLogin=String(env.ZANA_REVIEWER_LOGIN??'').trim()||null;
  if(reviewerLogin&&!LOGIN.test(reviewerLogin))throw new Error('ZANA_REVIEWER_LOGIN is not a GitHub login');
  const checksWorkflow=env.ZANA_CHECKS_WORKFLOW||'zana-checks.yml';
  if(!/^[A-Za-z0-9._-]{1,100}\.ya?ml$/.test(checksWorkflow))throw new Error('ZANA_CHECKS_WORKFLOW must be a workflow file name');
  const merge=env.ZANA_MERGE_ENABLED??'true';
  if(!['true','false'].includes(merge))throw new Error('ZANA_MERGE_ENABLED must be true or false');
  const mergeMethod=env.ZANA_MERGE_METHOD||'squash';
  if(!['squash','merge','rebase'].includes(mergeMethod))throw new Error('ZANA_MERGE_METHOD must be squash, merge or rebase');
  const downstreamUrl=env.ZANA_DOWNSTREAM_GITHUB_URL||'https://api.githubcopilot.com/mcp/';
  if(!allowedUrl(downstreamUrl))throw new Error('ZANA_DOWNSTREAM_GITHUB_URL must be https (or http to a private address)');
  const toolsets=env.ZANA_DOWNSTREAM_GITHUB_TOOLSETS||'context,repos,pull_requests,git,actions';
  if(!/^[a-z_]+(,[a-z_]+)*$/.test(toolsets))throw new Error('ZANA_DOWNSTREAM_GITHUB_TOOLSETS must be a comma list');
  const requiredChecks=list(env.ZANA_REQUIRED_CHECKS);
  if(requiredChecks.some(x=>x.length>120))throw new Error('ZANA_REQUIRED_CHECKS names too long');
  const repoChecks=parseRepoChecks(env.ZANA_REPO_CHECKS_JSON,repos);
  const apiUrl=env.ZANA_GITHUB_API_URL||'https://api.github.com';
  if(!allowedUrl(apiUrl))throw new Error('ZANA_GITHUB_API_URL must be https (or http to a private address)');
  const distinct=env.ZANA_DISTINCT_REVIEWER_CLIENT??'false';
  if(!['true','false'].includes(distinct))throw new Error('ZANA_DISTINCT_REVIEWER_CLIENT must be true or false');
  return Object.freeze({repos,reviewerLogin,distinctReviewerClient:distinct==='true',
    claimTtlMinutes:int(env.ZANA_TICKET_CLAIM_TTL_MINUTES,240,10,10080,'ZANA_TICKET_CLAIM_TTL_MINUTES'),
    toolDeadlineMs:int(env.ZANA_TOOL_DEADLINE_MS,45000,5000,300000,'ZANA_TOOL_DEADLINE_MS'),checksWorkflow,requiredChecks,repoChecks,mergeEnabled:merge==='true',mergeMethod,
    ticketTtlMinutes:int(env.ZANA_TICKET_TTL_MINUTES,120,5,1440,'ZANA_TICKET_TTL_MINUTES'),
    reviewMaxDiffBytes:int(env.ZANA_REVIEW_MAX_DIFF_BYTES,1_800_000,100_000,1_900_000,'ZANA_REVIEW_MAX_DIFF_BYTES'),
    prLineBudget:int(env.ZANA_PR_LINE_BUDGET,400,50,5000,'ZANA_PR_LINE_BUDGET'),
    apiUrl,downstreamUrl,toolsets,
    downstreamTimeoutMs:int(env.ZANA_DOWNSTREAM_TIMEOUT_MS,30000,1000,300000,'ZANA_DOWNSTREAM_TIMEOUT_MS'),
    authorToken:env.ZANA_DOWNSTREAM_GITHUB_TOKEN||null,reviewerToken:env.ZANA_REVIEWER_TOKEN||null});
}
export const repoAllowed=(config,repo)=>config.repos.some(r=>r.toLowerCase()===String(repo).toLowerCase());
export {validRefName};
