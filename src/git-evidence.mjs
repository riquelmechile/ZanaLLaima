import {execFileSync} from 'node:child_process';
import {lstatSync,readlinkSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,resolve,sep} from 'node:path';

// Git config belongs to the candidate's author. No subprocess may execute
// worktree filters, attributes drivers, fsmonitor, hooks or network transports.
const SAFE_GIT_ARGS=[
  '-c','core.fsmonitor=false',
  '-c','core.untrackedCache=false',
  '-c','core.hooksPath=/dev/null',
  '-c','protocol.allow=never',
  '-c','core.sshCommand=false',
  '-c','diff.external=false',
  '-c','core.pager=cat',
];
const SHA=/^[a-f0-9]{40}$/;
const deny=reason=>{throw new Error('Git candidate rejected: '+reason);};
const safeRef=ref=>typeof ref==='string'&&ref.startsWith('refs/heads/')&&
  /^[A-Za-z0-9_./-]{12,200}$/.test(ref)&&!ref.includes('..')&&
  !ref.endsWith('/')&&!ref.includes('//')&&!ref.includes('@{');
const gitEnv=()=>{
  const result={...process.env};
  for(const name of Object.keys(result))if(name.startsWith('GIT_'))delete result[name];
  result.GIT_OPTIONAL_LOCKS='0';
  result.GIT_CONFIG_NOSYSTEM='1';
  result.GIT_CONFIG_GLOBAL='/dev/null';
  result.GIT_ATTR_NOSYSTEM='1';
  return result;
};
const call=(worktree,args,options={})=>{
  try{
    return execFileSync('git',[...SAFE_GIT_ARGS,'-C',worktree,...args],{
      env:gitEnv(),encoding:options.input===undefined?'utf8':undefined,
      input:options.input,stdio:['pipe','pipe','pipe'],timeout:10000,
      maxBuffer:8*1024*1024,
    }).toString('utf8');
  }catch{deny('Git command failed: '+args[0]);}
};
const records=output=>output.split('\0').filter(Boolean);
const validTrackedPath=path=>typeof path==='string'&&path.length>0&&
  !isAbsolute(path)&&!path.split('/').some(part=>part===''||part==='.'||part==='..');
const parseIndex=output=>{
  const result=new Map();
  let hasConflict=false;
  for(const row of records(output)){
    const match=/^(100644|100755|120000|160000) ([a-f0-9]{40}) ([0-3])\t([\s\S]+)$/.exec(row);
    if(!match||!validTrackedPath(match[4]))deny('Invalid Git index entry');
    if(match[3]!=='0'||result.has(match[4]))hasConflict=true;
    result.set(match[4],{mode:match[1],sha:match[2]});
  }
  return {result,hasConflict};
};
const parseTree=output=>{
  const result=new Map();
  for(const row of records(output)){
    const match=/^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(row);
    if(!match||!validTrackedPath(match[4])||result.has(match[4]))
      deny('Invalid Git tree entry');
    result.set(match[4],{mode:match[1],sha:match[3]});
  }
  return result;
};
const nestedRoot=(worktree,subpath)=>{
  let nested;
  try{nested=realpathSync(resolve(worktree,subpath));}
  catch{deny('Git submodule unavailable for inspection');}
  if(!nested.startsWith(worktree+sep))deny('Git submodule escapes repository root');
  if(realpathSync(call(nested,['rev-parse','--show-toplevel']).trim())!==nested)
    deny('Git submodule is not an exact worktree root');
  return nested;
};
const inspect=(worktree,depth=0)=>{
  if(depth>16)deny('Git submodule nesting exceeds inspection limit');
  // Only Git plumbing commands that do not consult content filters or run
  // status/diff. The index, HEAD and bytes on disk are compared separately.
  const flags=records(call(worktree,['ls-files','-v','-z']));
  if(flags.some(x=>!x.startsWith('H ')))
    deny('Git index contains hidden/unsupported tracked-file flags');
  const {result:index,hasConflict}=parseIndex(call(worktree,['ls-files','-s','-z']));
  const tree=parseTree(call(worktree,['ls-tree','-r','-z','HEAD']));
  let dirty=hasConflict||index.size!==tree.size;
  for(const [path,entry] of index){
    const committed=tree.get(path);
    if(!committed||entry.mode!==committed.mode||entry.sha!==committed.sha)dirty=true;
    if(entry.mode==='160000'){
      const nested=nestedRoot(worktree,path);
      if(call(nested,['rev-parse','--verify','HEAD^{commit}']).trim()!==entry.sha)
        dirty=true;
      if(inspect(nested,depth+1))dirty=true;
      continue;
    }
    const full=resolve(worktree,path);
    // No intermediate symlink may redirect reads outside the worktree.
    let stat,parent;
    try{stat=lstatSync(full);parent=realpathSync(dirname(full));}
    catch(e){if(e?.code==='ENOENT'||e?.code==='ENOTDIR'){dirty=true;continue;}
      deny('Unable to inspect tracked file safely');}
    if(parent!==worktree&&!parent.startsWith(worktree+sep))
      deny('Tracked path escapes repository root');
    const symlink=entry.mode==='120000';
    if(symlink!==stat.isSymbolicLink()||(!symlink&&!stat.isFile())){
      dirty=true;continue;
    }
    if(!symlink&&Boolean(stat.mode&0o111)!==(entry.mode==='100755'))dirty=true;
    const contentSha=symlink
      ?call(worktree,['hash-object','--stdin'],{input:readlinkSync(full,{encoding:'buffer'})}).trim()
      :call(worktree,['hash-object','--no-filters','--',path]).trim();
    if(contentSha!==entry.sha)dirty=true;
  }
  if(records(call(worktree,['ls-files','--others','--exclude-standard','-z'])).length)
    dirty=true;
  return dirty;
};

export function observeGit({
  repoPath=process.env.ZANA_REVIEW_REPO||process.cwd(),
  targetRef=process.env.ZANA_REVIEW_TARGET_REF||'refs/heads/main'
}={}){
  if(!safeRef(targetRef))deny('Invalid target branch ref');
  let root;
  try{root=realpathSync(resolve(repoPath));}
  catch{deny('Repository path is not available');}
  const actual=realpathSync(call(root,['rev-parse','--show-toplevel']).trim());
  if(actual!==root)deny('Repository must be its exact worktree root');
  const branch=call(root,['symbolic-ref','--quiet','HEAD']).trim();
  if(!safeRef(branch))deny('Detached or invalid local branch');
  const sha=call(root,['rev-parse','--verify','HEAD^{commit}']).trim();
  const treeSha=call(root,['rev-parse','--verify','HEAD^{tree}']).trim();
  const baseSha=call(root,['rev-parse','--verify',targetRef+'^{commit}']).trim();
  if(!SHA.test(sha)||!SHA.test(treeSha)||!SHA.test(baseSha))deny('Invalid Git object');
  const dirty=inspect(root);
  return Object.freeze({assurance:'LOCAL_GIT_OBSERVED',repoRoot:root,
    candidateSha:sha,treeSha,branchRef:branch,targetRef,baseSha,
    clean:!dirty,observedAt:new Date().toISOString()});
}

export function matchesReviewCandidate(review,observed){
  const frozen=review?.gitEvidence;
  if(!frozen||frozen.assurance!=='LOCAL_GIT_OBSERVED')return false;
  return observed?.clean===true&&frozen.clean===true&&
    frozen.repoRoot===observed.repoRoot&&
    frozen.candidateSha===observed.candidateSha&&
    frozen.treeSha===observed.treeSha&&
    frozen.branchRef===observed.branchRef&&
    frozen.targetRef===observed.targetRef&&
    frozen.baseSha===observed.baseSha&&
    review.candidateSha===observed.candidateSha;
}
