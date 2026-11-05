import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMission} from '../src/core.mjs';
import {transact,backupState,storageCleanupArtifacts,storageRestoreAbort,restoreBackup,
 databasePath} from '../src/store.mjs';

async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'zana-r9-flock-'));
 const file=join(dir,'state.json'),backup=join(dir,'backup.sqlite');
 const old=process.env.ZANA_RESTORE_OFFLINE;process.env.ZANA_RESTORE_OFFLINE='1';
 await transact(()=>createMission({objective:'Comprobar exclusión de operaciones restore',
  authorization:{writesAllowed:false,allowedPaths:[]},
  units:[{id:'read',effect:'READ',instruction:'Consultar únicamente'}]}),file);
 await backupState(backup,file);
 return {dir,file,backup,close:async()=>{
  if(old===undefined)delete process.env.ZANA_RESTORE_OFFLINE;
  else process.env.ZANA_RESTORE_OFFLINE=old;
  await rm(dir,{recursive:true,force:true});
 }};
}
async function holdLock(file){
 const child=spawn('/usr/bin/flock',['-x','-w','10',file,'/bin/sh','-c',
  'printf "LOCKED\n"; IFS= read -r release'],{stdio:['pipe','pipe','pipe']});
 await new Promise((resolve,reject)=>{
  let data='';
  child.stdout.on('data',part=>{data+=part.toString();if(data.includes('LOCKED'))resolve();});
  child.once('error',reject);
  child.once('exit',()=>reject(Error('flock exited before lock acquired')));
 });
 return async()=>{
  if(child.exitCode===null)child.stdin.end('RELEASE\n');
  if(child.exitCode===null)await new Promise(r=>child.once('exit',r));
 };
}
test('R9 W2: cleanup, abort y restore respetan exclusión entre procesos con flock',async()=>{
 const f=await fixture();
 try{
  const ops=[
   ['cleanup',()=>storageCleanupArtifacts(f.file,{confirm:true})],
   ['abort',()=>storageRestoreAbort(f.file).catch(e=>{if(e.code!=='NO_JOURNAL')throw e;})],
   ['restore',()=>restoreBackup(f.backup,f.file,{offline:true})]
  ];
  for(const [label,call] of ops){
   const release=await holdLock(databasePath(f.file)+'.restore.lock');
   let settled=false;
   const work=Promise.resolve().then(call).finally(()=>{settled=true;});
   try{
    await delay(175);
    assert.equal(settled,false,'La operación '+label+' ignoró flock de otro proceso');
   }finally{await release();}
   await work;
  }
 }finally{await f.close();}
});
