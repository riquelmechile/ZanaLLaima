import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createMission} from '../src/core.mjs';
import {transact,applyOperatorAction,authorizationStatus,backupState,
  restoreBackup,databasePath} from '../src/store.mjs';
import {runCli} from '../src/cli.mjs';
const storeURL=new URL('../src/store.mjs',import.meta.url).href;
const proposal=()=>({objective:'Reconciliar permisos tras restaurar de un backup',
  authorization:{writesAllowed:true,allowedPaths:['docs']},
  units:[{id:'write',effect:'WRITE',paths:['docs'],instruction:'Escribir solo con firma'}]});
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'zana-r7-recovery-'));
 const file=join(dir,'state.json'),backup=join(dir,'backup.sqlite');
 const keys=generateKeyPairSync('ed25519');
 const keyPath=join(dir,'operator-public.pem');
 await writeFile(keyPath,keys.publicKey.export({type:'spki',format:'pem'}));
 const saved={ZANA_OPERATOR_PUBLIC_KEY_PATH:process.env.ZANA_OPERATOR_PUBLIC_KEY_PATH,
   ZANA_RESTORE_OFFLINE:process.env.ZANA_RESTORE_OFFLINE,
   ZANA_STATE_FILE:process.env.ZANA_STATE_FILE};
 process.env.ZANA_OPERATOR_PUBLIC_KEY_PATH=keyPath;
 process.env.ZANA_RESTORE_OFFLINE='1';process.env.ZANA_STATE_FILE=file;
 const m=await transact(()=>createMission(proposal()),file);
 const signed=(kind,attrs={})=>{
   const payload={kind,missionId:m.id,nonce:randomUUID(),
     issuedAt:new Date().toISOString(),
     expiresAt:new Date(Date.now()+600000).toISOString(),...attrs};
   return {payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),
     keys.privateKey).toString('base64')};
 };
 return {dir,file,backup,signed,close:async()=>{
   for(const [k,v] of Object.entries(saved)){
     if(v===undefined)delete process.env[k];else process.env[k]=v;
   }
   await rm(dir,{recursive:true,force:true});
 }};
}
async function crashAfterQuarantine(f){
 const program="import {restoreBackup} from "+JSON.stringify(storeURL)+
   "; await restoreBackup(process.argv[1],process.argv[2],{offline:true,afterQuarantine:async()=>process.kill(process.pid,'SIGKILL')});";
 const child=spawnSync(process.execPath,['--input-type=module','-e',program,f.backup,f.file],
   {env:{...process.env,ZANA_RESTORE_OFFLINE:'1'},encoding:'utf8',timeout:15000});
 assert.equal(child.signal,'SIGKILL',child.stderr||'El subproceso no murió por SIGKILL');
 assert.equal(existsSync(databasePath(f.file)),false);
 assert.equal(existsSync(databasePath(f.file)+'.restore-pending'),true);
}
test('R7 C3: SIGKILL tras cuarentena no reactiva grant revocado al reintentar',async()=>{
 const f=await fixture();try{
   const grant=f.signed('GRANT_WRITE',{paths:['docs']});
   await applyOperatorAction(grant,f.file);
   await backupState(f.backup,f.file);
   const revoke=f.signed('REVOKE_WRITE',{grantId:grant.payload.nonce});
   await applyOperatorAction(revoke,f.file);
   await crashAfterQuarantine(f);
   // El diario duradero se conserva tras SIGKILL. Un rerun lo revierte
   // antes de revalidar revocaciones y nonces, sin tocar cuarentenas por mtime.
   await restoreBackup(f.backup,f.file,{offline:true});
   assert.equal((await authorizationStatus(f.file)).valid,false,
     'Restore tras crash resucitó grant revocado');
   await assert.rejects(applyOperatorAction(revoke,f.file),/already consumed/,
     'Nonce REVOKE_WRITE consumido antes del crash debe persistir');
 }finally{await f.close();}
});
test('R7 C3: restore ciego requiere forceDataLoss y revoca todo permiso',async()=>{
 const f=await fixture();try{
   await applyOperatorAction(f.signed('GRANT_WRITE',{paths:['docs']}),f.file);
   await backupState(f.backup,f.file);
   await rm(databasePath(f.file),{force:true});
   await assert.rejects(restoreBackup(f.backup,f.file,{offline:true}),/force-data-loss|previous|blind/i);
   await restoreBackup(f.backup,f.file,{offline:true,forceDataLoss:true});
   assert.equal((await authorizationStatus(f.file)).valid,false);
 }finally{await f.close();}
});
test('R7 C3: epoch de restore ciego rechaza firmas emitidas antes',async()=>{
 const f=await fixture();try{
   await applyOperatorAction(f.signed('GRANT_WRITE',{paths:['docs']}),f.file);
   await backupState(f.backup,f.file);
   const old=f.signed('GRANT_WRITE',{paths:['docs']});
   await rm(databasePath(f.file),{force:true});
   await restoreBackup(f.backup,f.file,{offline:true,forceDataLoss:true});
   await assert.rejects(applyOperatorAction(old,f.file),/restore|epoch|issuedAt|anterior/i);
 }finally{await f.close();}
});
test('R7 C3: storage-restore-abort recupera base original y conserva revocación',async()=>{
 const f=await fixture();try{
   const grant=f.signed('GRANT_WRITE',{paths:['docs']});
   await applyOperatorAction(grant,f.file);
   await backupState(f.backup,f.file);
   await applyOperatorAction(f.signed('REVOKE_WRITE',{grantId:grant.payload.nonce}),f.file);
   await crashAfterQuarantine(f);
   const result=await runCli('storage-restore-abort');
   assert.equal(result.aborted,true);
   assert.equal((await authorizationStatus(f.file)).valid,false);
 }finally{await f.close();}
});
