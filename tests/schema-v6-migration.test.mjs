import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMission} from '../src/core.mjs';
import {transact,readState,databasePath,storageStatus} from '../src/store.mjs';

test('SQLite v5 receipts migrate to v6 retaining old hashes and null permission provenance',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zana-v5-v6-'));
  const file=join(dir,'state.json');
  try{
    const initial=await transact(()=>createMission({
      objective:'Conservative v5 to v6 upgrade fixture',
      authorization:{writesAllowed:false,allowedPaths:[]},
      units:[{id:'scan',effect:'READ',instruction:'Read the existing history'}],
    }),file);
    const db=new DatabaseSync(databasePath(file));
    try{
      const columns=db.prepare('PRAGMA table_info(write_effect_receipts)').all().map(x=>x.name);
      assert.ok(columns.includes('pre_mode')&&columns.includes('post_mode'));
      db.prepare('INSERT INTO write_effect_receipts(mission_id,unit_id,token,generation,effect_id,path,pre_sha,post_sha,bytes,operation,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(initial.id,'legacy-unit','old-token',1,'v5-existing-receipt','docs/legacy.txt',
          'a'.repeat(64),'b'.repeat(64),25,'REPLACE',new Date().toISOString());
      db.exec('ALTER TABLE write_effect_receipts DROP COLUMN pre_mode');
      db.exec('ALTER TABLE write_effect_receipts DROP COLUMN post_mode');
      db.exec('PRAGMA user_version=5');
      assert.equal(db.prepare('PRAGMA user_version').get().user_version,5);
    }finally{db.close();}
    await assert.rejects(readState(file),/Unsupported database schema/);
    const migrated=await transact(state=>{state.revision++;return state;},file);
    assert.equal(migrated.id,initial.id);
    assert.equal((await storageStatus(file)).schemaVersion,6);
    const reopened=new DatabaseSync(databasePath(file),{readOnly:true});
    try{
      const row=reopened.prepare('SELECT pre_sha,post_sha,pre_mode,post_mode FROM write_effect_receipts WHERE effect_id=?')
        .get('v5-existing-receipt');
      assert.equal(row.pre_sha,'a'.repeat(64));
      assert.equal(row.post_sha,'b'.repeat(64));
      assert.equal(row.pre_mode,null,'Do not invent historic permission provenance');
      assert.equal(row.post_mode,null,'Do not invent historic permission provenance');
    }finally{reopened.close();}
    assert.equal((await readState(file)).units[0].id,'scan');
  }finally{await rm(dir,{recursive:true,force:true});}
});
