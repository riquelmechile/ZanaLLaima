// Etapa B, ronda 3: P2 de logs, H1-H5 y mutaciones vivas.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {copyFile,rename,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {remoteFixture,readDiff,sha} from './helpers/remote-fixture.mjs';
import {remoteWrite,remoteRead,transact,backupState,restoreBackup,storageAdoptQuarantine,databasePath} from '../src/store.mjs';
import {createMission} from '../src/core.mjs';
import {pruneRemote} from '../src/remote-state.mjs';
import {ticketAuthority} from '../src/github-delivery.mjs';
import {createHttpServer,httpSettings} from '../src/http.mjs';
import {EmbeddedOAuth} from '../src/oauth.mjs';
import {runCli} from '../src/cli.mjs';

const clean=lens=>({lens,findings:[],evidence:['read every page']});
const blocker={lens:'risk',findings:[{severity:'BLOCKER',location:'src/sum.mjs:3',evidence:'returns a-b',origin:'INTRODUCED'}],evidence:['diff']};
const q=(sql,...a)=>remoteRead(db=>db.prepare(sql).all(...a));
async function review(f,ticket,s,risk=clean('risk')){
  assert.equal((await f.call('zana_review_claim',{ticket},s)).state,'CLAIMED');
  await readDiff(f.call,ticket,s);
  for(const l of [risk,clean('readability'),clean('reliability'),clean('resilience')])
    assert.equal((await f.call('zana_review_lens_submit',{ticket,...l},s)).error,undefined);
  return f.call('zana_review_finalize',{ticket,execution:'PARALLEL_SUBAGENTS'},s);
}
async function finalizeReady(f,ready){
  const req=await f.call('zana_review_request',{missionId:ready.missionId},ready.author);
  const reviewer=await f.session('zana-chatgpt',ready.author.clientId);
  assert.equal((await f.call('zana_review_claim',{ticket:req.ticket},reviewer)).state,'CLAIMED');
  await readDiff(f.call,req.ticket,reviewer);
  for(const lens of ['risk','readability','reliability','resilience'])
    assert.equal((await f.call('zana_review_lens_submit',{ticket:req.ticket,...clean(lens)},reviewer)).error,undefined);
  return {req,reviewer};
}

test('P2: failed-job logs use the Actions job id, not the check run id (details_url, run jobs by name, none)',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId}=await f.authorReady({green:false});
    const started=await f.call('zana_checks_start',{missionId},author);
    f.api.state.red(sha('a'),77,'unit','job');
    f.api.state.red(sha('a'),88,'lint','run',901);
    f.api.state.red(sha('a'),99,'e2e','none');
    f.api.state.runJobs[901].push({id:5,name:'lint-extra',run_id:901});
    // The details_url job link alone must suffice (run 900 lists no jobs).
    f.api.state.runJobs[900]=[];
    const status=await f.call('zana_checks_status',{checkId:started.checkId},author);
    assert.equal(status.state,'FAILURE');
    const tail=name=>status.failures.find(x=>x.name===name).logTail.join('\n');
    assert.match(tail('unit'),/expected 2 got 3/,'job id from details_url');
    assert.match(tail('lint'),/expected 2 got 3/,'job id from the run job list, by exact name');
    assert.match(tail('e2e'),/no GitHub Actions job found/);
    // The check run ids were never used as job ids.
    for(const id of [50077,50088,50099])
      assert.equal(f.api.state.requests.some(r=>String(r.path??r).includes('/actions/jobs/'+id+'/')),false);
  }finally{await f.cleanup();}
});

test('H1: the prune never deletes tickets of the active mission (their same-SHA blockers stay)',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId}=await f.authorReady();
    const t=await f.call('zana_review_request',{missionId},author);
    assert.equal((await review(f,t.ticket,await f.session(),blocker)).event,'REQUEST_CHANGES');
    const old='2020-01-01T00:00:00.000Z';
    await remoteWrite(db=>{
      db.prepare('UPDATE review_tickets SET updated_at=?').run(old);
      // A terminal ticket of another (inactive) mission is still pruned.
      db.prepare("INSERT INTO review_tickets(ticket_id,code_hash,mission_id,repo,pr_number,sha,author_session,created_at,expires_at,state,updated_at) VALUES('other','h-o','m-old','o/r',1,'x','s',?,?,'FINALIZED',?)").run(old,old,old);
      pruneRemote(db);
    });
    assert.equal((await q('SELECT COUNT(*) n FROM review_tickets WHERE mission_id=?',missionId))[0].n,1);
    assert.equal((await q("SELECT COUNT(*) n FROM review_tickets WHERE ticket_id='other'"))[0].n,0);
    assert.match((await f.call('zana_review_request',{missionId},author)).error??'',/CHANGES_REQUESTED_SAME_SHA/);
  }finally{await f.cleanup();}
});

test('H3/W2: a client that took a unit (start_batch or rebind) cannot claim with ZANA_DISTINCT_REVIEWER_CLIENT',async()=>{
  const f=await remoteFixture({envExtra:{ZANA_DISTINCT_REVIEWER_CLIENT:'true'}});
  try{
    const {author,missionId}=await f.authorReady();
    // Client zc_b starts the notes unit; client zc_c rebinds it.
    const b=await f.session('gpt-b','zc_b');
    const batch=await f.call('zana_start_batch',{},b);
    const notes=batch.packets.find(p=>p.unitId==='notes');
    assert.ok(notes,JSON.stringify(batch));
    const c=await f.session('gpt-c','zc_c');
    assert.equal((await f.call('zana_session_rebind',{missionId,unitId:'notes',token:notes.token,leaseGeneration:notes.leaseGeneration},c)).rebound,true);
    const t=await f.call('zana_review_request',{missionId},author);
    assert.equal(t.error,undefined,t.error);
    assert.match((await f.call('zana_review_claim',{ticket:t.ticket},await f.session('gpt-b','zc_b'))).error??'',/SAME_CLIENT/,'start_batch client');
    assert.match((await f.call('zana_review_claim',{ticket:t.ticket},await f.session('gpt-c','zc_c'))).error??'',/SAME_CLIENT/,'rebind client');
    assert.equal((await f.call('zana_review_claim',{ticket:t.ticket},await f.session('gpt-r','zc_reviewer'))).state,'CLAIMED');
  }finally{await f.cleanup();}
});

test('H3/W7: /health gives the public body through the tunnel header, a public Host, or a non-loopback peer',async()=>{
  const f=await remoteFixture();
  try{
    const settings={...httpSettings({ZANA_PUBLIC_HOST:'zanallaima.test',ZANA_OAUTH_DB:join(f.dir,'o.sqlite')}),password:'p'.repeat(40)};
    const oauth=new EmbeddedOAuth({path:settings.oauthDb,resource:'https://zanallaima.test/mcp',redirectUris:['https://chatgpt.com/cb'],password:'p'.repeat(40)});
    const http=createHttpServer({runtime:f.runtime,oauth,settings,log:{error(){}}});
    // Drive the request handler with an injected peer address.
    const get=(headers,remoteAddress='127.0.0.1')=>new Promise((ok,fail)=>{
      const req={method:'GET',url:'/health',headers,socket:{remoteAddress},on(){},once(){},resume(){}};
      let status=0;
      const res={writeHead(s){status=s;return res;},setHeader(){},end(b){try{ok({status,body:JSON.parse(String(b))});}catch(e){fail(e);}}};
      http.emit('request',req,res);
    });
    const PUBLIC=['sessions','staleTickets','status','version'];
    try{
      const local=await get({host:'127.0.0.1:8787'});
      assert.ok(Object.keys(local.body).length>PUBLIC.length,'loopback without proxy header gets the detail');
      for(const [headers,peer] of [[{host:'localhost','cf-connecting-ip':'203.0.113.5'},'127.0.0.1'],
        [{host:'zanallaima.test'},'127.0.0.1'],[{host:'127.0.0.1'},'203.0.113.9']]){
        const r=await get(headers,peer);
        assert.deepEqual(Object.keys(r.body).sort(),PUBLIC,JSON.stringify({headers,peer}));
      }
    }finally{oauth.close();}
  }finally{await f.cleanup();}
});

test('H4: the migration fills remote_activity.client_id from remote_sessions',async()=>{
  const f=await remoteFixture();
  try{
    await remoteWrite(db=>{
      db.prepare("INSERT INTO remote_sessions(session_id,host,client_id,created_at,last_seen_at) VALUES('s-old','gpt','zc_old',?,?)").run(new Date().toISOString(),new Date().toISOString());
      db.prepare("INSERT INTO remote_activity(session_id,mission_id,kind,tool,created_at,client_id) VALUES('s-old','m','WRITE','t',?,NULL)").run(new Date().toISOString());
      // As before this version: the backfill has not run.
      db.prepare("DELETE FROM metadata WHERE key='activity_client_backfill'").run();
    });
    await remoteWrite(()=>null);
    assert.equal((await q("SELECT client_id FROM remote_activity WHERE session_id='s-old'"))[0].client_id,'zc_old');
  }finally{await f.cleanup();}
});

const ticketRow=(missionId,state,id,extra={})=>({ticket_id:id,code_hash:'h-'+id,mission_id:missionId,repo:'o/r',pr_number:1,
  sha:'a'.repeat(40),author_session:'s-author',created_at:new Date().toISOString(),expires_at:new Date(Date.now()+3600e3).toISOString(),
  state,updated_at:new Date().toISOString(),...extra});
const put=(db,table,row)=>{const k=Object.keys(row);
  db.prepare('INSERT OR REPLACE INTO '+table+'('+k.join(',')+') VALUES('+k.map(()=>'?').join(',')+')').run(...k.map(x=>row[x]));};

test('H5: restore and adopt keep remote_activity.client_id and operator_released',async()=>{
  for(const mode of ['restore','adopt']){
    const f=await remoteFixture();
    try{
      const m=await transact(()=>createMission({objective:'H5 fixture',units:[{id:'scan',effect:'READ',instruction:'Read it'}]}));
      await remoteWrite(db=>put(db,'review_tickets',ticketRow(m.id,'ABANDONED','t1')));
      const backup=join(f.dir,'b-'+mode+'.sqlite');
      await backupState(backup);
      // Live, after the backup: the operator releases t1, and a client acts.
      await remoteWrite(db=>{
        db.prepare("UPDATE review_tickets SET operator_released=1 WHERE ticket_id='t1'").run();
        put(db,'remote_activity',{session_id:'s-a',mission_id:m.id,kind:'UNIT_START',tool:'x',created_at:'2026-01-01T00:00:00.000Z',client_id:'zc_live'});
      });
      if(mode==='restore'){
        process.env.ZANA_RESTORE_OFFLINE='1';
        try{await restoreBackup(backup,undefined,{offline:true,forceDataLoss:true});}
        finally{delete process.env.ZANA_RESTORE_OFFLINE;}
      }else{
        const base=databasePath(process.env.ZANA_STATE_FILE),oldId=randomUUID(),newId=randomUUID();
        await copyFile(backup,base+'.quarantine.'+oldId);
        const live=new DatabaseSync(base);
        try{live.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{live.close();}
        await rename(base,base+'.quarantine.'+newId);
        process.env.ZANA_RESTORE_OFFLINE='1';
        try{assert.equal((await storageAdoptQuarantine(oldId,undefined,{confirm:true,forceDataLoss:true})).adopted,true);}
        finally{delete process.env.ZANA_RESTORE_OFFLINE;}
      }
      const after=await remoteRead(db=>({
        released:db.prepare("SELECT operator_released r FROM review_tickets WHERE ticket_id='t1'").get()?.r,
        client:db.prepare("SELECT client_id c FROM remote_activity WHERE session_id='s-a'").get()?.c}));
      assert.deepEqual(after,{released:1,client:'zc_live'},mode);
    }finally{await f.cleanup();}
  }
});

test('H5: remote-ticket-abandon refuses a FINALIZING ticket whose review is already on GitHub; ALLOWED_KEYS uses own keys',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId}=await f.authorReady();
    const t=await f.call('zana_review_request',{missionId},author);
    const id=(await f.runtime.review.list(missionId))[0].ticketId;
    await remoteWrite(db=>db.prepare("UPDATE review_tickets SET state='FINALIZING',github_review_id=1234 WHERE ticket_id=?").run(id));
    await assert.rejects(f.runtime.review.abandon(id,{host:'operator',sessionId:'operator-cli'}),/TICKET_TERMINAL: ticket already published GitHub review 1234/);
    void t;
  }finally{await f.cleanup();}
  const {createGitHubPolicy,catalogProblems}=await import('../src/github-policy.mjs');
  const catalog={version:'t',tools:{constructor:{zana:'write',rule:'file',readOnlyHint:false},toString:{zana:'write',rule:'file',readOnlyHint:false}}};
  assert.deepEqual(catalogProblems(catalog),['constructor: write without ALLOWED_KEYS','toString: write without ALLOWED_KEYS']);
  const policy=createGitHubPolicy({config:{},catalog,deps:{github:{repo:async()=>({default_branch:'main'})},
    missionContext:async()=>({status:'ACTIVE',reviewer:false,runningForSession:true,repo:'o/r',branch:'zana/m',base:'main'})}});
  for(const tool of ['constructor','toString']){
    const d=await policy({caller:{},tool,args:{owner:'o',repo:'r',branch:'zana/m',path:'a'},cls:'write',missionId:'m'});
    assert.match(d.reason,/UNCLASSIFIED: .* has no ALLOWED_KEYS/,tool);
  }
});

test('mutations: correction_start without tickets, a different FINALIZED REQUEST_CHANGES ticket in the transaction',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId}=await f.authorReady();
    assert.match((await f.call('zana_correction_start',{missionId},author)).error??'',/NO_CHANGES_REQUESTED: mission .* has no review ticket/);
    const t=await f.call('zana_review_request',{missionId},author);
    assert.equal((await review(f,t.ticket,await f.session(),blocker)).event,'REQUEST_CHANGES');
    // Between the pre-check and the transaction another ticket appears that
    // also ended FINALIZED with REQUEST_CHANGES: the correction is not for it.
    const real=f.runtime.review.latest;
    f.runtime.review.latest=async id=>{
      const seen=await real(id);
      const at=new Date(Date.now()+1000).toISOString();
      await remoteWrite(db=>db.prepare("INSERT INTO review_tickets(ticket_id,code_hash,mission_id,repo,pr_number,sha,author_session,created_at,expires_at,state,verdict,updated_at) VALUES('newer-rc','h-rc',?,'o/r',7,?,?,?,?,'FINALIZED','REQUEST_CHANGES',?)")
        .run(id,sha('b'),author.sessionId,at,at,at));
      return seen;
    };
    assert.match((await f.call('zana_correction_start',{missionId},author)).error??'',/NO_CHANGES_REQUESTED: the latest ticket/);
    f.runtime.review.latest=real;
  }finally{await f.cleanup();}
});

test('mutations: request expires stale tickets before superseding them',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId}=await f.authorReady();
    const t1=await f.call('zana_review_request',{missionId},author);
    assert.equal(t1.error,undefined);
    await remoteWrite(db=>db.prepare("UPDATE review_tickets SET expires_at='2000-01-01T00:00:00.000Z'").run());
    assert.equal((await f.call('zana_review_request',{missionId},author)).error,undefined);
    const states=(await q('SELECT state FROM review_tickets WHERE mission_id=? ORDER BY created_at',missionId)).map(r=>r.state);
    assert.deepEqual(states,['EXPIRED','OPEN'],'an expired OPEN ticket is EXPIRED, not superseded');
  }finally{await f.cleanup();}
});

test('mutations: CLI remote-health returns the detailed health',async()=>{
  const f=await remoteFixture();
  const saved={...process.env};
  try{
    const envFile=join(f.dir,'server.env');
    await writeFile(envFile,'ZANA_STATE_FILE='+process.env.ZANA_STATE_FILE+'\n');
    const h=await runCli('remote-health',['--env-file',envFile]);
    assert.equal(h.schemaVersion,8);
    assert.ok(['ok','degraded'].includes(h.status));
    assert.ok(Array.isArray(h.problems));
  }finally{
    for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];
    Object.assign(process.env,saved);
    await f.cleanup();
  }
});

test('delivery authority: only the current ticket FINALIZED APPROVE on the head with its own latest review counts',()=>{
  const ok={ticket_id:'t',state:'FINALIZED',verdict:'APPROVE',sha:'h',github_review_id:7};
  const rv={reviewId:7};
  assert.equal(ticketAuthority(ok,'h',rv).ok,true);
  assert.equal(ticketAuthority(null,'h',rv).ok,false);
  for(const bad of [{state:'ABANDONED'},{state:'FINALIZING'},{verdict:'REQUEST_CHANGES'},{sha:'other'},{github_review_id:null},{github_review_id:8}])
    assert.equal(ticketAuthority({...ok,...bad},'h',rv).ok,false,JSON.stringify(bad));
  assert.match(ticketAuthority({...ok,github_review_id:8},'h',rv).reason,/not the latest decisive/);
});

test('rev63: una adopción de una sesión muerta no bloquea durante 30 días',async()=>{
  const f=await remoteFixture();
  try{
    const ready=await f.authorReady(),missionId=ready.missionId;
    const dead=await f.session('zana-chatgpt',ready.author.clientId);
    assert.equal((await f.call('zana_mission_adopt',{missionId},dead)).adopted,true);
    const old=new Date(Date.now()-29*86_400_000).toISOString();
    await remoteWrite(db=>db.prepare('UPDATE remote_sessions SET last_seen_at=? WHERE session_id=?').run(old,dead.sessionId));
    await remoteWrite(db=>pruneRemote(db));
    const next=await f.session('zana-chatgpt',ready.author.clientId);
    const result=await f.call('zana_mission_adopt',{missionId},next);
    assert.equal(result.adopted,true,'sesión muerta aún bloquea: '+JSON.stringify(result));
  }finally{await f.cleanup();}
});

test('rev63: actividad renueva el lease de adopción y, vencido, otra sesión adopta',async()=>{
  const f=await remoteFixture();
  try{
    const ready=await f.authorReady(),missionId=ready.missionId;
    const owner=await f.session('zana-chatgpt',ready.author.clientId);
    assert.equal((await f.call('zana_mission_adopt',{missionId},owner)).adopted,true);
    const old=new Date(Date.now()-60*60_000).toISOString();
    await remoteWrite(db=>db.prepare('UPDATE remote_activity SET created_at=? WHERE mission_id=? AND session_id=?').run(old,missionId,owner.sessionId));
    const notes=(await f.call('zana_start_batch',{},owner)).packets.find(packet=>packet.unitId==='notes');
    assert.ok(notes);
    assert.equal((await f.call('zana_complete_unit',{unitId:notes.unitId,token:notes.token,leaseGeneration:notes.leaseGeneration,
      outcome:{success:true,summary:'Notas listas',evidence:['Actividad de la sesión adoptante']}},owner)).error,undefined);
    const next=await f.session('zana-chatgpt',ready.author.clientId);
    assert.match((await f.call('zana_mission_adopt',{missionId},next)).error,/ADOPT_MISSION_BUSY.*hasta/);
    await remoteWrite(db=>db.prepare('UPDATE remote_activity SET created_at=? WHERE mission_id=? AND session_id=?').run(old,missionId,owner.sessionId));
    assert.equal((await f.call('zana_mission_adopt',{missionId},next)).adopted,true);
  }finally{await f.cleanup();}
});

test('rev63: transacción abortada en events.queue no deja archivo sin FINALIZED',async()=>{
  const f=await remoteFixture();
  try{
    const ready=await f.authorReady(),missionId=ready.missionId;
    const {req,reviewer}=await finalizeReady(f,ready);
    f.runtime.events.queue=db=>{db.exec('ROLLBACK');throw new Error('SQLITE_FULL simulado');};
    await f.call('zana_review_finalize',{ticket:req.ticket,execution:'SEQUENTIAL_SAME_CONVERSATION'},reviewer);
    const state=await remoteRead(db=>({
      ticket:db.prepare('SELECT state FROM review_tickets WHERE mission_id=?').get(missionId).state,
      archived:db.prepare('SELECT COUNT(*) n FROM review_archive WHERE mission_id=?').get(missionId).n}));
    assert.ok(!(state.archived>0&&state.ticket!=='FINALIZED'),'escritura parcial: archivo sin FINALIZED '+JSON.stringify(state));
  }finally{await f.cleanup();}
});
