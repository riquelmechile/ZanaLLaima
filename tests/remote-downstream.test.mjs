import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture,AUTHOR_TOKEN,sha} from './helpers/remote-fixture.mjs';
import {CATALOG,catalogProblems,liveProblems,safeRepoPath,createGitHubPolicy} from '../src/github-policy.mjs';
import {verifyActorAssertion} from '../src/actor-assertion.mjs';

const ds=(f,operation,args,s,missionId)=>f.call('zana_ds_github',{operation,arguments:args,...(missionId?{missionId}:{})},s);
const errText=r=>r.raw?.content?.[0]?.text??r.content?.[0]?.text??'';
const isErr=r=>Boolean(r.error||r.isError);

test('catalog: every GitHub tool of the pinned server version is classified',()=>{
  assert.equal(CATALOG.version,'v2.1.0');
  assert.deepEqual(CATALOG.toolsets,['context','repos','pull_requests','git','actions']);
  assert.deepEqual(catalogProblems(),[]);
  // An unclassified write in a future snapshot must fail this test.
  const future={...CATALOG,tools:{...CATALOG.tools,delete_branch:{toolset:'repos',readOnlyHint:false,destructiveHint:true}}};
  assert.deepEqual(catalogProblems(future),['delete_branch: unclassified']);
  assert.deepEqual(catalogProblems({tools:{a:{zana:'read',readOnlyHint:false},b:{zana:'write',rule:'x'},c:{zana:'deny'}}}),
    ['a: read without readOnlyHint','b: unknown write rule x','b: write without ALLOWED_KEYS','c: deny without reason']);
  for(const name of ['merge_pull_request','pull_request_review_write','delete_repository','create_pull_request_review',
    'update_pull_request_branch','fork_repository','create_repository'])
    assert.equal(CATALOG.tools[name].zana,'deny',name);
});

test('repository paths: workflows, .git and traversal are never writable',()=>{
  for(const bad of ['.github/workflows/ci.yml','.GitHub/Workflows/x.yml','.github/workflows. /x','a/../b','/etc/passwd',
    'a//b','./a','x/.git/config','.git/hooks/pre-commit','a\\b','',null,'a/','x'.repeat(401),'a\0b'])
    assert.equal(safeRepoPath(bad),false,String(bad));
  for(const ok of ['src/a.mjs','.github/ISSUE_TEMPLATE.md','README.md','.github/dependabot.yml'])
    assert.equal(safeRepoPath(ok),true,ok);
});

test('reads always pass; every always-denied tool is refused, audited and never forwarded',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId}=await f.authorReady();
    const index=await ds(f,'index',{},author);
    assert.equal(index.catalogVersion,'v2.1.0');
    assert.deepEqual(index.problems,[]);
    assert.equal(index.tools.find(t=>t.name==='merge_pull_request').zana,'deny');
    const one=await ds(f,'index',{operation:'push_files'},author);
    assert.equal(one.rule,'files');
    assert.match((await ds(f,'index',{operation:'nope'},author)).error,/Unknown tool/);
    const read=await ds(f,'get_file_contents',{owner:'o',repo:'r',path:'README.md'},author);
    assert.equal(isErr(read),false);
    const denied=Object.entries(CATALOG.tools).filter(([,t])=>t.zana==='deny'&&t.toolset!=='issues');
    assert.ok(denied.length>=20);
    for(const [name,t] of denied){
      const r=await ds(f,name,{owner:'o',repo:'r',pullNumber:7},author,missionId);
      assert.equal(isErr(r),true,name);
      assert.match(errText(r),/ALWAYS_DENIED/,name);
      assert.ok(errText(r).includes(t.reason),name);
    }
    assert.equal(f.ds.calls.filter(c=>c.name!=='get_file_contents').length,0,'no denied call was forwarded');
    const audit=await f.runtime.readAudit({limit:200});
    assert.ok(audit.some(a=>a.tool==='github.merge_pull_request'&&a.outcome==='REFUSED'&&a.sessionId===author.sessionId));
    assert.ok(audit.every(a=>!JSON.stringify(a).includes(AUTHOR_TOKEN)));
  }finally{await f.cleanup();}
});

test('mission-branch writes: allowed with a RUNNING unit, refused outside the branch, without unit, on workflows',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId,branch,packet}=await f.authorReady({pull:false});
    const base={owner:'o',repo:'r',message:'m'};
    const created=await ds(f,'create_branch',{owner:'o',repo:'r',branch,from_branch:'main'},author,missionId);
    assert.equal(isErr(created),false,errText(created));
    const file=await ds(f,'create_or_update_file',{...base,branch,path:'src/sum.mjs',content:'x'},author,missionId);
    assert.equal(isErr(file),false);
    const call=f.ds.calls.find(c=>c.name==='create_or_update_file');
    const claims=verifyActorAssertion(call.meta['zana-llaima/actor'],f.runtime.actorKeys().keys[0],
      {aud:'github',tool:'create_or_update_file',args:call.args});
    assert.equal(claims.sub,'zana-chatgpt');
    assert.equal(claims.mission,missionId);
    assert.ok(f.ds.headers.every(h=>h.toolsets==='context,repos,pull_requests,git,actions'));
    const cases=[
      ['create_or_update_file',{...base,branch:'main',path:'a'},/OUTSIDE_MISSION_BRANCH/],
      ['create_or_update_file',{...base,branch,path:'.github/workflows/ci.yml'},/PROTECTED_PATH/],
      ['push_files',{...base,branch,files:[{path:'ok.txt',content:''},{path:'.github/workflows/x.yml',content:''}]},/PROTECTED_PATH/],
      ['push_files',{...base,branch,files:[]},/INVALID_FILES/],
      ['push_files',{...base,branch:'feature',files:[{path:'a'}]},/OUTSIDE_MISSION_BRANCH/],
      ['delete_file',{...base,branch,path:'../x'},/PROTECTED_PATH/],
      ['create_branch',{owner:'o',repo:'r',branch:'other',from_branch:'main'},/OUTSIDE_MISSION_BRANCH/],
      ['create_branch',{owner:'o',repo:'r',branch,from_branch:'dev'},/WRONG_BASE/],
      ['create_or_update_file',{owner:'o',repo:'other',message:'m',branch,path:'a'},/OUTSIDE_MISSION_REPO/],
      ['create_pull_request',{owner:'o',repo:'r',title:'t',head:'main',base:'main'},/OUTSIDE_MISSION_BRANCH/],
      ['create_pull_request',{owner:'o',repo:'r',title:'t',head:branch,base:'dev'},/WRONG_BASE/],
      ['create_pull_request',{owner:'o',repo:'r',title:'t',head:branch,base:'main',reviewers:['x']},/FIELD_NOT_ALLOWED/],
      ['create_pull_request',{owner:'o',repo:'r',title:'t',head:branch,base:'main',draft:true},/DRAFT_NOT_ALLOWED/],
      ['actions_run_trigger',{owner:'o',repo:'r',method:'cancel_workflow_run',run_id:1},/FIELD_NOT_ALLOWED: actions_run_trigger does not accept run_id/],
      ['actions_run_trigger',{owner:'o',repo:'r',method:'cancel_workflow_run'},/METHOD_NOT_ALLOWED/],
      ['actions_run_trigger',{owner:'o',repo:'r',method:'run_workflow',workflow_id:'ci.yml',ref:branch},/WORKFLOW_NOT_ALLOWED/],
      ['actions_run_trigger',{owner:'o',repo:'r',method:'run_workflow',workflow_id:'zana-checks.yml',ref:'main'},/OUTSIDE_MISSION_BRANCH/],
      ['actions_run_trigger',{owner:'o',repo:'r',method:'run_workflow',workflow_id:'zana-checks.yml',ref:branch,inputs:{a:1}},/FIELD_NOT_ALLOWED/],
      ['create_or_update_file',{...base,branch,path:'a'},/MISSION_REQUIRED/,null],
      ['create_or_update_file',{...base,branch,path:'a'},/UNKNOWN_MISSION/,'00000000-0000-0000-0000-000000000000'],
    ];
    for(const [tool,args,code,mid=missionId] of cases){
      const r=await ds(f,tool,args,author,mid??undefined);
      assert.match(errText(r),code,tool+' '+JSON.stringify(args));
    }
    const pr=await ds(f,'create_pull_request',{owner:'o',repo:'r',title:'t',head:'o:'+branch,base:'main',body:'b'},author,missionId);
    assert.equal(isErr(pr),false);
    const dispatch=await ds(f,'actions_run_trigger',{owner:'o',repo:'r',method:'run_workflow',workflow_id:'zana-checks.yml',ref:branch},author,missionId);
    assert.equal(isErr(dispatch),false);
    // Another session without a RUNNING unit of its own.
    const other=await f.session();
    assert.match(errText(await ds(f,'create_or_update_file',{...base,branch,path:'a'},other,missionId)),/NO_RUNNING_UNIT/);
    // After the unit is completed the author holds no RUNNING unit either.
    const done=await f.call('zana_complete_unit',{unitId:'code',token:packet.token,leaseGeneration:packet.leaseGeneration,
      outcome:{success:true,summary:'implemented with test',evidence:['head '+sha('a')]}},author);
    assert.equal(done.error,undefined,done.error);
    assert.equal(done.checkedSha,sha('a'));
    assert.match(errText(await ds(f,'create_or_update_file',{...base,branch,path:'a'},author,missionId)),/NO_RUNNING_UNIT/);
  }finally{await f.cleanup();}
});

test('PR edits: only title and body of the mission PR; replies and comments only on it',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId,branch}=await f.authorReady({complete:false});
    f.api.state.pulls.push({number:9,state:'open',head:{ref:'feature',sha:sha('b'),repo:{full_name:'o/r'}},base:{ref:'main'}});
    f.api.state.pulls.push({number:10,state:'closed',head:{ref:branch,sha:sha('a'),repo:{full_name:'o/r'}},base:{ref:'main'}});
    f.api.state.pulls.push({number:11,state:'open',head:{ref:branch,sha:sha('a'),repo:{full_name:'o/r'}},base:{ref:'dev'}});
    f.api.state.comments[5]={pull_request_url:'https://api.github.com/repos/o/r/pulls/7'};
    f.api.state.comments[6]={pull_request_url:'https://api.github.com/repos/o/r/pulls/9'};
    const ok=[['update_pull_request',{owner:'o',repo:'r',pullNumber:7,title:'new'}],
      ['update_pull_request_title',{owner:'o',repo:'r',pullNumber:7,title:'new'}],
      ['update_pull_request_body',{owner:'o',repo:'r',pullNumber:7,body:'b'}],
      ['add_reply_to_pull_request_comment',{owner:'o',repo:'r',pullNumber:7,commentId:5,body:'thanks'}]];
    for(const [tool,args] of ok)assert.equal(isErr(await ds(f,tool,args,author,missionId)),false,tool);
    const bad=[
      ['update_pull_request',{owner:'o',repo:'r',pullNumber:7,state:'closed'},/FIELD_NOT_ALLOWED/],
      ['update_pull_request',{owner:'o',repo:'r',pullNumber:7,base:'dev'},/FIELD_NOT_ALLOWED/],
      ['update_pull_request',{owner:'o',repo:'r',pullNumber:7},/FIELD_NOT_ALLOWED/],
      ['update_pull_request',{owner:'o',repo:'r',pullNumber:9,title:'x'},/OUTSIDE_MISSION_PR/],
      ['update_pull_request',{owner:'o',repo:'r',pullNumber:10,title:'x'},/not open/],
      ['update_pull_request',{owner:'o',repo:'r',pullNumber:11,title:'x'},/mission base/],
      ['update_pull_request_title',{owner:'o',repo:'r',title:'x'},/number required/],
      ['add_reply_to_pull_request_comment',{owner:'o',repo:'r',pullNumber:7,commentId:6,body:'x'},/OUTSIDE_MISSION_PR/],
      ['add_reply_to_pull_request_comment',{owner:'o',repo:'r',pullNumber:9,commentId:6,body:'x'},/OUTSIDE_MISSION_PR/],
      ['add_reply_to_pull_request_comment',{owner:'o',repo:'r',pullNumber:7,commentId:5,reaction:'+1'},/FIELD_NOT_ALLOWED/],
    ];
    for(const [tool,args,code] of bad)assert.match(errText(await ds(f,tool,args,author,missionId)),code,tool+JSON.stringify(args));
  }finally{await f.cleanup();}
});

test('unclassified and drifted tools are denied; tokens never reach results or errors',async()=>{
  const f=await remoteFixture({mcp:{echoToken:true,
    extra:[{name:'delete_branch',annotations:{readOnlyHint:false,destructiveHint:true}},
      {name:'shiny_read',annotations:{readOnlyHint:true}}],
    annotationsOverride:{get_me:{readOnlyHint:false,destructiveHint:false}}}});
  try{
    const {author,missionId}=await f.authorReady();
    const index=await ds(f,'index',{},author);
    assert.deepEqual(index.problems.map(p=>p.tool+':'+p.problem).sort(),
      ['delete_branch:UNCLASSIFIED','get_me:CLASSIFICATION_DRIFT','shiny_read:UNCLASSIFIED']);
    assert.match(errText(await ds(f,'delete_branch',{owner:'o',repo:'r',branch:'x'},author,missionId)),/UNCLASSIFIED/);
    assert.match(errText(await ds(f,'shiny_read',{},author)),/UNCLASSIFIED/);
    assert.match(errText(await ds(f,'get_me',{},author)),/CLASSIFICATION_DRIFT/);
    assert.match(errText(await ds(f,'does_not_exist',{},author)),/Unknown tool/);
    const echoed=await ds(f,'get_file_contents',{owner:'o',repo:'r',path:'x'},author);
    const text=JSON.stringify(echoed);
    assert.equal(text.includes(AUTHOR_TOKEN),false);
    assert.match(text,/\[redacted\]/);
    // A policy that throws fails closed and never echoes the token.
    const policy=createGitHubPolicy({config:{checksWorkflow:'zana-checks.yml'},
      deps:{github:{pull:async()=>{throw new Error('boom '+AUTHOR_TOKEN);}},missionContext:async()=>null}});
    assert.equal((await policy({caller:{},tool:'get_me',args:{},cls:'read'})).allowed,true);
    assert.match((await policy({caller:{},tool:'push_files',args:[],cls:'write',missionId:'m'})).reason,/INVALID_ARGUMENTS/);
    const unknownRule=createGitHubPolicy({config:{},catalog:{version:'t',tools:{x:{zana:'write',rule:'mystery'}}},
      deps:{github:{repo:async()=>({default_branch:'main'})},missionContext:async()=>({status:'ACTIVE',reviewer:false,
        runningForSession:true,repo:'o/r',branch:'zana/m',base:'main'})}});
    assert.match((await unknownRule({caller:{},tool:'x',args:{owner:'o',repo:'r'},cls:'write',missionId:'m'})).reason,/UNCLASSIFIED/);
    const inactive=createGitHubPolicy({config:{},deps:{github:{},missionContext:async()=>({status:'CLOSED'})}});
    assert.match((await inactive({caller:{},tool:'push_files',args:{},cls:'write',missionId:'m'})).reason,/MISSION_NOT_ACTIVE/);
    const badBranch=createGitHubPolicy({config:{},deps:{github:{},missionContext:async()=>({status:'ACTIVE',reviewer:false,
      runningForSession:true,repo:'o/r',branch:'bad..branch',base:'main'})}});
    assert.match((await badBranch({caller:{},tool:'push_files',args:{owner:'o',repo:'r'},cls:'write',missionId:'m'})).reason,/invalid mission branch/);
    const isDefault=createGitHubPolicy({config:{},deps:{github:{repo:async()=>({default_branch:'zana/m'})},
      missionContext:async()=>({status:'ACTIVE',reviewer:false,runningForSession:true,repo:'o/r',branch:'zana/m',base:'main'})}});
    assert.match((await isDefault({caller:{},tool:'delete_file',args:{owner:'o',repo:'r',branch:'zana/m',path:'a'},
      cls:'destructive',missionId:'m'})).reason,/DEFAULT_BRANCH/);
    const comment=createGitHubPolicy({config:{},deps:{github:{pull:async()=>({state:'open',head:{ref:'zana/m',repo:{full_name:'o/r'}},base:{ref:'main'}})},
      missionContext:async()=>({status:'ACTIVE',reviewer:false,runningForSession:true,repo:'o/r',branch:'zana/m',base:'main'})}});
    assert.equal((await comment({caller:{},tool:'add_issue_comment',args:{owner:'o',repo:'r',issue_number:7,body:'hi'},cls:'write',missionId:'m'})).allowed,true);
    assert.match((await comment({caller:{},tool:'add_issue_comment',args:{owner:'o',repo:'r',issue_number:7,reaction:'+1'},cls:'write',missionId:'m'})).reason,/FIELD_NOT_ALLOWED/);
    assert.deepEqual(liveProblems([{name:'get_me',cls:'read'}]),[]);
  }finally{await f.cleanup();}
});
