#!/usr/bin/env node
import {createPrivateKey,sign} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';

const SHA=/^[a-f0-9]{40}$/;
const BRANCH=/^refs\/heads\/[a-zA-Z0-9._/-]{1,200}$/;
const ensure=(test,message)=>{if(!test)throw Error('CI attestation refused: '+message);};
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',
  stdio:['ignore','pipe','pipe'],timeout:10000}).trim();
export function buildCiPayload({candidateSha,treeSha,baseSha,branchRef,targetRef,
  runId,conclusion='success',issuedAt=new Date().toISOString(),
  expiresAt=new Date(Date.now()+30*60000).toISOString()}){
  ensure([candidateSha,treeSha,baseSha].every(v=>typeof v==='string'&&SHA.test(v)),
    'Git object SHAs must be exact lowercase 40-hex');
  ensure(BRANCH.test(branchRef)&&BRANCH.test(targetRef),'Invalid branch refs');
  ensure(Number.isSafeInteger(runId)&&runId>0,'runId must be a positive integer');
  ensure(conclusion==='success','Only completed successful CI can be attested');
  const start=Date.parse(issuedAt),end=Date.parse(expiresAt),now=Date.now();
  ensure(Number.isFinite(start)&&Number.isFinite(end)&&start<=now+60000&&
    start>=now-86400000&&end>now&&end>start&&end-start<=86400000,
    'Invalid or over-24h expiration');
  return {kind:'CI_RESULT',candidateSha,treeSha,baseSha,branchRef,targetRef,
    runId,conclusion,issuedAt,expiresAt};
}

export function signCiPayload(payload,privateKeyPem=process.env.ZANA_CI_SIGNING_KEY){
  ensure(typeof privateKeyPem==='string'&&privateKeyPem.trim().length>0,
    'ZANA_CI_SIGNING_KEY is missing; human setup required');
  const key=createPrivateKey(privateKeyPem);
  ensure(key.asymmetricKeyType==='ed25519','Signing key must be Ed25519');
  return {payload,signature:sign(null,Buffer.from(JSON.stringify(payload),'utf8'),key).toString('base64')};
}

// Trusted signer: workflow_run runs in main context, never in a PR checkout.
const REPO='riquelmechile/ZanaLLaima';
async function githubGet(path,env=process.env){
  ensure(typeof env.GITHUB_TOKEN==='string'&&env.GITHUB_TOKEN.length>0,'Missing GitHub API token');
  const response=await fetch('https://api.github.com'+path,{
    headers:{Authorization:'Bearer '+env.GITHUB_TOKEN,
      Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}
  });
  ensure(response.ok,'GitHub API rejected source run: '+response.status);
  return response.json();
}
export async function githubRunContext(env=process.env,api=path=>githubGet(path,env)){
  ensure(env.GITHUB_REPOSITORY===REPO,'Unexpected repository');
  ensure(env.GITHUB_EVENT_NAME==='workflow_run'&&env.GITHUB_REF==='refs/heads/main',
    'Signing is restricted to trusted main workflow_run');
  ensure(typeof env.GITHUB_EVENT_PATH==='string','Missing event path');
  const event=JSON.parse(readFileSync(env.GITHUB_EVENT_PATH,'utf8'));
  const source=event.workflow_run;
  ensure(Number.isSafeInteger(source?.id)&&source.id>0,'Missing source CI run ID');
  const run=await api('/repos/'+REPO+'/actions/runs/'+source.id);
  ensure(run.id===source.id&&run.head_sha===source.head_sha&&
    run.status==='completed'&&run.conclusion==='success',
    'Source CI run incomplete or failed');
  ensure(run.head_repository?.full_name===REPO&&run.repository?.full_name===REPO,
    'Foreign CI run');
  ensure(/^\.github\/workflows\/ci\.yml(?:@refs\/heads\/[a-zA-Z0-9._/-]+)?$/.test(run.path),
    'Source workflow not CI');
  ensure(['pull_request','push'].includes(run.event),'Unsupported source event');
  const candidateSha=run.head_sha;
  ensure(SHA.test(candidateSha),'Invalid candidate SHA');
  const jobs=await api('/repos/'+REPO+'/actions/runs/'+run.id+'/jobs?per_page=100');
  const expected=['test (Node 22.16.0)','test (Node 22.23.4)','test (Node 24)'];
  ensure(jobs.total_count===3&&Array.isArray(jobs.jobs)&&expected.every(name=>
    jobs.jobs.filter(j=>j.name===name&&j.status==='completed'&&j.conclusion==='success').length===1),
    'Required CI matrix did not pass');
  const full=jobs.jobs.find(j=>j.name==='test (Node 22.23.4)');
  const passed=new Set((full.steps||[]).filter(x=>x.conclusion==='success').map(x=>x.name));
  for(const step of ['Verify exact commit','Deterministic install','Syntax validation',
    'Static security preflight','Unit, integration, and crash tests',
    'Multi-process contention stress','Coverage gate',
    'Phase 4 measured SQLite and scheduler benchmark',
    'Production dependency vulnerability audit']){
    ensure(passed.has(step),'Required CI step missing: '+step);
  }
  // The CI YAML itself must match trusted main bytes, or a malicious PR could
  // replace the entire test workflow with a green no-op.
  const candidateCI=await api('/repos/'+REPO+
    '/contents/.github/workflows/ci.yml?ref='+candidateSha);
  ensure(candidateCI.encoding==='base64'&&
    Buffer.from(candidateCI.content.replace(/\s/g,''),'base64')
      .equals(readFileSync('.github/workflows/ci.yml')),
    'PR modified trusted CI workflow');
  const commit=await api('/repos/'+REPO+'/git/commits/'+candidateSha);
  ensure(SHA.test(commit.tree?.sha),'Missing candidate tree');
  let baseSha,branchRef,targetRef;
  if(run.event==='pull_request'){
    ensure(run.pull_requests?.length===1,'Ambiguous PR source');
    const pr=await api('/repos/'+REPO+'/pulls/'+run.pull_requests[0].number);
    ensure(pr.state==='open'&&pr.head?.repo?.full_name===REPO&&
      pr.head.sha===candidateSha&&pr.base?.ref==='main'&&SHA.test(pr.base.sha),
      'PR moved or has an untrusted source');
    baseSha=pr.base.sha;
    branchRef='refs/heads/'+pr.head.ref;
    targetRef='refs/heads/main';
  }else{
    ensure(run.head_branch==='main','Only main pushes can be signed');
    baseSha=candidateSha;branchRef='refs/heads/main';targetRef=branchRef;
  }
  return buildCiPayload({candidateSha,treeSha:commit.tree.sha,baseSha,
    branchRef,targetRef,runId:run.id});
}
export async function main(){
  ensure(process.env.ZANA_CI_SIGNING_KEY?.trim().length>0,'Missing CI signing key');
  const payload=await githubRunContext();
  const envelope=signCiPayload(payload);
  ensure(typeof process.env.RUNNER_TEMP==='string'&&process.env.RUNNER_TEMP.length>0,
    'Missing RUNNER_TEMP');
  const output=join(resolve(process.env.RUNNER_TEMP),
    'ci-attestation-'+payload.candidateSha+'.json');
  writeFileSync(output,JSON.stringify(envelope,null,2)+'\n',{mode:0o600,flag:'wx'});
  process.stdout.write('Signed CI receipt written: '+output+'\n');
  return output;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
