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
  // git status may suppress content changes with assume-unchanged or
  // skip-worktree index bits. Require ordinary tracked entries before trusting
  // any clean snapshot. The -z format safely preserves strange filenames.
  // Recursively inspect each initialized gitlink's own index. A parent
  // status --ignore-submodules=none cannot detect assume-unchanged or
  // skip-worktree flags hidden inside a submodule's index.
  const inspectIndex=(worktree,depth=0)=>{
    if(depth>16)deny('Git submodule nesting exceeds inspection limit');
    const nestedCall=(...args)=>{
      try{return execFileSync('git',['-C',worktree,...args],{
        env:gitEnv(),encoding:'utf8',stdio:['ignore','pipe','pipe'],
        timeout:10000,maxBuffer:1048576
      }).trimEnd();}catch{deny('Git submodule index inspection failed');}
    };
    const indexEntries=nestedCall('ls-files','-v','-z').split('\0').filter(Boolean);
    if(indexEntries.some(entry=>!entry.startsWith('H ')))
      deny('Git index contains hidden/unsupported tracked-file flags');
    const gitlinks=nestedCall('ls-files','--stage','-z').split('\0')
      .filter(Boolean).filter(entry=>entry.startsWith('160000 '));
    for(const entry of gitlinks){
      const tab=entry.indexOf('\t');
      if(tab<0)deny('Invalid Git submodule index entry');
      const subpath=entry.slice(tab+1);
      let nested;
      try{nested=realpathSync(resolve(worktree,subpath));}
      catch{deny('Git submodule unavailable for index inspection');}
      if(!nested.startsWith(worktree+'/'))
        deny('Git submodule escapes repository root');
      if(nestedCall('-C',nested,'rev-parse','--show-toplevel')!==nested)
        deny('Git submodule is not an exact worktree root');
      inspectIndex(nested,depth+1);
    }
  };
  inspectIndex(root);
  // Explicitly override submodule.<name>.ignore=all. The worktree is not
  // clean if tracked content inside a nested repository was modified.
  const dirty=call('status','--porcelain=v1','--untracked-files=all',
    '--ignore-submodules=none');
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
