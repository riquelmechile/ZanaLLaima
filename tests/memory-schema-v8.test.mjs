import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMission} from '../src/core.mjs';
import {transact,readState,databasePath,storageStatus,backupState,restoreBackup,remoteWrite,remoteRead,ensureSchema} from '../src/store.mjs';
import {pruneRemote} from '../src/remote-state.mjs';
import {saveEntry} from '../src/project-memory.mjs';

// Back to v7: no memory tables and no remote_missions.project_id.
function downgrade(path){
  const db=new DatabaseSync(path);
  try{db.exec('DROP TABLE projects; DROP TABLE project_memory; ALTER TABLE remote_missions DROP COLUMN project_id; PRAGMA user_version=7');}
  finally{db.close();}
}
test('v7 migra a v8 (también al restaurar un backup v7) sin perder remote_missions; pruneRemote no toca la memoria',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zana-v8-')),file=join(dir,'state.json'),backup=join(dir,'v7.sqlite');
  const missions=()=>remoteRead(db=>db.prepare('SELECT mission_id,project_id FROM remote_missions').all().map(r=>({...r})),file);
  try{
    const m=await transact(()=>createMission({objective:'Esquema v8',units:[{id:'a',effect:'READ',instruction:'Leer'}]}),file);
    await remoteWrite(db=>db.prepare("INSERT INTO remote_missions(mission_id,repo,base,branch,code_units,created_session,created_at) VALUES(?,'o/r','main','b','[]','s','x')").run(m.id),file);
    await backupState(backup,file);
    downgrade(databasePath(file));
    await assert.rejects(readState(file),/Unsupported database schema/);
    assert.equal((await ensureSchema(file)).schemaVersion,8);
    assert.deepEqual(await missions(),[{mission_id:m.id,project_id:null}]);
    await remoteWrite(db=>{
      saveEntry(db,{projectId:'zp_'+'1'.repeat(16),kind:'decision',topic:'t',body:'b'});
      pruneRemote(db,Date.now()+3650*86_400_000);
    },file);
    assert.equal(await remoteRead(db=>db.prepare('SELECT COUNT(*) n FROM project_memory').get().n,file),1);
    downgrade(backup);
    process.env.ZANA_RESTORE_OFFLINE='1';
    try{await restoreBackup(backup,file,{offline:true,forceDataLoss:true});}
    finally{delete process.env.ZANA_RESTORE_OFFLINE;}
    assert.equal((await storageStatus(file)).schemaVersion,8);
    assert.deepEqual(await missions(),[{mission_id:m.id,project_id:null}]);
  }finally{await rm(dir,{recursive:true,force:true});}
});
