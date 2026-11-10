import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ActorSigner,verifyActorAssertion,canonicalJson,argsDigest} from '../src/actor-assertion.mjs';
import {DownstreamGateway,parseDownstreamConfig,allowedUrl,classify,routerFor} from '../src/downstream.mjs';
import {GitHubApi,validRepo,validRefName} from '../src/github-api.mjs';
import {independentReview,missionPull,deliveryStatus,mergeMission,fourRStatus,ticketView} from '../src/github-delivery.mjs';
import {makeExclusive} from '../src/remote-review.mjs';
import {remoteConfig,repoAllowed} from '../src/remote-config.mjs';
import {registerSession,readAudit,audit,remoteMission,sessionRow} from '../src/remote-state.mjs';
import {listSkills,loadSkill,parseFrontmatter} from '../src/skills.mjs';
import {redactText,redactDeep,clean,secretForms} from '../src/redact.mjs';
import {evaluateRuns} from '../src/checks.mjs';
import {ensureSchema} from '../src/store.mjs';
import {fakeGitHubMcp,AUTHOR_TOKEN} from './helpers/fake-github.mjs';

const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');

test('actor assertion: signs one call and rejects every mismatch',()=>{
  const signer=ActorSigner.generate();
  const copy=ActorSigner.fromPkcs8(signer.exportPkcs8());
  assert.equal(copy.kid,signer.kid);
  assert.throws(()=>new ActorSigner(generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey),/Ed25519/);
  const now=Math.floor(Date.now()/1000);
  const claims={iss:'zana-llaima',aud:'github',sub:'h',role:'author',jti:'j',tool:'t',args:argsDigest({a:1}),iat:now,exp:now+60};
  const token=signer.sign(claims);
  const expect={aud:'github',tool:'t',args:{a:1}};
  assert.equal(verifyActorAssertion(token,signer.jwk(),expect).sub,'h');
  assert.equal(verifyActorAssertion(token,signer.publicKey,expect).sub,'h');
  const [h,,sig]=token.split('.');
  const forge=c=>h+'.'+b64(c)+'.'+sig;
  const resign=(c,head={alg:'EdDSA',typ:'zana-actor+jwt',kid:signer.kid})=>{
    const t=signer.sign(c);const parts=t.split('.');return b64(head)+'.'+parts[1]+'.'+parts[2];};
  const cases=[[null,/missing/],['a.b',/malformed/],['a.b.c',/malformed/],['!!.x.y',/malformed/],[token.split('.').slice(0,2).join('.')+'.!!',/base64url/],
    [resign(claims,{alg:'HS256',typ:'zana-actor+jwt'}),/algorithm/],[forge({...claims,sub:'x'}),/bad signature/],
    [signer.sign({...claims,iss:'x'}),/issuer/],[signer.sign({...claims,aud:'x'}),/another server/],
    [signer.sign({...claims,tool:'x'}),/another tool/],[signer.sign({...claims,args:'x'}),/arguments differ/],
    [signer.sign({...claims,role:'boss'}),/incomplete/],[signer.sign({...claims,exp:now+1000}),/lifetime/],
    [signer.sign({...claims,iat:now+500,exp:now+600}),/future/],[signer.sign({...claims,iat:now-1000,exp:now-900}),/expired/]];
  for(const [t,re] of cases)assert.throws(()=>verifyActorAssertion(t,signer.jwk(),expect),re);
  assert.throws(()=>verifyActorAssertion(token,{...signer.jwk(),kid:'other'},expect),/another key/);
  const rsa=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey;
  assert.throws(()=>verifyActorAssertion(token,rsa,expect),/Ed25519/);
  assert.equal(canonicalJson({b:[1,undefined],a:{d:null,c:()=>1}}),'{"a":{"d":null},"b":[1,null]}');
  assert.equal(canonicalJson(undefined),'null');
});

test('downstream config, URLs and classes',()=>{
  assert.equal(classify({readOnlyHint:true}),'read');
  assert.equal(classify({destructiveHint:false}),'write');
  assert.equal(classify(undefined),'destructive');
  for(const ok of ['https://api.githubcopilot.com/mcp/','http://127.0.0.1:1/mcp','http://localhost/x','http://10.0.0.1/',
    'http://192.168.1.1/','http://172.16.0.1/','http://[::1]/','http://[fd00::1]/'])assert.equal(allowedUrl(ok),true,ok);
  for(const bad of ['ftp://x','http://example.com/','https://u:p@x/','https://x/?q','https://x/#h','nope','http://8.8.8.8/','http://[2001:db8::1]/'])
    assert.equal(allowedUrl(bad),false,bad);
  const base={name:'github',url:'https://x/mcp'};
  assert.throws(()=>parseDownstreamConfig(null),/not an object/);
  assert.throws(()=>parseDownstreamConfig({...base,name:'Bad'}),/name/);
  assert.throws(()=>parseDownstreamConfig({...base,url:'http://evil.example/'}),/url/);
  assert.throws(()=>parseDownstreamConfig({...base,writes:'yes'}),/writes/);
  assert.throws(()=>parseDownstreamConfig({...base,timeoutMs:5}),/timeoutMs/);
  assert.throws(()=>parseDownstreamConfig({...base,headers:{authorization:'x'}}),/header/);
  assert.throws(()=>parseDownstreamConfig({...base,headers:{'x-a':'b\nc'}}),/header/);
  assert.equal(parseDownstreamConfig(base).writes,'grant');
  assert.equal(routerFor('github'),'zana_ds_github');
});

test('downstream gateway: missing token, writes deny, tool errors, policy failure, circuit breaker',async()=>{
  const missing=new DownstreamGateway({name:'github',url:'https://never-contacted.invalid/mcp'});
  assert.equal(missing.status().state,'TOKEN_MISSING');
  assert.match((await missing.call({host:'h'},'x',{})).content[0].text,/token is not set/);
  const mcp=await fakeGitHubMcp({extra:[{name:'boom',annotations:{readOnlyHint:true}}]});
  try{
    const audits=[];
    const deny=new DownstreamGateway({name:'github',url:mcp.url,token:AUTHOR_TOKEN,writes:'deny'},{audit:async e=>audits.push(e)});
    assert.match((await deny.call({host:'h'},'push_files',{})).content[0].text,/writes: deny/);
    assert.equal((await deny.call({host:'h'},'get_me',{})).isError,undefined);
    assert.equal(deny.status().state,'OK');
    const throwing=new DownstreamGateway({name:'github',url:mcp.url,token:AUTHOR_TOKEN},{policy:async()=>{throw new Error('db down '+AUTHOR_TOKEN);}});
    const r=await throwing.call({host:'h'},'get_me',{});
    assert.match(r.content[0].text,/Policy failed closed/);
    assert.equal(r.content[0].text.includes(AUTHOR_TOKEN),false);
    const allow=new DownstreamGateway({name:'github',url:mcp.url,token:AUTHOR_TOKEN,writes:'allow'});
    assert.equal((await allow.call({host:'h'},'push_files',{},{missionId:'m'})).isError,undefined);
    assert.ok(audits.every(a=>a.args!==undefined&&a.outcome));
  }finally{await mcp.close();}
  // The dead-server breaker is covered with a connection-dropping server in remote-round1-warnings.
});

test('GitHub REST client: guards, errors, pagination limits and job logs',async()=>{
  assert.throws(()=>new GitHubApi({baseUrl:'https://u:p@x'}),/Invalid GitHub API URL/);
  assert.equal(validRepo('o/r'),true);
  for(const bad of ['o','../r','o/..','o/r/x',3])assert.equal(validRepo(bad),false);
  for(const bad of ['','/a','a/','a//b','a@{b','@','a/.b','a.lock','a..b','a b','x'.repeat(201)])assert.equal(validRefName(bad),false,bad);
  assert.equal(validRefName('zana/0f-1'),true);
  const none=new GitHubApi({});
  assert.equal(none.configured,false);
  await assert.rejects(none.repo('o/r'),/not configured/);
  const reply=(status,body,headers={})=>new Response(status===204?null:typeof body==='string'?body:JSON.stringify(body),{status,headers});
  const seq=responses=>{const calls=[];const fetcher=async(url,init)=>{calls.push({url,init});const r=responses.shift();if(r instanceof Error)throw r;return r;};
    return {calls,api:new GitHubApi({token:'t'.repeat(20),fetcher})};};
  let {api}=seq([new Error('ECONNREFUSED t'.padEnd(40,'t'))]);
  await assert.rejects(api.repo('o/r'),/unreachable/);
  ({api}=seq([reply(500,'not json')]));
  await assert.rejects(api.repo('o/r'),/HTTP 500$/);
  ({api}=seq([reply(200,'{bad')]));
  await assert.rejects(api.repo('o/r'),/without JSON/);
  ({api}=seq([reply(200,'x'.repeat(2_000_001))]));
  await assert.rejects(api.repo('o/r'),/too large/);
  ({api}=seq([reply(204,'')]));
  assert.equal(await api.dispatchWorkflow('o/r','w.yml','zana/x'),null);
  await assert.rejects(api.dispatchWorkflow('o/r','../w','zana/x'),/Invalid workflow/);
  await assert.rejects(api.repo('bad'),/Invalid repository/);
  await assert.rejects(api.branchHead('o/r','a..b'),/Invalid branch/);
  await assert.rejects(api.pull('o/r',0),/Invalid number/);
  await assert.rejects(api.checkRuns('o/r','abc'),/Invalid commit SHA/);
  ({api}=seq([reply(200,{commit:{sha:'nope'}})]));
  await assert.rejects(api.branchHead('o/r','main'),/Invalid commit SHA/);
  const page=n=>reply(200,Array.from({length:n},(_,i)=>({id:i})));
  ({api}=seq([page(100),page(100),page(100)]));
  await assert.rejects(api.pullCommits('o/r',1),/more than 300/);
  ({api}=seq([reply(200,{})]));
  await assert.rejects(api.pullCommits('o/r',1),/Unreadable/);
  ({api}=seq(Array.from({length:10},()=>page(100))));
  await assert.rejects(api.pullReviews('o/r',1),/10-page/);
  ({api}=seq([reply(200,{})]));
  await assert.rejects(api.pullReviews('o/r',1),/Unreadable/);
  ({api}=seq([reply(200,{total_count:101,check_runs:[]})]));
  await assert.rejects(api.checkRuns('o/r','a'.repeat(40)),/More than 100/);
  ({api}=seq([reply(200,{}),reply(200,{}),reply(200,{})]));
  assert.deepEqual(await api.checkRuns('o/r','a'.repeat(40)),[]);
  assert.deepEqual(await api.statuses('o/r','a'.repeat(40)),[]);
  assert.deepEqual(await api.workflowRuns('o/r','a'.repeat(40)),[]);
  ({api}=seq([reply(200,null)]));
  assert.deepEqual(await api.openPullsFor('o/r','b'),[]);
  const s=seq([reply(302,'',{location:'https://blob.example/log'}),reply(200,'a\n\x1b[1mb\x1b[0m\nBearer '+'z'.repeat(30)+'\n')]);
  assert.deepEqual(await s.api.jobLogTail('o/r',5,2),['b','Bearer [redacted]']);
  assert.equal(s.calls[1].init.headers,undefined,'no Authorization sent to the log host');
  ({api}=seq([reply(302,'',{location:'http://blob.example/log'})]));
  await assert.rejects(api.jobLogTail('o/r',5),/log unavailable|redirect refused/i);
  ({api}=seq([reply(410,'gone')]));
  await assert.rejects(api.jobLogTail('o/r',5),/HTTP 410/);
});

test('delivery helpers: missing PR, unreadable evidence, dismissed review, merge outcomes',async()=>{
  const ctx={missionId:'m',repo:'o/r',branch:'zana/m',base:'main'};
  const gh=over=>({openPullsFor:async()=>[],pull:async()=>({}),pullCommits:async()=>[],pullReviews:async()=>[],
    checkRuns:async()=>[],statuses:async()=>[],...over});
  assert.equal(await missionPull(gh({openPullsFor:async()=>[{number:1,head:{ref:'zana/m'},base:{ref:'dev'}}]}),ctx),null);
  const config={reviewerLogin:'Rev',requiredChecks:[],mergeEnabled:true,mergeMethod:'squash'};
  assert.equal((await deliveryStatus({github:gh(),config,ctx})).state,'NO_PULL_REQUEST');
  assert.equal((await independentReview(gh({pullCommits:async()=>{throw new Error('x');}}),'o/r',1,'h',{},'Rev')).unavailableReason,'COMMIT_HISTORY_UNREADABLE');
  assert.equal((await independentReview(gh({pullReviews:async()=>{throw new Error('x');}}),'o/r',1,'h',{},'Rev')).unavailableReason,'REVIEWS_UNREADABLE_OR_OVER_LIMIT');
  assert.equal((await independentReview(gh({pullReviews:async()=>[{user:{login:'rev'},state:'APPROVED',commit_id:'h'},
    {user:{login:'REV'},state:'DISMISSED',commit_id:'h'}]}),'o/r',1,'h',{},'Rev')).state,'DISMISSED');
  assert.equal((await independentReview(gh(),'o/r',1,'h',{user:{login:'rev'}},'Rev')).state,'REVIEWER_IS_AUTHOR');
  assert.equal(fourRStatus([{context:'zana/4r',state:'success',creator:{login:'someone'}}],'rev'),'MISSING');
  const ready=gh({openPullsFor:async()=>[{number:1,head:{ref:'zana/m'},base:{ref:'main'}}],
    pull:async()=>({number:1,state:'open',mergeable:true,head:{sha:'h'}}),
    checkRuns:async()=>[{name:'t',status:'completed',conclusion:'success',head_sha:'h'}],
    statuses:async()=>[{context:'zana/4r',state:'success',creator:{login:'rev'}}],
    pullReviews:async()=>[{user:{login:'rev'},state:'APPROVED',commit_id:'h',id:1}]});
  const currentTicket={ticket_id:'t',state:'FINALIZED',verdict:'APPROVE',sha:'h',github_review_id:1};
  const soloSkip=await deliveryStatus({github:{...ready,checkRuns:async()=>[{name:'t',status:'completed',conclusion:'skipped',head_sha:'h'}]},config,ctx,openBlockingTickets:[],currentTicket});
  assert.deepEqual([soloSkip.ci.state,/ninguno lo probó/.test(soloSkip.ci.note)],['PENDING',true]);
  // Without the current ticket of the mission the merge is never ready (fail closed).
  assert.equal((await mergeMission({github:{...ready,merge:async()=>({merged:true})},config,ctx,openBlockingTickets:[]})).state,'NOT_READY');
  assert.equal((await mergeMission({github:{...ready,merge:async()=>({merged:false,message:'nope'})},config,ctx,openBlockingTickets:[],currentTicket})).state,'MERGE_REFUSED');
  assert.equal((await mergeMission({github:{...ready,merge:async()=>{throw Object.assign(new Error('Head sha mismatch'),{status:422});}},config,ctx,openBlockingTickets:[],currentTicket})).state,'STALE_SHA');
  await assert.rejects(mergeMission({github:{...ready,merge:async()=>{throw Object.assign(new Error('Forbidden'),{status:403});}},config,ctx,openBlockingTickets:[],currentTicket}),/Forbidden/);
  // Un SHA que solo tiene checks saltados o neutros no fue probado: sigue PENDING
  // (con nota) hasta que corra el workflow de checks; nunca es FAILURE ni SUCCESS.
  const soloSaltado=evaluateRuns([{name:'t',status:'completed',conclusion:'skipped'}],'h');
  assert.equal(soloSaltado.state,'PENDING');
  assert.match(soloSaltado.note,/ninguno lo probó/);
  assert.equal(evaluateRuns([{name:'t',status:'completed',conclusion:'neutral'}],'h',['t']).state,'PENDING');
  const conExito=evaluateRuns([{name:'t',status:'completed',conclusion:'skipped'},{name:'t',status:'completed',conclusion:'success'}],'h');
  assert.deepEqual([conExito.state,conExito.note],['SUCCESS',undefined]);
  assert.equal(evaluateRuns([{name:'t',status:'completed',conclusion:'skipped'},{name:'u',status:'completed',conclusion:'cancelled'}],'h').state,'FAILURE');
  assert.equal(evaluateRuns([{name:'t',status:'completed',conclusion:'success',head_sha:'other'}],'h').state,'PENDING');
});

test('remote config fails closed',()=>{
  // The reviewer login has no built-in default: it lives only in the server env.
  assert.equal(remoteConfig({ZANA_GITHUB_REPOS:'o/r'}).reviewerLogin,null);
  assert.equal(remoteConfig({ZANA_REVIEWER_LOGIN:'  '}).reviewerLogin,null);
  const L={ZANA_REVIEWER_LOGIN:'reviewer-bot'};
  const c=remoteConfig({...L,ZANA_GITHUB_REPOS:'o/r, O/x'});
  assert.equal(c.reviewerLogin,'reviewer-bot');
  assert.equal(c.mergeEnabled,true);
  assert.equal(c.ticketTtlMinutes,120);
  assert.equal(c.reviewMaxDiffBytes,1_800_000);
  assert.equal(c.prLineBudget,400);
  assert.equal(repoAllowed(c,'o/X'),true);
  assert.equal(repoAllowed(c,'p/q'),false);
  for(const [env,re] of [[{ZANA_GITHUB_REPOS:'bad'},/invalid repository/],[{ZANA_REVIEWER_LOGIN:'-x'},/login/],
    [{ZANA_CHECKS_WORKFLOW:'../x'},/workflow/],[{ZANA_MERGE_ENABLED:'yes'},/true or false/],
    [{ZANA_MERGE_METHOD:'octopus'},/squash/],[{ZANA_DOWNSTREAM_GITHUB_URL:'http://evil.example/'},/DOWNSTREAM/],
    [{ZANA_DOWNSTREAM_GITHUB_TOOLSETS:'repos;issues'},/TOOLSETS/],[{ZANA_REQUIRED_CHECKS:'x'.repeat(121)},/too long/],
    [{ZANA_GITHUB_API_URL:'ftp://x'},/API_URL/],[{ZANA_TICKET_TTL_MINUTES:'2'},/TTL/],
    [{ZANA_REVIEW_MAX_DIFF_BYTES:'99999'},/MAX_DIFF_BYTES/],[{ZANA_REVIEW_MAX_DIFF_BYTES:'1900001'},/MAX_DIFF_BYTES/],
    [{ZANA_PR_LINE_BUDGET:'49'},/LINE_BUDGET/],[{ZANA_PR_LINE_BUDGET:'5001'},/LINE_BUDGET/]])
    assert.throws(()=>remoteConfig({...L,...env}),re,JSON.stringify(env));
  assert.equal(remoteConfig({...L,ZANA_TICKET_TTL_MINUTES:'30'}).ticketTtlMinutes,30);
});

test('remote state: session identity binding and bounded audit reads',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zana-state-'));
  const file=join(dir,'state.json');
  try{
    assert.deepEqual(await readAudit({},file),[]);
    await ensureSchema(file);
    await assert.rejects(registerSession({sessionId:'x',host:'h',clientId:'c'},file),/Invalid session id/);
    const first=await registerSession({sessionId:'session-1',host:'h',clientId:'c'},file);
    assert.equal((await registerSession({sessionId:'session-1',host:'h',clientId:'c'},file)).createdAt,first.createdAt);
    await assert.rejects(registerSession({sessionId:'session-1',host:'other',clientId:'c'},file),/another identity/);
    await audit({caller:{host:'h',sessionId:'session-1'},tool:'t',missionId:'m1',outcome:'OK',args:{a:1},detail:{big:'x'.repeat(3000)}},file);
    await audit({caller:null,tool:'t',outcome:'OK'},file);
    const rows=await readAudit({missionId:'m1'},file);
    assert.equal(rows.length,1);
    assert.deepEqual(rows[0].detail,{truncated:true});
    assert.equal((await readAudit({},file)).length,2);
    assert.throws(()=>readAudit({limit:0},file),/Invalid audit limit/);
    // Retention: reads are a bounded window; writes are kept; old rows of
    // inactive missions, sessions, checks and terminal tickets age out.
    const {MAX_READ_AUDIT,pruneRemote}=await import('../src/remote-state.mjs');
    const {remoteWrite,remoteRead}=await import('../src/store.mjs');
    const old='2020-01-01T00:00:00.000Z';
    await remoteWrite(db=>{
      const ins=db.prepare("INSERT INTO remote_audit(at,tool,outcome,category) VALUES(?,?,?,?)");
      for(let i=0;i<MAX_READ_AUDIT+5;i++)ins.run(new Date().toISOString(),'read-'+i,'OK','read');
      ins.run(new Date().toISOString(),'a-write','OK','write');
      ins.run(old,'ancient-write','OK','write');
      db.prepare("INSERT INTO remote_activity(session_id,mission_id,kind,tool,created_at) VALUES('s','gone-mission','X','t',?)").run(old);
      db.prepare("INSERT INTO remote_sessions(session_id,host,client_id,created_at,last_seen_at) VALUES('old-session','h','c',?,?)").run(old,old);
      db.prepare("INSERT INTO remote_checks(check_id,mission_id,sha,workflow,dispatched,session_id,created_at) VALUES('c','m','x','w',0,'s',?)").run(old);
      db.prepare("INSERT INTO review_tickets(ticket_id,code_hash,mission_id,repo,pr_number,sha,author_session,created_at,expires_at,state,updated_at) VALUES('t','h','m','o/r',1,'x','s',?,?,'FINALIZED',?)").run(old,old,old);
      pruneRemote(db);
    },file);
    const left=await remoteRead(db=>({reads:db.prepare("SELECT COUNT(*) n FROM remote_audit WHERE category='read'").get().n,
      write:db.prepare("SELECT COUNT(*) n FROM remote_audit WHERE tool='a-write'").get().n,
      ancient:db.prepare("SELECT COUNT(*) n FROM remote_audit WHERE tool='ancient-write'").get().n,
      rest:['remote_activity','remote_checks','review_tickets'].map(t=>db.prepare('SELECT COUNT(*) n FROM '+t).get().n),
      oldSession:db.prepare("SELECT COUNT(*) n FROM remote_sessions WHERE session_id='old-session'").get().n}),file);
    assert.deepEqual(left,{reads:MAX_READ_AUDIT,write:1,ancient:0,rest:[0,0,0],oldSession:0});
    assert.equal(remoteMission(null,'m'),null);
    assert.equal(sessionRow(null,'s'),null);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('skills: list, load, frontmatter and path traversal',async()=>{
  const names=listSkills().map(s=>s.name);
  assert.deepEqual(names,['review-discipline','review-readability','review-reliability','review-resilience','review-risk','zana-4r','zana-odd','zana-pr']);
  for(const name of names){
    const s=loadSkill(name);
    assert.equal(s.name,name);
    assert.ok(s.description.length>10);
    assert.match(s.sha256,/^[0-9a-f]{64}$/);
  }
  for(const bad of ['../package','..','zana-odd/../x','/etc/passwd','Zana-odd','a',42])
    assert.throws(()=>loadSkill(bad),/Invalid skill name/,String(bad));
  assert.throws(()=>loadSkill('no-such-skill'),/Unknown skill/);
  assert.equal(parseFrontmatter('no frontmatter'),null);
  const dir=await mkdtemp(join(tmpdir(),'zana-skills-'));
  try{
    await mkdir(join(dir,'bad-one'));
    await writeFile(join(dir,'bad-one','SKILL.md'),'---\nname: other\n---\n');
    assert.throws(()=>listSkills(dir),/lacks frontmatter/);
    await rm(join(dir,'bad-one'),{recursive:true});
    await mkdir(join(dir,'big-one'));
    await writeFile(join(dir,'big-one','SKILL.md'),'x'.repeat(70_000));
    assert.throws(()=>loadSkill('big-one',dir),/bounded/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('redaction removes known secrets in all encodings and GitHub token shapes',()=>{
  const secret='s3cr3t-value-123';
  const text=['a',secret,encodeURIComponent(secret+'/'),Buffer.from(secret).toString('base64'),'ghp_'+'x'.repeat(36),
    'github_pat_'+'y'.repeat(30),'Bearer '+'q'.repeat(20)].join(' ');
  const out=redactText(text,[secret,secret+'/','short']);
  for(const leak of [secret,'ghp_','github_pat_','qqqq'])assert.equal(out.includes(leak),false,leak);
  assert.deepEqual(redactDeep({a:[secret]},[secret]),{a:['[redacted]']});
  assert.equal(redactDeep(undefined,[]),undefined);
  assert.equal(clean('x\n  y',[]),'x y');
  assert.equal(clean(new Error('e '+secret),[secret]),'e [redacted]');
  assert.deepEqual(secretForms([null,'short']),[]);
  // Un token en la línea siguiente no funde dos líneas del diff (\s+ las fundía).
  const diff='+// auth: Bearer\n+'+'A'.repeat(22)+'==\n';
  assert.equal(redactText(diff),diff);
  assert.equal(redactText('Bearer\t'+'q'.repeat(20)),'Bearer [redacted]');
});

test('ticketView distingue tickets con el mismo state (issue #3, punto 4)',()=>{
  const a={ticket_id:'t-a',state:'FINALIZED',verdict:'APPROVE',sha:'a'.repeat(40),github_review_id:7};
  const b={...a,ticket_id:'t-b'};
  assert.notEqual(ticketView(a),ticketView(b));
  assert.equal(ticketView(a),ticketView({...a}));
  assert.notEqual(ticketView(a),ticketView({...a,github_review_id:null}));
  assert.equal(ticketView(null),'none');
  assert.equal(ticketView(undefined),'none');
});

test('makeExclusive serializa por clave y no retiene entradas (issue #3, punto 6)',async()=>{
  const {exclusive,pending}=makeExclusive();
  const order=[];
  let releaseFirst;
  const gate=new Promise(r=>{releaseFirst=r;});
  const first=exclusive('m',async()=>{order.push('first:start');await gate;order.push('first:end');return 1;});
  const second=exclusive('m',async()=>{order.push('second');return 2;});
  const other=exclusive('x',async()=>{order.push('other');return 3;});
  assert.equal(await other,3);
  assert.deepEqual(order,['first:start','other']);
  assert.equal(pending(),1);
  releaseFirst();
  assert.deepEqual(await Promise.all([first,second]),[1,2]);
  assert.deepEqual(order,['first:start','other','first:end','second']);
  assert.equal(pending(),0);
  await assert.rejects(exclusive('m',async()=>{throw new Error('boom');}),/boom/);
  assert.equal(await exclusive('m',async()=>'after'),'after');
  assert.equal(pending(),0);
});
