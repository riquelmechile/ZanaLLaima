// Endurecimiento de la memoria por proyecto (hallazgos W1-W6 y S4 de las 4R de #9 y #10).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {remoteFixture,AUTHOR_TOKEN} from './helpers/remote-fixture.mjs';
import {remoteRead,remoteWrite} from '../src/store.mjs';
import {GitHubApi} from '../src/github-api.mjs';
import {redactStored} from '../src/redact.mjs';
import {memoryContext,saveEntry,saveSummary,POINTER_PATH} from '../src/project-memory.mjs';

const spec={objective:'Misión de memoria',units:[{id:'a',effect:'READ',instruction:'Leer el repo'}]};
const target={repo:'o/r',base:'main'};
const q=(sql,...p)=>remoteRead(db=>db.prepare(sql).all(...p).map(r=>({...r})));
const summary={done:'Se hizo el trabajo de la misión completo',decisions:[],conventions:[],pending:[],keyFiles:[]};
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
async function initOnly(f,s){
  const init=await f.call('zana_mission_init',{spec,github:target},s);
  assert.ok(init.id,init.error);
  await f.call('zana_mission_cancel',{},s);await f.call('zana_mission_archive',{},s);
  return init.memory;
}
async function initRun(f,s){
  const init=await f.call('zana_mission_init',{spec,github:target},s);
  const p=(await f.call('zana_start_batch',{},s)).packets[0];
  const done=await f.call('zana_complete_unit',{unitId:p.unitId,token:p.token,leaseGeneration:p.leaseGeneration,
    outcome:{success:true,summary:'leído',evidence:['e']}},s);
  assert.equal(done.error,undefined,done.error);
  return init;
}

const SHAPES={
  jwt:'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  google:'AIza'+'Sy0-_'.repeat(7),
  stripe:'sk_live_'+'a1B2'.repeat(5),
  'stripe restringida':'rk_test_'+'Z9'.repeat(10),
  aws:'AKIA'+'B'.repeat(16),
  'aws temporal':'ASIA'+'C7'.repeat(8),
  slack:'xoxe-1234567890-abcdef',
  'slack app':'xapp-1-A0123-4567890-abc',
  gitlab:'glpat-'+'x_Y-'.repeat(5),
  npm:'npm_'+'n4'.repeat(18),
  pem:'-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
  'pem sin END':'-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq',
  pgp:'-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----',
};
for(const [name,secret] of Object.entries(SHAPES))test('W1 redacción: '+name,()=>{
  const out=redactStored('antes '+secret+(name==='pem sin END'?'':' después'));
  assert.equal(out,'antes [redacted]'+(name==='pem sin END'?'':' después'));
});
test('W1 redacción: URL con credenciales conserva esquema y host',()=>{
  assert.equal(redactStored('ver postgres://admin:hunter2@db.example.com:5432/x y https://u:p@h.io/a'),
    'ver postgres://[redacted]@db.example.com:5432/x y https://[redacted]@h.io/a');
});
test('W1 redacción: asignaciones conservan la clave',()=>{
  assert.equal(redactStored('password=hunter2 API_KEY: abc123 aws_secret_access_key = wJalrXUtn "token":"t0k3n" passwd:x'),
    'password=[redacted] API_KEY: [redacted] aws_secret_access_key = [redacted] "token":[redacted] passwd:[redacted]');
});
test('W1 redacción: texto normal no cambia y la redacción previa se mantiene',()=>{
  const plain='La decisión: usar tokens cortos; el password se rota cada 90 días a las 10:30. Ver https://github.com/o/r/pull/7, '+
    'user@example.com y tests/token.test.mjs. El prefijo sk_ y eyJ solos no son claves; AKIA123 tampoco.';
  assert.equal(redactStored(plain),plain);
  assert.equal(redactStored('t '+AUTHOR_TOKEN+' Bearer '+'b'.repeat(20)+' sk-proj-'+'Q'.repeat(30)+' xoxb-1234567890-abc',['envsecret1']),
    't [redacted] Bearer [redacted] [redacted] [redacted]');
});

test('W2: done, keyFiles, topic y body se redactan antes de cortar',async()=>{
  const f=await remoteFixture();
  try{
    const env='S3cr3t-'+'k'.repeat(50),pid='zp_'+'e'.repeat(16);
    const bodies=await remoteWrite(db=>{
      const body=missionId=>db.prepare('SELECT body FROM project_memory WHERE topic=?').get(missionId).body;
      // Archivos clave de 26 caracteres: done se corta en 974, dentro del token.
      saveSummary(db,{projectId:pid,missionId:'m-gh',summary:{...summary,done:'x'.repeat(959)+' ghp_'+'Q'.repeat(36),keyFiles:['src/a.mjs']}});
      saveSummary(db,{projectId:pid,missionId:'m-env',secrets:[env],summary:{...summary,done:'y'.repeat(939)+' '+env,keyFiles:['src/a.mjs']}});
      // La lista de archivos se corta en 400, dentro del token del segundo.
      saveSummary(db,{projectId:pid,missionId:'m-files',summary:{...summary,keyFiles:['a'.repeat(250),'b'.repeat(119)+' ghp_'+'W'.repeat(36)]}});
      saveEntry(db,{projectId:pid,kind:'issue',topic:'t'.repeat(69)+' ghp_'+'Z'.repeat(36),body:'b'.repeat(989)+' '+env,secrets:[env]});
      return [body('m-gh'),body('m-env'),body('m-files'),
        ...Object.values(db.prepare("SELECT topic,body FROM project_memory WHERE kind='issue'").get())];
    });
    for(const b of bodies){
      assert.ok(!/ghp_|Q{4}|W{4}|Z{4}|S3cr3t/.test(b),b.slice(-60));
      assert.ok(b.length<=1000);
    }
  }finally{await f.cleanup();}
});

test('W3: un puntero mal formado no tumba init ni close',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session(),id='zp_'+'a'.repeat(16);
    const bad=[{zanallaima:1,projectId:[id],githubRepoId:4242},{zanallaima:1,projectId:123},{zanallaima:1,projectId:{}},
      {zanallaima:1,projectId:null},[{zanallaima:1,projectId:id}],5,{zanallaima:1,projectId:id,githubRepoId:-1},
      {zanallaima:1,projectId:id,githubRepoId:'4242'},{zanallaima:1,projectId:id,githubRepoId:1.5}];
    for(const pointer of bad){
      f.api.state.files[POINTER_PATH]=JSON.stringify(pointer);
      const memory=await initOnly(f,s);
      assert.equal(memory.pointer.status,'POINTER_MISSING',JSON.stringify(pointer));
      assert.match(memory.pointer.invalid,/not a ZanaLLaima pointer/);
    }
    assert.equal((await q('SELECT project_id FROM projects WHERE project_id=?',id)).length,0);
    // Close de una misión sin proyecto con projectId array: lo resuelve sin error de sqlite.
    f.api.state.failNext={status:500,message:'down'};
    await initRun(f,s);
    f.api.state.files[POINTER_PATH]=JSON.stringify(bad[0]);
    const closed=await f.call('zana_mission_close',{summary},s);
    assert.deepEqual([closed.status,closed.memory.pointer.status],['CLOSED','POINTER_MISSING']);
  }finally{await f.cleanup();}
});

test('W3: una excepción de memoria crea la misión con memory.error y el close responde MEMORY_UNAVAILABLE',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session();
    await remoteWrite(db=>db.exec("CREATE TRIGGER boom BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT,'boom'); END"));
    const init=await initRun(f,s);
    assert.ok(init.id);
    assert.match(init.memory.error,/^MEMORY_UNAVAILABLE: .*boom/);
    assert.deepEqual(await q('SELECT project_id FROM remote_missions'),[{project_id:null}]);
    const failed=await f.call('zana_mission_close',{summary},s);
    assert.match(failed.error,/^MEMORY_UNAVAILABLE: .*boom.*can be retried/);
    assert.equal((await f.call('zana_mission_status',{},s)).state,'ACTIVE');
    await remoteWrite(db=>db.exec('DROP TRIGGER boom'));
    assert.equal((await f.call('zana_mission_close',{summary},s)).status,'CLOSED');
  }finally{await f.cleanup();}
});

test('W4: si saveSummary falla, el close no cierra la misión ni deja memoria',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session();
    const init=await initRun(f,s);
    assert.ok(init.memory.projectId);
    await remoteWrite(db=>db.exec("CREATE TRIGGER nomem BEFORE INSERT ON project_memory BEGIN SELECT RAISE(ABORT,'disk full'); END"));
    assert.match((await f.call('zana_mission_close',{summary},s)).error,/disk full/);
    assert.equal((await f.call('zana_mission_status',{},s)).state,'ACTIVE');
    assert.deepEqual(await q('SELECT COUNT(*) n FROM project_memory'),[{n:0}]);
  }finally{await f.cleanup();}
});

test('W5: tope de 4 KB, renombre, puntero propio sin githubRepoId y LIMIT 200',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session();
    const gh=new GitHubApi({baseUrl:f.env.ZANA_GITHUB_API_URL,token:AUTHOR_TOKEN});
    f.api.state.files['edge.json']='"'+'x'.repeat(4094)+'"';
    assert.equal((await gh.fileJson('o/r','edge.json','main')).length,4094);
    f.api.state.files['edge.json']='"'+'x'.repeat(4095)+'"';
    await assert.rejects(gh.fileJson('o/r','edge.json','main'),/at most 4 KB/);
    const a=await initOnly(f,s);
    f.api.state.files[POINTER_PATH]=JSON.stringify({zanallaima:1,projectId:a.projectId,githubRepoId:4242,note:'n'.repeat(4100)});
    const big=await initOnly(f,s);
    assert.deepEqual([big.projectId,big.pointer.status],[a.projectId,'POINTER_MISSING']);
    assert.match(big.pointer.invalid,/at most 4 KB/);
    // Mismo id de repo con otro full_name: el proyecto sigue y su repo se actualiza.
    f.api.state.fullName='o/r2';
    f.api.state.files[POINTER_PATH]=JSON.stringify({zanallaima:1,projectId:a.projectId});
    const own=await initOnly(f,s);
    assert.deepEqual([own.projectId,own.pointer.status],[a.projectId,'POINTER_STALE']);
    assert.deepEqual(await q('SELECT repo FROM projects'),[{repo:'o/r2'}]);
    // Más de 200 convenciones: la consulta trae 200, las más nuevas primero.
    const {rows,entries}=await remoteWrite(db=>{
      for(let i=0;i<250;i++)saveEntry(db,{projectId:a.projectId,kind:'convention',topic:'c'+i,body:'b'});
      let rows=0;
      const counted={prepare:sql=>{const st=db.prepare(sql);return {all:(...p)=>{const r=st.all(...p);rows+=r.length;return r;}};}};
      memoryContext(counted,a.projectId);
      return {rows,entries:memoryContext(db,a.projectId,{maxBytes:1e7}).entries};
    });
    assert.equal(rows,200);
    assert.deepEqual([entries.length,entries[0].topic,entries.at(-1).topic],[200,'c249','c50']);
  }finally{await f.cleanup();}
});

test('S4: close de una misión que no está ACTIVE no llama a GitHub',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session();
    f.api.state.failNext={status:500,message:'down'};
    await f.call('zana_mission_init',{spec,github:target},s);
    await f.call('zana_mission_cancel',{},s);
    const before=f.api.state.requests.length;
    assert.match((await f.call('zana_mission_close',{summary},s)).error,/^MISSION_NOT_ACTIVE: .* is CANCELLED/);
    assert.equal(f.api.state.requests.length,before);
  }finally{await f.cleanup();}
});
