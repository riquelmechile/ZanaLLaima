// Remote-mode configuration from the server environment. Fails closed on
// anything unclear. Secrets are referenced by variable name only; their values
// stay in the environment file outside the repository.
import {validRepo,validRefName} from './github-api.mjs';
import {allowedUrl} from './downstream.mjs';

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
  const reviewerLogin=env.ZANA_REVIEWER_LOGIN||'sebastianriquelme95-max';
  if(!LOGIN.test(reviewerLogin))throw new Error('ZANA_REVIEWER_LOGIN is not a GitHub login');
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
  const apiUrl=env.ZANA_GITHUB_API_URL||'https://api.github.com';
  if(!allowedUrl(apiUrl))throw new Error('ZANA_GITHUB_API_URL must be https (or http to a private address)');
  return Object.freeze({repos,reviewerLogin,checksWorkflow,requiredChecks,mergeEnabled:merge==='true',mergeMethod,
    ticketTtlMinutes:int(env.ZANA_TICKET_TTL_MINUTES,120,5,1440,'ZANA_TICKET_TTL_MINUTES'),
    apiUrl,downstreamUrl,toolsets,
    downstreamTimeoutMs:int(env.ZANA_DOWNSTREAM_TIMEOUT_MS,30000,1000,300000,'ZANA_DOWNSTREAM_TIMEOUT_MS'),
    authorToken:env.ZANA_DOWNSTREAM_GITHUB_TOKEN||null,reviewerToken:env.ZANA_REVIEWER_TOKEN||null});
}
export const repoAllowed=(config,repo)=>config.repos.some(r=>r.toLowerCase()===String(repo).toLowerCase());
export {validRefName};
