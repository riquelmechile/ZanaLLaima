#!/usr/bin/env node
// Static build/release preflight. This is not an authorization for merge or deployment.
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';

const fail=(errors,message)=>{if(!errors.includes(message))errors.push(message)};
export function assessBuildPolicy({pkg,lock,workflow,trackedFiles=[]}){
  const errors=[];
  if(!pkg || !lock || !workflow) return {passed:false,errors:['Missing build manifest, lockfile, or CI workflow'],releaseAuthorized:false};
  if(lock.lockfileVersion!==3)fail(errors,'LOCKFILE_VERSION_UNSUPPORTED');
  const root=lock.packages?.[''];
  if(!root||root.name!==pkg.name||root.version!==pkg.version)fail(errors,'LOCKFILE_ROOT_MISMATCH');
  for(const key of ['dependencies','devDependencies']){
    if(JSON.stringify(root?.[key]||{})!==JSON.stringify(pkg[key]||{}))
      fail(errors,'LOCKFILE_'+key.toUpperCase()+'_MISMATCH');
  }
  for(const [path,p] of Object.entries(lock.packages||{})){
    if(!path)continue;
    if(!p.resolved||!p.integrity||!/^sha512-[A-Za-z0-9+/]+=*$/.test(p.integrity)||
        !/^https:\/\/registry\.npmjs\.org\//.test(p.resolved))
      fail(errors,'UNVERIFIED_DEPENDENCY_IN_LOCKFILE');
  }
  if(!/^name: CI$/m.test(workflow)||!/\bpull_request:/m.test(workflow)||
     !/push:\s*\n\s*branches:\s*\[main\]/.test(workflow)||
     /\bpull_request_target:|\bworkflow_run:/.test(workflow))
     fail(errors,'UNSAFE_CI_EVENTS');
  if(!/permissions:\s*\n\s*contents:\s*read/.test(workflow))
    fail(errors,'CI_PERMISSIONS_NOT_READONLY');
  if(!/persist-credentials:\s*false/.test(workflow))
    fail(errors,'CHECKOUT_CREDENTIALS_PERSISTED');
  if(!/actions\/checkout@[a-f0-9]{40}\b/.test(workflow)||
     !/actions\/setup-node@[a-f0-9]{40}\b/.test(workflow))
    fail(errors,'UNPINNED_CI_ACTION');
  if(!/npm ci --ignore-scripts --no-audit --no-fund/.test(workflow))
    fail(errors,'DEPENDENCIES_NOT_REPRODUCIBLE');
  if(!/Verify exact commit/.test(workflow)||!/EXPECTED_SHA/.test(workflow)||
    !/github\.event\.pull_request\.head\.sha \|\| github\.sha/.test(workflow))
    fail(errors,'EXACT_SHA_GATE_MISSING');
  if(!/timeout-minutes:/.test(workflow)||!/cancel-in-progress:\s*true/.test(workflow))
    fail(errors,'NO_TIMEOUT_OR_CANCEL_POLICY');
  for(const name of trackedFiles){
    if(/(?:^|\/)(?:\.env(?:\..+)?|id_rsa|id_ed25519)$|(?:^|\/)[^/]+\.(?:pem|key|p12|pfx|sqlite|db|sqlite-wal|sqlite-shm)$/.test(name))
      fail(errors,'SENSITIVE_FILE_TRACKED');
  }
  return {passed:errors.length===0,errors,releaseAuthorized:false,
    externalGates:{
      branchProtection:'NOT_VERIFIED',
      requiredChecks:'NOT_VERIFIED',
      independentReview:'NOT_VERIFIED',
      trustedCIAttribution:'NOT_CONNECTED',
      hostExecutorEnforcement:'NOT_CONNECTED',
      nativeSubagents:'NOT_VERIFIED',
    },
    note:'Passing static CI checks never authorizes a merge or deployment.'};
}
export function inspectRepository(root=process.cwd()){
  const read=p=>readFileSync(join(root,p),'utf8');
  const tracked=execFileSync('git',['-C',root,'ls-files','--cached','--full-name'],{encoding:'utf8'}).split('\n').filter(Boolean);
  return assessBuildPolicy({
    pkg:JSON.parse(read('package.json')),
    lock:JSON.parse(read('package-lock.json')),
    workflow:read('.github/workflows/ci.yml'),trackedFiles:tracked
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const report=inspectRepository();
    process.stdout.write(JSON.stringify(report,null,2)+'\n');
    if(!report.passed)process.exitCode=1;
  }catch(error){
    console.error('Release preflight failed:',error.message);
    process.exitCode=1;
  }
}
