#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {operations} from './actions.mjs';
import {applyOperatorAction} from './store.mjs';

const usage='Commands: operator-import, heartbeat, recover-expired, retry, cancel, close, archive, mission-history, authorization-status, storage-status, storage-history, storage-reviews, storage-migrate, storage-backup, storage-restore, profile, init, status, next, start, complete, apply-write, review-open, review-next, review-start, review-submit, review-check, review-status, delivery-check';
const readJson=async path=>JSON.parse(await readFile(path,'utf8'));
const readText=async path=>readFile(path,'utf8');
const noArgs=new Set(['status','profile','review-status','review-check','storage-status',
  'storage-migrate','authorization-status','recover-expired','cancel','close','archive']);

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
    leaseGeneration:Number(args[2]),leaseSeconds:args[3]?Number(args[3]):300};
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
  else if(command==='storage-restore')input={source:args[0],offline:true};
  else if(!noArgs.has(command))throw Error(usage);
  return {command,action:aliases[command]??command,input};
}

export async function runCli(command,args=[],{json,text}={}){
  const parsed=await parseCliCommand(command,args,{json,text});
  if(parsed.command==='operator-import')return applyOperatorAction(parsed.input.envelope);
  const operation=operations[parsed.action];
  if(typeof operation!=='function')throw Error(usage);
  return operation(parsed.input);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [command,...args]=process.argv.slice(2);
  runCli(command,args).then(value=>process.stdout.write(JSON.stringify(value,null,2)+'\n'))
    .catch(error=>{
      process.stderr.write('Error: '+error.message+'\n');
      process.exitCode=1;
    });
}
