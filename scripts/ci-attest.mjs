#!/usr/bin/env node
import {createPrivateKey,sign} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
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

export function githubRunContext(env=process.env){
  ensure(env.GITHUB_REPOSITORY==='riquelmechile/ZanaLLaima',
    'Unexpected GitHub repository');
  ensure(typeof env.GITHUB_EVENT_PATH==='string','Missing GITHUB_EVENT_PATH');
  const event=JSON.parse(readFileSync(env.GITHUB_EVENT_PATH,'utf8'));
  const eventName=env.GITHUB_EVENT_NAME;
  const runId=Number(env.GITHUB_RUN_ID);
  const observed=git('rev-parse','HEAD');
  const treeSha=git('rev-parse','HEAD^{tree}');
  let candidateSha,baseSha,branchRef,targetRef;
  if(eventName==='pull_request'){
    ensure(event.pull_request?.head?.repo?.full_name===env.GITHUB_REPOSITORY,
      'Forked or foreign pull requests cannot access signing');
    candidateSha=event.pull_request.head.sha;
    baseSha=event.pull_request.base.sha;
    branchRef='refs/heads/'+event.pull_request.head.ref;
    targetRef='refs/heads/'+event.pull_request.base.ref;
  }else if(eventName==='push'&&env.GITHUB_REF==='refs/heads/main'){
    candidateSha=event.after;
    baseSha=event.after;
    branchRef='refs/heads/main';targetRef='refs/heads/main';
  }else throw Error('CI attestation refused: unsupported event or branch');
  ensure(candidateSha===observed,'Checked-out HEAD differs from GitHub event SHA');
  return buildCiPayload({candidateSha,treeSha,baseSha,branchRef,targetRef,runId});
}

export function main(){
  ensure(typeof process.env.ZANA_CI_SIGNING_KEY==='string'&&
    process.env.ZANA_CI_SIGNING_KEY.trim().length>0,
    'ZANA_CI_SIGNING_KEY is missing; human setup required');
  const payload=githubRunContext();
  const envelope=signCiPayload(payload);
  const root=process.env.RUNNER_TEMP;
  ensure(typeof root==='string'&&root.length>0,'Missing RUNNER_TEMP');
  const path=join(resolve(root),'ci-attestation-'+payload.candidateSha+'.json');
  writeFileSync(path,JSON.stringify(envelope,null,2)+'\n',{mode:0o600,flag:'wx'});
  process.stdout.write('Signed CI receipt written: '+path+'\n');
  return path;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{main();}catch(error){
    console.error(error.message);
    process.exitCode=1;
  }
}
