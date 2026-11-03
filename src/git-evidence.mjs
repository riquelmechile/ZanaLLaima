import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const SHA=/^[a-f0-9]{40}$/;
const deny=reason=>{throw new Error('Git candidate rejected: '+reason);};
const safeRef=ref=>typeof ref==='string' && ref.startsWith('refs/heads/') &&
  /^[A-Za-z0-9_./-]{12,200}$/.test(ref) && !ref.includes('..') &&
  !ref.endsWith('/') && !ref.includes('//') && !ref.includes('@{');
const gitEnv=()=>{
  const result={...process.env,GIT_OPTIONAL_LOCKS:'0'};
  for(const name of Object.keys(result)){
    if(name.startsWith('GIT_') && name!=='GIT_OPTIONAL_LOCKS')delete result[name];
  }
  return result;
};

export function observeGit({
  repoPath=process.env.ZANA_REVIEW_REPO||process.cwd(),
  targetRef=process.env.ZANA_REVIEW_TARGET_REF||'refs/heads/main'
}={}){
  if(!safeRef(targetRef))deny('Invalid target branch ref');
  let root;
  try {root=realpathSync(resolve(repoPath));}
  catch{deny('Repository path is not available');}
  const call=(...args)=>{
    try{
      return execFileSync('git',['-C',root,...args],{
        env:gitEnv(),encoding:'utf8',stdio:['ignore','pipe','pipe'],
        timeout:10000,maxBuffer:1048576
      }).trimEnd();
    }catch{deny('Git command failed: '+args[0]);}
  };
  const actual=realpathSync(call('rev-parse','--show-toplevel'));
  if(actual!==root)deny('Repository must be its exact worktree root');
  const branch=call('symbolic-ref','--quiet','HEAD');
  if(!safeRef(branch))deny('Detached or invalid local branch');
  const sha=call('rev-parse','--verify','HEAD^{commit}').trim();
  const treeSha=call('rev-parse','--verify','HEAD^{tree}').trim();
  const baseSha=call('rev-parse','--verify',targetRef+'^{commit}').trim();
  if(!SHA.test(sha)||!SHA.test(treeSha)||!SHA.test(baseSha))deny('Invalid Git object');
  const dirty=call('status','--porcelain=v1','--untracked-files=all');
  return Object.freeze({assurance:'LOCAL_GIT_OBSERVED',repoRoot:root,
    candidateSha:sha,treeSha,branchRef:branch,targetRef,baseSha,
    clean:dirty.length===0,observedAt:new Date().toISOString()});
}

export function matchesReviewCandidate(review,observed){
  const frozen=review?.gitEvidence;
  if(!frozen || frozen.assurance!=='LOCAL_GIT_OBSERVED')return false;
  return observed?.clean===true && frozen.clean===true &&
    frozen.repoRoot===observed.repoRoot &&
    frozen.candidateSha===observed.candidateSha &&
    frozen.treeSha===observed.treeSha &&
    frozen.branchRef===observed.branchRef &&
    frozen.targetRef===observed.targetRef &&
    frozen.baseSha===observed.baseSha &&
    review.candidateSha===observed.candidateSha;
}
