import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMission} from '../src/core.mjs';
import {transact,readState,databasePath,storageStatus} from '../src/store.mjs';

test('SQLite v3 snapshot upgrades to v6 without fabricating a retroactive deadline',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zana-v3-v4-'));
  const file=join(dir,'state.json');
  try{
    const before=await transact(()=>createMission({
      objective:'Carry old SQLite mission forward without erasing its data',
      authorization:{writesAllowed:false,allowedPaths:[]},
      units:[{id:'legacy',effect:'READ',instruction:'Inspect inherited state'}],
    }),file);
    const db=new DatabaseSync(databasePath(file));
    try{
      db.exec('ALTER TABLE active_mission DROP COLUMN budget; PRAGMA user_version=3');
    }finally{db.close();}
    await assert.rejects(readState(file),/Unsupported database schema/);
    const converted=await transact(m=>m,file);
    assert.equal(converted.id,before.id);
    assert.equal(converted.budget,null);
    assert.equal(converted.units[0].status,'PENDING');
    assert.equal((await storageStatus(file)).schemaVersion,6);
    assert.equal((await readState(file)).id,before.id);
  }finally{await rm(dir,{recursive:true,force:true});}
});
