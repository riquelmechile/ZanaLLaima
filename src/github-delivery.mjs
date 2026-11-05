// Read-only delivery verification and the guarded merge.
// independentReview() is copied from riquelmechile/panter-ai@1a99048
// src/core/github-delivery.ts (GitHubDeliveryGate.independentReview): latest
// state-changing review by the configured identity, evaluated as GitHub does
// (COMMENTED reviews never change approval state), with APPROVED_EXACT_SHA,
// STALE_SHA, CHANGES_REQUESTED, DISMISSED, REVIEWER_IS_AUTHOR, MISSING and
// UNAVAILABLE. Panter's label, issue, conventional-commit and review-budget
// gates are not copied: ZanaLLaima adds no gates beyond its contract.
import {evaluateRuns} from './checks.mjs';

export async function independentReview(github,repo,number,head,pull,reviewer){
  const login=reviewer.toLowerCase();
  const authors=new Set();
  const prAuthor=String(pull?.user?.login??'').toLowerCase();
  if(prAuthor)authors.add(prAuthor);
  let commits;
  try{commits=await github.pullCommits(repo,number);}
  catch{return {login,state:'UNAVAILABLE',unavailableReason:'COMMIT_HISTORY_UNREADABLE'};}
  for(const c of commits)for(const who of [c?.author?.login,c?.committer?.login])
    if(typeof who==='string'&&who&&who.toLowerCase()!=='web-flow')authors.add(who.toLowerCase());
  if(authors.has(login))return {login,state:'REVIEWER_IS_AUTHOR'};
  let reviews;
  try{reviews=await github.pullReviews(repo,number);}
  catch{return {login,state:'UNAVAILABLE',unavailableReason:'REVIEWS_UNREADABLE_OR_OVER_LIMIT'};}
  const decisive=reviews.filter(r=>String(r?.user?.login??'').toLowerCase()===login&&
    ['APPROVED','CHANGES_REQUESTED','DISMISSED'].includes(String(r?.state)));
  const last=decisive.at(-1);
  if(!last)return {login,state:'MISSING'};
  const base={login,reviewId:Number(last.id),commitId:String(last.commit_id??'')};
  if(last.state==='CHANGES_REQUESTED')return {...base,state:'CHANGES_REQUESTED'};
  if(last.state==='DISMISSED')return {...base,state:'DISMISSED'};
  return {...base,state:last.commit_id===head?'APPROVED_EXACT_SHA':'STALE_SHA'};
}

// The single open pull request from the mission branch to the mission base.
export async function missionPull(github,ctx){
  const open=(await github.openPullsFor(ctx.repo,ctx.branch)).filter(p=>p?.head?.ref===ctx.branch&&p?.base?.ref===ctx.base);
  if(open.length!==1)return null;
  return github.pull(ctx.repo,open[0].number);
}

export function fourRStatus(statuses,reviewer){
  // GitHub lists statuses newest first.
  const mine=statuses.filter(s=>s?.context==='zana/4r'&&String(s?.creator?.login??'').toLowerCase()===reviewer.toLowerCase());
  return mine.length?mine[0].state:'MISSING';
}

export async function deliveryStatus({github,config,ctx,openBlockingTickets=[]}){
  const pull=await missionPull(github,ctx);
  if(!pull)return {missionId:ctx.missionId,state:'NO_PULL_REQUEST',ready:false,
    blockers:['No single open pull request from '+ctx.branch+' to '+ctx.base],readOnly:true};
  const head=String(pull.head?.sha??'');
  const ci=evaluateRuns(await github.checkRuns(ctx.repo,head),head,config.requiredChecks);
  const fourR=fourRStatus(await github.statuses(ctx.repo,head),config.reviewerLogin);
  const review=await independentReview(github,ctx.repo,pull.number,head,pull,config.reviewerLogin);
  const mergeable=pull.mergeable===true&&pull.draft!==true&&pull.state==='open';
  const blockers=[];
  if(review.state!=='APPROVED_EXACT_SHA')blockers.push('Review of '+review.login+': '+review.state);
  if(ci.state!=='SUCCESS')blockers.push('CI on '+head+': '+ci.state);
  if(fourR!=='success')blockers.push('zana/4r on '+head+': '+fourR);
  if(!mergeable)blockers.push('Pull request not mergeable ('+(pull.mergeable_state??String(pull.mergeable))+')');
  if(openBlockingTickets.length)blockers.push('Open review tickets with BLOCKER or CRITICAL: '+openBlockingTickets.join(', '));
  return {missionId:ctx.missionId,repo:ctx.repo,pullNumber:pull.number,pullUrl:pull.html_url??null,headSha:head,
    review,ci:{state:ci.state,runs:ci.runs,missing:ci.missing},fourR,mergeable,
    mergeableState:pull.mergeable_state??null,openBlockingTickets,ready:blockers.length===0,blockers,readOnly:true};
}

// Merge only when deliveryStatus is green on one head SHA. The merge API gets
// sha = that head (equivalent to --match-head-commit): if the head moved,
// GitHub refuses and ZanaLLaima answers STALE_SHA without retrying.
export async function mergeMission({github,config,ctx,openBlockingTickets}){
  if(!config.mergeEnabled)return {merged:false,state:'MERGE_DISABLED',reason:'ZANA_MERGE_ENABLED=false'};
  const status=await deliveryStatus({github,config,ctx,openBlockingTickets});
  if(!status.ready)return {merged:false,state:'NOT_READY',blockers:status.blockers,headSha:status.headSha??null};
  try{
    const result=await github.merge(ctx.repo,status.pullNumber,{headSha:status.headSha,method:config.mergeMethod});
    if(result?.merged!==true)return {merged:false,state:'MERGE_REFUSED',headSha:status.headSha,reason:String(result?.message??'')};
    return {merged:true,state:'MERGED',pullNumber:status.pullNumber,headSha:status.headSha,
      mergeCommitSha:result.sha??null,method:config.mergeMethod};
  }catch(error){
    if(error?.status===409||(error?.status===422&&/head|sha|modified/i.test(error.message)))
      return {merged:false,state:'STALE_SHA',headSha:status.headSha,reason:error.message};
    throw error;
  }
}
