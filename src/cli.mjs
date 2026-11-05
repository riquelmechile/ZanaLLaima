#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {operations} from './actions.mjs';
import {applyOperatorAction,storageRestoreAbort,storageCleanupArtifacts,storageAdoptQuarantine,readState} from './store.mjs';

const usage='Commands: remote-serve, remote-enroll, remote-enroll-close, remote-clients, remote-revoke, remote-audit, remote-merge, operator-import, heartbeat, recover-expired, retry, cancel, close, archive, mission-history, authorization-status, storage-status, storage-history, storage-reviews, storage-migrate, storage-backup, storage-restore, storage-restore-abort, storage-cleanup-artifacts, storage-adopt-quarantine, reconcile-view, profile, init, status, next, start, complete, apply-write, review-open, review-next, review-start, review-submit, review-check, review-status, delivery-check';
const readJson=async path=>JSON.parse(await readFile(path,'utf8'));
const readText=async path=>readFile(path,'utf8');
const noArgs=new Set(['status','profile','review-status','review-check','storage-status',
  'storage-migrate','storage-restore-abort','reconcile-view','authorization-status','recover-expired','cancel','close','archive',
  'remote-serve','remote-enroll-close','remote-clients']);

const aliases={
  'review-open':'reviewOpen','review-submit':'reviewSubmit',
  'review-check':'reviewCheckCandidate','review-status':'reviewStatus',
  'review-next':'reviewNext','review-start':'reviewStart',
  'storage-status':'storageStatus','storage-history':'storageHistory',
  'storage-reviews':'storageReviews','storage-migrate':'storageMigrate',
  'storage-backup':'storageBackup','storage-restore':'storageRestore',
  'recover-expired':'recoverExpired','authorization-status':'authorizationStatus',
  'mission-history':'missionHistory','delivery-check':'deliveryCheck',
  'apply-write':'applyWrite',
};

export async function parseCliCommand(command,args=[],{json=readJson,text=readText}={}){
  if(!Array.isArray(args))throw Error(usage);
  let input={};
  if(command==='init')input={spec:await json(args[0])};
  else if(command==='next'||command==='start')input={
    hostReport:args[0]?await json(args[0]):{},
    ...(command==='start'&&args[1]!==undefined?{leaseSeconds:Number(args[1])}:{})
  };
  else if(command==='complete')input={unitId:args[0],token:args[1],
    outcome:await json(args[2]),leaseGeneration:args[3]?Number(args[3]):undefined};
  else if(command==='apply-write')input={
    unitId:args[0],token:args[1],leaseGeneration:Number(args[2]),path:args[3],
    ...(args[4]==='--delete'?{deleteFile:true}:{content:await text(args[4])}),
    ...(args[5]?{expectedPreSha256:args[5]}:{})
  };
  else if(command==='heartbeat')input={unitId:args[0],token:args[1],
    leaseGeneration:Number(args[2]),leaseSeconds:args[3]!==undefined?Number(args[3]):undefined};
  else if(command==='retry')input={unitId:args[0]};
  else if(command==='operator-import')input={envelope:await json(args[0])};
  else if(command==='review-open')input={candidateSha:args[0],
    hostReport:args[1]?await json(args[1]):{},risk:args[2]||'MEDIUM'};
  else if(command==='review-next'||command==='review-start')
    input={hostReport:args[0]?await json(args[0]):undefined};
  else if(command==='delivery-check')input={
    ciEnvelope:args[0]?await json(args[0]):null,
    operatorEnvelope:args[1]?await json(args[1]):null
  };
  else if(command==='review-submit')input={...(await json(args[3])),
    lensId:args[0],token:args[1],candidateSha:args[2]};
  else if(command==='storage-history'||command==='storage-reviews')
    input={limit:args[0]?Number(args[0]):25,before:args[1]?Number(args[1]):null,
      ...(command==='storage-history'&&args[2]?{category:args[2]}:{})};
  else if(command==='mission-history')
    input={limit:args[0]?Number(args[0]):25,before:args[1]?Number(args[1]):null};
  else if(command==='storage-backup')input={destination:args[0]};
  else if(command==='storage-adopt-quarantine'){
    if(args.length<2||args.length>3||args[1]!=='--confirm'||
       (args[2]!==undefined&&args[2]!=='--force-data-loss'))
      throw Error('storage-adopt-quarantine requires <UUID> --confirm [--force-data-loss]');
    input={id:args[0],confirm:true,forceDataLoss:args[2]==='--force-data-loss'};
  }
  else if(command==='storage-cleanup-artifacts'){
    if(args.length!==1||args[0]!=='--confirm')throw Error('storage-cleanup-artifacts requires --confirm');
    input={confirm:true};
  }
  else if(command==='storage-restore'){
    if(args.length>2 || (args[1]!==undefined&&args[1]!=='--force-data-loss'))
      throw Error('Only --force-data-loss is allowed for offline restore');
    input={source:args[0],offline:true,forceDataLoss:args[1]==='--force-data-loss'};
  }
  else if(command==='remote-enroll'){
    const minutes=Number(args[0]);
    if(args.length!==1||!Number.isInteger(minutes)||minutes<1||minutes>60)
      throw Error('remote-enroll requires <minutes> between 1 and 60');
    input={minutes};
  }
  else if(command==='remote-revoke'){
    if(args.length!==1)throw Error('remote-revoke requires <clientId>');
    input={clientId:args[0]};
  }
  else if(command==='remote-merge'){
    if(args.length!==1)throw Error('remote-merge requires <missionId>');
    input={missionId:args[0]};
  }
  else if(command==='remote-audit')
    input={limit:args[0]?Number(args[0]):50,...(args[1]?{missionId:args[1]}:{})};
  else if(!noArgs.has(command))throw Error(usage);
  return {command,action:aliases[command]??command,input};
}

// Operator-only remote commands, run on the server. The OAuth enrollment
// window and client revocation are never exposed as MCP tools.
async function runRemoteCommand({command,input}){
  const {httpSettings,startRemote}=await import('./http.mjs');
  const {setEnrollment,listClients,revokeClient}=await import('./oauth.mjs');
  const db=httpSettings().oauthDb;
  if(command==='remote-serve'){const {settings}=await startRemote();return {listening:settings.bind+':'+settings.port};}
  if(command==='remote-enroll')return setEnrollment(db,input.minutes);
  if(command==='remote-enroll-close')return setEnrollment(db,0);
  if(command==='remote-clients')return listClients(db);
  if(command==='remote-revoke')return revokeClient(db,input.clientId);
  const {createRemoteRuntime}=await import('./remote.mjs');
  const runtime=createRemoteRuntime();
  try{
    if(command==='remote-audit')return {items:await runtime.readAudit(input)};
    return await runtime.ops.zana_merge(input,{operator:true,host:'operator',sessionId:'operator-cli'});
  }finally{await runtime.close();}
}

export async function runCli(command,args=[],{json,text}={}){
  const parsed=await parseCliCommand(command,args,{json,text});
  if(parsed.command.startsWith('remote-'))return runRemoteCommand(parsed);
  if(parsed.command==='operator-import')return applyOperatorAction(parsed.input.envelope);
  if(parsed.command==='storage-restore-abort')return storageRestoreAbort();
  if(parsed.command==='storage-cleanup-artifacts')return storageCleanupArtifacts(undefined,parsed.input);
  if(parsed.command==='storage-adopt-quarantine')
    return storageAdoptQuarantine(parsed.input.id,undefined,
      {confirm:parsed.input.confirm,forceDataLoss:parsed.input.forceDataLoss});
  if(parsed.command==='reconcile-view'){
    const state=await readState();
    return {items:(state?.units??[]).filter(u=>
      u.effect==='WRITE'&&u.status==='OUTCOME_UNKNOWN').map(u=>({
        unitId:u.id,leaseGeneration:u.run?.leaseGeneration??null,
        token:u.run?.token??null,path:u.run?.effectIntent?.path??null,
        preSha256:u.run?.effectIntent?.preSha256??null,
        expectedPostSha256:u.run?.effectIntent?.expectedPostSha256??null
      }))};
  }
  const operation=operations[parsed.action];
  if(typeof operation!=='function')throw Error(usage);
  return operation(parsed.input);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [command,...args]=process.argv.slice(2);
  runCli(command,args).then(value=>process.stdout.write(JSON.stringify(value,null,2)+'\n'))
    .catch(error=>{
      process.stderr.write('Error: '+(error.code?'['+error.code+'] ':'')+error.message+'\n');
      process.exitCode=1;
    });
}
