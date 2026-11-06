// Read-only delivery verification and the guarded merge.
// independentReview() is copied from riquelmechile/panter-ai@1a99048
// src/core/github-delivery.ts (GitHubDeliveryGate.independentReview): latest
// state-changing review by the configured identity, evaluated as GitHub does
// (COMMENTED reviews never change approval state), with APPROVED_EXACT_SHA,
// STALE_SHA, CHANGES_REQUESTED, DISMISSED, REVIEWER_IS_AUTHOR, MISSING and
// UNAVAILABLE. Panter's label, issue, conventional-commit and review-budget
// gates are not copied: ZanaLLaima adds no gates beyond its contract.
import {evaluateRuns} from './checks.mjs';
import {createDeadline} from './deadline.mjs';

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

// The authority for the merge is the current (latest, not superseded) ticket
// of the mission: FINALIZED with APPROVE on the head, and its own review must
// be the latest decisive one on GitHub. An APPROVE of a superseded ticket on
// the same SHA never counts. A missing ticket is a blocker (fail closed).
export function ticketAuthority(ticket,head,review){
  if(!ticket)return {ok:false,reason:'no review ticket'};
  const view={ticketId:ticket.ticket_id,state:ticket.state,verdict:ticket.verdict??null,sha:ticket.sha,
    githubReviewId:ticket.github_review_id??null};
  const ok=ticket.state==='FINALIZED'&&ticket.verdict==='APPROVE'&&ticket.sha===head&&
    ticket.github_review_id!==null&&ticket.github_review_id!==undefined&&Number(ticket.github_review_id)===review.reviewId;
  return {ok,ticket:view,...(ok?{}:{reason:view.state+'/'+(view.verdict??'-')+' on '+view.sha+
    (ticket.github_review_id!=null&&Number(ticket.github_review_id)!==review.reviewId?' (its review is not the latest decisive one)':'')})};
}

export async function deliveryStatus({github,config,ctx,openBlockingTickets=[],currentTicket=null,deadline=createDeadline(config.toolDeadlineMs)}){
  const pull=await missionPull(github,ctx);
  if(!pull)return {missionId:ctx.missionId,state:'NO_PULL_REQUEST',ready:false,
    blockers:['No single open pull request from '+ctx.branch+' to '+ctx.base],readOnly:true};
  const head=String(pull.head?.sha??'');
  // Each read gets what is left of the tool deadline; a step that does not fit
  // is reported as partial and counts as a blocker (never as green).
  const ci=await deadline.step(async()=>evaluateRuns(await github.checkRuns(ctx.repo,head),head,config.requiredChecks),'ci',
    {fallback:{state:'UNKNOWN',runs:[],missing:[]}});
  const fourR=await deadline.step(async()=>fourRStatus(await github.statuses(ctx.repo,head),config.reviewerLogin),'zana/4r',
    {fallback:'UNKNOWN'});
  const review=await deadline.step(()=>independentReview(github,ctx.repo,pull.number,head,pull,config.reviewerLogin),'review',
    {fallback:{login:config.reviewerLogin.toLowerCase(),state:'UNAVAILABLE',unavailableReason:'DEADLINE'}});
  const mergeable=pull.mergeable===true&&pull.draft!==true&&pull.state==='open';
  const blockers=[];
  if(review.state!=='APPROVED_EXACT_SHA')blockers.push('Review of '+review.login+': '+review.state);
  if(ci.state!=='SUCCESS')blockers.push('CI on '+head+': '+ci.state);
  if(fourR!=='success')blockers.push('zana/4r on '+head+': '+fourR);
  if(!mergeable)blockers.push('Pull request not mergeable ('+(pull.draft===true?'draft':pull.mergeable_state??String(pull.mergeable))+')');
  if(openBlockingTickets.length)blockers.push('Open review tickets with BLOCKER or CRITICAL: '+openBlockingTickets.join(', '));
  const authority=ticketAuthority(currentTicket,head,review);
  if(!authority.ok)blockers.push('Current review ticket: '+authority.reason);
  return {missionId:ctx.missionId,repo:ctx.repo,pullNumber:pull.number,pullUrl:pull.html_url??null,headSha:head,
    review,currentTicket:authority.ticket??null,ci:{state:ci.state,runs:ci.runs,missing:ci.missing},fourR,mergeable,
    mergeableState:pull.mergeable_state??null,openBlockingTickets,ready:blockers.length===0,blockers,
    ...(deadline.partial.length?{partial:deadline.partial}:{}),readOnly:true};
}

// Merge only when deliveryStatus is green on one head SHA. The merge API gets
// sha = that head (equivalent to --match-head-commit): if the head moved,
// GitHub refuses and ZanaLLaima answers STALE_SHA without retrying. If the
// answer is lost, the pull request is read again: merged means MERGED.
export async function mergeMission({github,config,ctx,openBlockingTickets,currentTicket=null,onAttempt=async()=>{}}){
  if(!config.mergeEnabled)return {merged:false,state:'MERGE_DISABLED',reason:'ZANA_MERGE_ENABLED=false'};
  const status=await deliveryStatus({github,config,ctx,openBlockingTickets,currentTicket});
  if(!status.ready)return {merged:false,state:'NOT_READY',blockers:status.blockers,headSha:status.headSha??null};
  await onAttempt(status.headSha);
  const recovered=async()=>{
    let pull=null;
    try{pull=await github.pull(ctx.repo,status.pullNumber);}catch{pull=null;}
    return pull?.merged===true?{merged:true,state:'MERGED',pullNumber:status.pullNumber,headSha:status.headSha,
      mergeCommitSha:pull.merge_commit_sha??null,method:config.mergeMethod,recovered:true}:null;
  };
  try{
    const result=await github.merge(ctx.repo,status.pullNumber,{headSha:status.headSha,method:config.mergeMethod});
    if(result?.merged!==true)return (await recovered())??{merged:false,state:'MERGE_REFUSED',headSha:status.headSha,reason:String(result?.message??'')};
    return {merged:true,state:'MERGED',pullNumber:status.pullNumber,headSha:status.headSha,
      mergeCommitSha:result.sha??null,method:config.mergeMethod};
  }catch(error){
    const done=await recovered();
    if(done)return done;
    if(error?.status===409||(error?.status===422&&/head|sha|modified/i.test(error.message)))
      return {merged:false,state:'STALE_SHA',headSha:status.headSha,reason:error.message};
    throw error;
  }
}
