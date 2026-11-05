import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {mkdtemp,mkdir,rm,writeFile,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMission} from '../src/core.mjs';
import {transact,applyOperatorAction,readState,storageStatus} from '../src/store.mjs';
import {operations} from '../src/actions.mjs';
const writerURL=new URL('../src/write-operations.mjs',import.meta.url).href;
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'zana-r7-temp-'));
 const file=join(dir,'state.json'),workspace=join(dir,'workspace');
 await mkdir(workspace);await mkdir(join(workspace,'docs'));
 const key=generateKeyPairSync('ed25519'),keyPath=join(dir,'operator-public.pem');
 await writeFile(keyPath,key.publicKey.export({type:'spki',format:'pem'}));
 const old={ZANA_STATE_FILE:process.env.ZANA_STATE_FILE,
   ZANA_OPERATOR_PUBLIC_KEY_PATH:process.env.ZANA_OPERATOR_PUBLIC_KEY_PATH,
   ZANA_WORKSPACE_ROOT:process.env.ZANA_WORKSPACE_ROOT};
 process.env.ZANA_STATE_FILE=file;process.env.ZANA_OPERATOR_PUBLIC_KEY_PATH=keyPath;
 process.env.ZANA_WORKSPACE_ROOT=workspace;
 const mission=await transact(()=>createMission({objective:'Recuperar efectos inciertos de manera segura',
   authorization:{writesAllowed:true,allowedPaths:['docs']},
   units:[{id:'write',effect:'WRITE',paths:['docs'],instruction:'Crear guía'}]}),file);
 const signed=(kind,attrs={})=>{
   const payload={kind,missionId:mission.id,nonce:randomUUID(),
     issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),...attrs};
   return {payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),key.privateKey).toString('base64')};
 };
 await applyOperatorAction(signed('GRANT_WRITE',{paths:['docs']}),file);
 const packet=(await operations.start({})).packets[0];
 const args={unitId:'write',token:packet.token,leaseGeneration:packet.leaseGeneration,
   path:'docs/guide.txt',content:'temporal sin rename'};
 const code="import {applyWriteEffect} from "+JSON.stringify(writerURL)+
   "; await applyWriteEffect(JSON.parse(process.argv[1]),process.argv[2],{afterTempSync:()=>process.kill(process.pid,'SIGKILL')});";
 const child=spawnSync(process.execPath,['--input-type=module','-e',code,JSON.stringify(args),file],
   {env:{...process.env},encoding:'utf8',timeout:15000});
 assert.equal(child.signal,'SIGKILL',child.stderr);
 const pending=await storageStatus(file);
 assert.equal(pending.effectTemporaries.length,1);
 const tempName=pending.effectTemporaries[0].tempName;
 return {dir,file,workspace,packet,signed,tempName,close:async()=>{
   for(const [k,v] of Object.entries(old)){
     if(v===undefined)delete process.env[k];else process.env[k]=v;
   }
   await rm(dir,{recursive:true,force:true});
 }};
}
for(const mode of ['directorio borrado','directorio reemplazado','temporal sustituido por directorio']){
 test('R7 C4 best effort: '+mode+' no bloquea status, recover y reconcile',async()=>{
   const f=await fixture();
   try{
     const docs=join(f.workspace,'docs');
     if(mode==='directorio borrado')await rm(docs,{recursive:true});
     if(mode==='directorio reemplazado'){
       await rename(docs,join(f.workspace,'old-docs'));
       await writeFile(docs,'ruta reemplazada por archivo');
     }
     if(mode==='temporal sustituido por directorio'){
       await rm(join(docs,f.tempName));await mkdir(join(docs,f.tempName));
     }
     const status=await storageStatus(f.file);
     assert.equal(status.effectTemporaries.length,1);
     assert.ok(status.effectTemporaries[0].error,
       'La falla de limpieza debe reportarse, no bloquear la consulta');
     const recovered=await operations.recoverExpired();
     assert.ok(recovered.cleanedTemps.some(x=>x.error),
       'La recuperación debe reportar el error de limpieza');
     await applyOperatorAction(f.signed('RECONCILE_WRITE',{
       unitId:'write',token:f.packet.token,leaseGeneration:f.packet.leaseGeneration,
       decision:'CONFIRMED_NO_EFFECT',
       evidence:['Operador verificó que el temporal no se aplicó al destino']}),f.file);
     assert.notEqual((await readState(f.file)).units[0].status,'OUTCOME_UNKNOWN');
   }finally{await f.close();}
 });
}
