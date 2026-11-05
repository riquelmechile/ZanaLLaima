// Etapa B, ronda de corrección 1: tests negativos de los CRITICAL/P1.
import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteFixture,readDiff,sha} from './helpers/remote-fixture.mjs';

const clean=lens=>({lens,findings:[],evidence:['Read every diff page and the checks']});
const blocker={lens:'risk',findings:[{severity:'BLOCKER',location:'src/sum.mjs:3',evidence:'returns a-b'}],evidence:['diff']};
async function review(f,ticket,s,risk=clean('risk'),execution='PARALLEL_SUBAGENTS'){
  const claim=await f.call('zana_review_claim',{ticket},s);
  assert.equal(claim.error,undefined,claim.error);
  await readDiff(f.call,ticket,s);
  for(const l of [risk,clean('readability'),clean('reliability'),clean('resilience')]){
    const r=await f.call('zana_review_lens_submit',{ticket,...l},s);
    assert.equal(r.error,undefined,r.error);
  }
  const fin=await f.call('zana_review_finalize',{ticket,execution},s);
  assert.equal(fin.error,undefined,fin.error);
  return fin;
}
const outcome=s=>({success:true,summary:'done on '+s,evidence:['head '+s]});

test('C1: completed code unit + REQUEST_CHANGES -> correction unit -> new ticket -> APPROVE -> merge',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId,branch,packet}=await f.authorReady();
    // The author completes the code unit before review (allowed, but then no unit is RUNNING).
    const done=await f.call('zana_complete_unit',{unitId:'code',token:packet.token,leaseGeneration:packet.leaseGeneration,outcome:outcome(sha('a'))},author);
    assert.equal(done.error,undefined,done.error);
    const t1=await f.call('zana_review_request',{missionId},author);
    const r1=await review(f,t1.ticket,await f.session(),blocker);
    assert.equal(r1.event,'REQUEST_CHANGES');
    // Correction: a new PENDING code unit the author can start and write with.
    const corr=await f.call('zana_correction_start',{missionId},author);
    assert.equal(corr.error,undefined,corr.error);
    const batch=await f.call('zana_start_batch',{},author);
    const cp=batch.packets.find(p=>p.unitId===corr.unitId);
    assert.ok(cp,'correction unit started');
    const w=await f.call('zana_ds_github',{operation:'create_or_update_file',missionId,
      arguments:{owner:'o',repo:'r',branch,path:'src/sum.mjs',content:'a+b',message:'fix'}},author);
    assert.equal(Boolean(w.error||w.isError),false,JSON.stringify(w));
    f.api.state.push(branch,sha('b'));f.api.state.green(sha('b'));
    const t2=await f.call('zana_review_request',{missionId},author);
    assert.equal(t2.error,undefined,t2.error);
    assert.equal((await review(f,t2.ticket,await f.session())).event,'APPROVE');
    const c2=await f.call('zana_complete_unit',{unitId:corr.unitId,token:cp.token,leaseGeneration:cp.leaseGeneration,outcome:outcome(sha('b'))},author);
    assert.equal(c2.error,undefined,c2.error);
    assert.equal((await f.call('zana_merge',{missionId},author)).state,'MERGED');
  }finally{await f.cleanup();}
});

test('C2: operator CLI loads the server env explicitly and never creates a stray DB',async()=>{
  const {mkdtemp,writeFile,rm,access}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {runCli}=await import('../src/cli.mjs');
  const {ensureSchema,databasePath}=await import('../src/store.mjs');
  const {audit}=await import('../src/remote-state.mjs');
  const {setEnrollment}=await import('../src/oauth.mjs');
  const dir=await mkdtemp(join(tmpdir(),'zana-cli-env-'));
  const saved={...process.env};
  try{
    for(const k of ['ZANA_STATE_FILE','ZANA_OAUTH_DB','ZANA_ENV_FILE'])delete process.env[k];
    process.env.HOME=join(dir,'empty-home');
    await assert.rejects(runCli('remote-clients',[]),/ZANA_STATE_FILE/);
    // A relative path is refused, and nothing is created in the working directory.
    process.env.ZANA_STATE_FILE='rel/state.json';
    await assert.rejects(runCli('remote-audit',[]),/absolut/);
    await assert.rejects(access(join(process.cwd(),'rel')),/ENOENT/);
    delete process.env.ZANA_STATE_FILE;
    // The server's env file: absolute paths of the real DBs.
    const state=join(dir,'server','state.json'),oauthDb=join(dir,'server','oauth.sqlite');
    await ensureSchema(state);
    setEnrollment(oauthDb,0);
    await audit({caller:{host:'zana-chatgpt',sessionId:'server-session'},tool:'zana_probe',outcome:'OK',args:{}},state);
    const envFile=join(dir,'zanallaima.env');
    await writeFile(envFile,'# server env\nZANA_STATE_FILE='+state+'\nZANA_OAUTH_DB="'+oauthDb+'"\n');
    const items=(await runCli('remote-audit',['--env-file',envFile])).items;
    assert.ok(items.some(x=>x.tool==='zana_probe'),'operates on the server DB');
    assert.equal((await runCli('remote-clients',['--env-file',envFile])).clients.length,0);
    await assert.rejects(runCli('remote-revoke',['zc_'+'a'.repeat(24),'--env-file',envFile]),/CLIENT_NOT_FOUND/);
    // A missing DB is an error, not a fresh empty DB.
    await writeFile(envFile,'ZANA_STATE_FILE='+join(dir,'nope','state.json')+'\nZANA_OAUTH_DB='+oauthDb+'\n');
    await assert.rejects(runCli('remote-audit',['--env-file',envFile]),/does not exist/);
    await assert.rejects(access(databasePath(join(dir,'nope','state.json'))),/ENOENT/);
  }finally{
    for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];
    Object.assign(process.env,saved);
    await rm(dir,{recursive:true,force:true});
  }
});

test('C3: an orphaned CLAIMED ticket with a BLOCKER (server restart) does not block the merge forever',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId,branch}=await f.authorReady();
    const t1=await f.call('zana_review_request',{missionId},author);
    const reviewer=await f.session();
    assert.equal((await f.call('zana_review_claim',{ticket:t1.ticket},reviewer)).state,'CLAIMED');
    assert.equal((await f.call('zana_review_lens_submit',{ticket:t1.ticket,...blocker},reviewer)).blocking,true);
    // Restart: in-memory MCP sessions are gone; the reviewer conversation reconnects with a new session.
    const {createRemoteRuntime}=await import('../src/remote.mjs');
    await f.runtime.close();
    f.runtime=createRemoteRuntime({env:f.env});
    const call=async(name,args,s)=>{const r=await f.runtime.dispatch(name,args,s);return r.isError?{error:r.content[0].text}:r.structuredContent;};
    const reconnected=await f.session();
    assert.match((await call('zana_review_lens_submit',{ticket:t1.ticket,...clean('readability')},reconnected)).error,/NOT_REVIEWER/);
    // The author fixes it on a new SHA; a new ticket supersedes the orphan and approves.
    f.api.state.push(branch,sha('b'));f.api.state.green(sha('b'));
    const t2=await call('zana_review_request',{missionId},author);
    assert.equal(t2.error,undefined,t2.error);
    await review({call},t2.ticket,await f.session());
    const merge=await call('zana_merge',{missionId},author);
    assert.equal(merge.state,'MERGED',JSON.stringify(merge.blockers));
  }finally{await f.cleanup();}
});

test('C4: a diff larger than one page cannot be approved without reading every page',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId}=await f.authorReady();
    const file=(name,kb)=>'diff --git a/'+name+' b/'+name+'\n--- a/'+name+'\n+++ b/'+name+'\n@@ -0,0 +1 @@\n'+
      Array.from({length:kb*16},(_,i)=>'+line '+i+' '+'x'.repeat(50)).join('\n')+'\n';
    f.api.state.diffText=file('src/big.mjs',200)+file('src/small.mjs',1)+file('test/big.test.mjs',90);
    const t=await f.call('zana_review_request',{missionId},author);
    const s=await f.session();
    const claim=await f.call('zana_review_claim',{ticket:t.ticket},s);
    assert.ok(claim.diffManifest.totalPages>3,'paged manifest');
    assert.deepEqual(claim.diffManifest.files.map(x=>x.path),['src/big.mjs','src/small.mjs','test/big.test.mjs']);
    for(const l of ['risk','readability','reliability','resilience'])
      await f.call('zana_review_lens_submit',{ticket:t.ticket,...clean(l)},s);
    const first=await f.call('zana_review_diff',{ticket:t.ticket,page:0},s);
    assert.equal(first.page,0);
    assert.match((await f.call('zana_review_finalize',{ticket:t.ticket,execution:'PARALLEL_SUBAGENTS'},s)).error,/DIFF_NOT_FULLY_READ/);
    assert.equal((f.api.state.reviews[7]??[]).length,0,'nothing published');
    await readDiff(f.call,t.ticket,s);
    assert.equal((await f.call('zana_review_finalize',{ticket:t.ticket,execution:'PARALLEL_SUBAGENTS'},s)).event,'APPROVE');
  }finally{await f.cleanup();}
});

test('C5: with ZANA_DISTINCT_REVIEWER_CLIENT=true the reviewer must use another OAuth client',async()=>{
  for(const flag of ['true','false']){
    const f=await remoteFixture({envExtra:{ZANA_DISTINCT_REVIEWER_CLIENT:flag}});
    try{
      const {author,missionId}=await f.authorReady();
      const t=await f.call('zana_review_request',{missionId},author);
      const sameClient=await f.session('zana-chatgpt','zc_test');
      const claim=await f.call('zana_review_claim',{ticket:t.ticket},sameClient);
      if(flag==='true'){
        assert.match(claim.error,/SAME_CLIENT/);
        const other=await f.session('gpt-b','zc_other');
        assert.equal((await f.call('zana_review_claim',{ticket:t.ticket},other)).state,'CLAIMED');
      }else assert.equal(claim.state,'CLAIMED');
    }finally{await f.cleanup();}
  }
});
