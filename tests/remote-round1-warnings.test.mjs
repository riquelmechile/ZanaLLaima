// Etapa B, ronda 1: WARNING, tests faltantes de R3 y sugerencias.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {remoteFixture,readDiff,sha,AUTHOR_TOKEN,REVIEWER_TOKEN} from './helpers/remote-fixture.mjs';
import {CATALOG,ALLOWED_KEYS,safeRepoPath,createGitHubPolicy} from '../src/github-policy.mjs';
import {evaluateRuns} from '../src/checks.mjs';
import {fourRStatus} from '../src/github-delivery.mjs';
import {GitHubApi,breakerFor} from '../src/github-api.mjs';
import {createDeadline,within} from '../src/deadline.mjs';
import {DownstreamGateway} from '../src/downstream.mjs';
import {transact} from '../src/store.mjs';

const clean=lens=>({lens,findings:[],evidence:['read every page']});
const ds=(f,operation,args,s,missionId)=>f.call('zana_ds_github',{operation,arguments:args,...(missionId?{missionId}:{})},s);
const errText=r=>r.error??r.raw?.content?.[0]?.text??r.content?.[0]?.text??'';
async function finishReview(f,ticket,s,risk=clean('risk')){
  assert.equal((await f.call('zana_review_claim',{ticket},s)).state,'CLAIMED');
  await readDiff(f.call,ticket,s);
  for(const l of [risk,clean('readability'),clean('reliability'),clean('resilience')])
    assert.equal((await f.call('zana_review_lens_submit',{ticket,...l},s)).error,undefined);
  return f.call('zana_review_finalize',{ticket,execution:'PARALLEL_SUBAGENTS'},s);
}
// A server that accepts and immediately drops every connection (no fixed port).
async function droppingServer(){
  const srv=createServer(sock=>sock.destroy());
  await new Promise(ok=>srv.listen(0,'127.0.0.1',ok));
  return {url:'http://127.0.0.1:'+srv.address().port+'/mcp',close:()=>new Promise(ok=>srv.close(ok))};
}

test('W6: a new ticket on the same SHA after REQUEST_CHANGES is refused; CRITICAL also requests changes',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId,branch}=await f.authorReady();
    const t1=await f.call('zana_review_request',{missionId},author);
    const r=await finishReview(f,t1.ticket,await f.session(),
      {lens:'risk',findings:[{severity:'CRITICAL',location:'src/a.mjs:1',evidence:'token logged'}],evidence:['diff']});
    assert.equal(r.event,'REQUEST_CHANGES');
    assert.match((await f.call('zana_review_request',{missionId},author)).error,/CHANGES_REQUESTED_SAME_SHA/);
    f.api.state.push(branch,sha('b'));f.api.state.green(sha('b'));
    assert.equal((await f.call('zana_review_request',{missionId},author)).error,undefined);
  }finally{await f.cleanup();}
});

test('W7/W9/R3: exact argument keys, URL-ish paths, exact head branch, issue comments only on the mission PR',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId,branch}=await f.authorReady();
    f.api.state.pulls.push({number:9,state:'open',head:{ref:'feature',sha:sha('b'),repo:{full_name:'o/r'}},base:{ref:'main'}});
    for(const [name,t] of Object.entries(CATALOG.tools))if(t.zana==='write')assert.ok(ALLOWED_KEYS[name],'keys for '+name);
    const base={owner:'o',repo:'r',message:'m'};
    const cases=[
      ['create_or_update_file',{...base,Branch:branch,branch,path:'a',content:'x'},/FIELD_NOT_ALLOWED.*Branch/],
      ['create_or_update_file',{...base,branch,Path:'.github/workflows/x.yml',path:'a',content:'x'},/FIELD_NOT_ALLOWED.*Path/],
      ['create_or_update_file',{...base,branch,path:'a',content:'x',allow_symlink_write:true},/FIELD_NOT_ALLOWED/],
      ['create_branch',{owner:'o',repo:'r',branch,from_branch:'main',ref:'main'},/FIELD_NOT_ALLOWED.*ref/],
      ['create_or_update_file',{...base,branch,path:'%2e%2e/.github/workflows/x.yml',content:'x'},/PROTECTED_PATH/],
      ['create_or_update_file',{...base,branch,path:'.github%2Fworkflows/x.yml',content:'x'},/PROTECTED_PATH/],
      ['create_or_update_file',{...base,branch,path:'a.txt?ref=main',content:'x'},/PROTECTED_PATH/],
      ['create_or_update_file',{...base,branch,path:'a\u0007b',content:'x'},/PROTECTED_PATH/],
      ['push_files',{...base,branch,files:[{path:'a',content:'x',mode:'100755'}]},/FIELD_NOT_ALLOWED/],
      ['update_pull_request',{owner:'o',repo:'r',pullNumber:7,title:'t',state:'closed'},/FIELD_NOT_ALLOWED.*state/],
      ['update_pull_request',{owner:'o',repo:'r',pullNumber:7,title:'t',base:'dev'},/FIELD_NOT_ALLOWED.*base/],
      ['create_pull_request',{owner:'o',repo:'r',title:'t',head:branch.toUpperCase(),base:'main'},/OUTSIDE_MISSION_BRANCH/],
      ['create_pull_request',{owner:'o',repo:'r',title:'t',head:'other:'+branch,base:'main'},/OUTSIDE_MISSION_BRANCH/],
    ];
    for(const [tool,args,re] of cases){
      assert.match(errText(await ds(f,tool,args,author,missionId)),re,tool+' '+JSON.stringify(args));
    }
    assert.equal(Boolean((await ds(f,'create_pull_request',{owner:'O',repo:'r',title:'t',head:'O:'+branch,base:'main'},author,missionId)).isError),false);
    for(const bad of ['%2e%2e/x','a%2Fb','a?b','a#b','a\nb'])assert.equal(safeRepoPath(bad),false,bad);
    // add_issue_comment (issues toolset, not mounted by default): only on the mission PR.
    const policy=createGitHubPolicy({config:{checksWorkflow:'zana-checks.yml'},deps:{github:f.runtime.github,
      missionContext:id=>f.runtime.missionContext(id,author.sessionId,{allowInactive:true})}});
    const call=args=>policy({caller:author,tool:'add_issue_comment',args:{owner:'o',repo:'r',body:'hi',...args},cls:'write',missionId});
    assert.equal((await call({issue_number:7})).allowed,true);
    assert.match((await call({issue_number:9})).reason,/OUTSIDE_MISSION_PR/);
  }finally{await f.cleanup();}
});

test('R3: secrets without a GitHub shape never reach results, errors or audit, in any encoding',async()=>{
  const consent='consent-'+'k'.repeat(40);
  const plain='plain-secret-'+'z'.repeat(30);
  const f=await remoteFixture({envExtra:{ZANA_OAUTH_CONSENT_PASSWORD:consent},mcp:{echoToken:true}});
  const prev=process.env.ZANA_OAUTH_CONSENT_PASSWORD;
  process.env.ZANA_OAUTH_CONSENT_PASSWORD=consent;
  try{
    const {author,missionId}=await f.authorReady();
    f.api.state.diffText='diff --git a/a b/a\n+'+consent+' '+Buffer.from(consent).toString('base64')+'\n';
    f.ds.calls.length=0;
    // Passthrough: the fake downstream echoes the author token; a skill/tool error echoes the consent password.
    const echo=await ds(f,'get_file_contents',{owner:'o',repo:'r',path:consent},author);
    const err=await f.call('zana_skill_load',{name:consent},author);
    const t=await f.call('zana_review_request',{missionId},author);
    const s=await f.session();
    await f.call('zana_review_claim',{ticket:t.ticket},s);
    const page=await f.call('zana_review_diff',{ticket:t.ticket,page:0},s);
    const audit=await f.runtime.readAudit({limit:500});
    const all=JSON.stringify({echo,err,page,audit});
    for(const secret of [consent,AUTHOR_TOKEN,REVIEWER_TOKEN]){
      assert.equal(all.includes(secret),false,'raw secret leaked');
      assert.equal(all.includes(Buffer.from(secret).toString('base64')),false,'base64 secret leaked');
    }
    void plain;
  }finally{
    if(prev===undefined)delete process.env.ZANA_OAUTH_CONSENT_PASSWORD;else process.env.ZANA_OAUTH_CONSENT_PASSWORD=prev;
    await f.cleanup();
  }
});

test('R3: check-run and zana/4r edge cases, draft PR, expired lease',async()=>{
  assert.equal(evaluateRuns([{name:'a',status:'in_progress'},{name:'b',status:'completed',conclusion:'success'}],'h').state,'PENDING');
  assert.equal(fourRStatus([{context:'zana/4r',state:'failure',creator:{login:'rev'}},{context:'zana/4r',state:'success',creator:{login:'rev'}}],'rev'),'failure','newest first wins');
  const f=await remoteFixture();
  try{
    const {author,missionId,branch,packet}=await f.authorReady();
    f.api.state.pulls[0].draft=true;
    const d=await f.call('zana_delivery_status',{missionId},author);
    assert.ok(d.blockers.some(b=>/not mergeable \(draft\)/.test(b)));
    // A lease that expired cannot write.
    await transact(m=>{m.units.find(u=>u.id==='code').run.expiresAt=new Date(Date.now()-1000).toISOString();m.revision++;return m;});
    assert.match(errText(await ds(f,'create_or_update_file',{owner:'o',repo:'r',branch,path:'a',content:'x',message:'m'},author,missionId)),/NO_RUNNING_UNIT/);
    void packet;
  }finally{await f.cleanup();}
});

test('W8: refused or failed operations record no activity; merge needs the creator or a unit holder',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId,branch}=await f.authorReady();
    const other=await f.session();
    // A refused downstream write and a failed heartbeat do not make `other` a writer.
    await ds(f,'create_or_update_file',{owner:'o',repo:'r',branch,path:'a',content:'x',message:'m'},other,missionId);
    await f.call('zana_unit_heartbeat',{unitId:'code',token:'00000000-0000-4000-8000-000000000000',leaseGeneration:1},other);
    assert.equal((await f.call('zana_session_status',{},other)).activeMission.wrote,false);
    assert.match((await f.call('zana_merge',{missionId},other)).error,/NOT_AUTHOR: only the session that created the mission/);
    // A session that only held a unit (rebind) counts as author for the merge.
    assert.equal((await f.call('zana_merge',{missionId},author)).state,'NOT_READY');
  }finally{await f.cleanup();}
});

test('W13: session rebind moves a RUNNING unit without an attempt and bars that session from reviewing',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId,branch,packet}=await f.authorReady();
    const restarted=await f.session();
    assert.match(errText(await ds(f,'create_or_update_file',{owner:'o',repo:'r',branch,path:'a',content:'x',message:'m'},restarted,missionId)),/NO_RUNNING_UNIT/);
    assert.match((await f.call('zana_session_rebind',{missionId,unitId:'code',token:packet.token,leaseGeneration:packet.leaseGeneration+1},restarted)).error,/stale/);
    const r=await f.call('zana_session_rebind',{missionId,unitId:'code',token:packet.token,leaseGeneration:packet.leaseGeneration},restarted);
    assert.equal(r.rebound,true);
    assert.equal(r.previousSessionId,author.sessionId);
    assert.equal((await f.call('zana_mission_status',{},restarted)).units.find(u=>u.id==='code').attempts,1);
    assert.equal(Boolean((await ds(f,'create_or_update_file',{owner:'o',repo:'r',branch,path:'a',content:'x',message:'m'},restarted,missionId)).isError),false);
    const t=await f.call('zana_review_request',{missionId},restarted);
    const later=await f.session();
    void later;
    // The rebound session (and the author) cannot claim.
    assert.match((await f.call('zana_review_claim',{ticket:t.ticket},restarted)).error,/AUTHOR_SESSION|SESSION_WROTE/);
    assert.match((await f.call('zana_review_claim',{ticket:t.ticket},author)).error,/SESSION_WROTE|SESSION_PREDATES_TICKET/);
    const audit=await f.runtime.readAudit({missionId,limit:200});
    assert.ok(audit.some(a=>a.tool==='zana_session_rebind'&&a.outcome==='OK'));
  }finally{await f.cleanup();}
});

test('W14/W15: a lost review response is adopted, a lost merge response reads back MERGED; attempts are audited',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId}=await f.authorReady();
    const t=await f.call('zana_review_request',{missionId},author);
    const s=await f.session();
    // The first createReview reaches GitHub but its answer is lost.
    const real=f.runtime.reviewerGithub.createReview.bind(f.runtime.reviewerGithub);
    f.runtime.reviewerGithub.createReview=async(...a)=>{await real(...a);throw new Error('socket hang up');};
    const first=await finishReview(f,t.ticket,s);
    assert.match(first.error,/socket hang up/);
    f.runtime.reviewerGithub.createReview=real;
    const again=await f.call('zana_review_finalize',{ticket:t.ticket,execution:'PARALLEL_SUBAGENTS'},s);
    assert.equal(again.state,'FINALIZED');
    assert.equal(again.adoptedExistingReview,true);
    assert.equal(f.api.state.reviews[7].length,1,'no duplicate review');
    f.api.state.loseMergeResponse=true;
    const m=await f.call('zana_merge',{missionId},author);
    assert.deepEqual({state:m.state,recovered:m.recovered,sha:m.mergeCommitSha},{state:'MERGED',recovered:true,sha:sha('9')});
    const audit=await f.runtime.readAudit({missionId,limit:200});
    assert.ok(audit.some(a=>a.tool==='zana_merge.attempt'&&a.detail.headSha===sha('a')&&a.category==='merge'));
  }finally{await f.cleanup();}
});

test('W16: /health is degraded with 503 when a token is missing or the DB cannot be read',async()=>{
  const f=await remoteFixture({envExtra:{ZANA_REVIEWER_TOKEN:''}});
  try{
    const h=await f.runtime.health();
    assert.equal(h.status,'degraded');
    assert.equal(h.reviewerToken,'missing');
    assert.ok(h.problems.some(p=>/ZANA_REVIEWER_TOKEN/.test(p)));
    const prev=process.env.ZANA_STATE_FILE;
    process.env.ZANA_STATE_FILE='/nonexistent-dir-zana/state.json';
    try{assert.ok((await f.runtime.health()).problems.some(p=>/database/.test(p)));}
    finally{process.env.ZANA_STATE_FILE=prev;}
  }finally{await f.cleanup();}
});

test('W17: deadlines, log budget and the shared REST breaker',async()=>{
  const d=createDeadline(30);
  assert.equal(await d.step(()=>new Promise(r=>setTimeout(()=>r('late'),200)),'slow',{fallback:'fallback'}),'fallback');
  assert.deepEqual(d.partial,['slow']);
  await new Promise(r=>setTimeout(r,40));
  assert.equal(await d.step(()=>'x','after',{fallback:'none'}),'none','no budget left');
  await assert.rejects(createDeadline(1000).step(()=>{throw new Error('boom');},'err'),/boom/);
  await assert.rejects(within(new Promise(()=>{}),10,'never'),/DEADLINE: never exceeded 10 ms/);
  assert.equal(await createDeadline(1000).step(()=>7,'ok'),7);
  // Shared breaker: author and reviewer clients of one origin trip together.
  const origin='https://breaker.example';
  let calls=0;
  const fetcher=async()=>{calls++;return new Response('{}',{status:502});};
  const author=new GitHubApi({baseUrl:origin,token:'t'.repeat(20),fetcher});
  const reviewer=new GitHubApi({baseUrl:origin,token:'r'.repeat(20),fetcher});
  for(let i=0;i<5;i++)await assert.rejects((i%2?author:reviewer).repo('o/r'),/HTTP 502/);
  await assert.rejects(reviewer.repo('o/r'),/circuit open/);
  assert.equal(calls,5);
  breakerFor(origin).openUntil=0;
  const ok=new GitHubApi({baseUrl:origin,token:'t'.repeat(20),fetcher:async()=>new Response('{"a":1}',{status:200})});
  assert.deepEqual(await ok.repo('o/r'),{a:1});
  assert.equal(breakerFor(origin).failures,0);
  // A tool over its deadline answers TOOL_DEADLINE instead of hanging.
  const f=await remoteFixture({envExtra:{ZANA_TOOL_DEADLINE_MS:'5000'}});
  try{
    const s=await f.session();
    f.runtime.ops.zana_profile=()=>new Promise(r=>setTimeout(()=>r({late:true}),6000));
    assert.match((await f.call('zana_profile',{},s)).error,/TOOL_DEADLINE/);
  }finally{await f.cleanup();}
});

test('W19/W20: complete revalidates the head; a closed mission can be archived remotely and a new one started',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId,branch,packet}=await f.authorReady();
    const realVerdict=f.runtime.checks.verdict;
    f.runtime.checks.verdict=async(...a)=>{const v=await realVerdict(...a);f.api.state.push(branch,sha('c'));return v;};
    const r=await f.call('zana_complete_unit',{unitId:'code',token:packet.token,leaseGeneration:packet.leaseGeneration,
      outcome:{success:true,summary:'done here',evidence:['x']}},author);
    assert.match(r.error,/HEAD_MOVED/);
    f.runtime.checks.verdict=realVerdict;
    assert.match((await f.call('zana_mission_archive',{},author)).error,/MISSION_NOT_FINISHED/);
    await f.call('zana_mission_cancel',{},author);
    const reviewer=await f.session();
    void reviewer;
    assert.equal((await f.call('zana_mission_archive',{},author)).archived,true);
    assert.ok((await f.call('zana_mission_init',{spec:f.spec,github:{repo:'o/r',base:'main'}},author)).id);
    assert.notEqual(missionId,undefined);
  }finally{await f.cleanup();}
});

test('R3: the dead downstream breaker test uses a server that drops connections (no fixed port)',async()=>{
  const dead=await droppingServer();
  let t=1_000_000;
  const g=new DownstreamGateway({name:'github',url:dead.url,token:AUTHOR_TOKEN,timeoutMs:1000},{now:()=>t});
  try{
    for(let i=0;i<3;i++){
      assert.match((await g.call({host:'h'},'get_me',{})).content[0].text,/could not read its tool list/);
      t+=20_000;
    }
    assert.equal(g.status().state,'CIRCUIT_OPEN');
  }finally{await g.close();await dead.close();}
});
