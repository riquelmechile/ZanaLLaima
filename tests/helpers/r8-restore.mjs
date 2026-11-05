import {DatabaseSync} from 'node:sqlite';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createMission} from '../../src/core.mjs';
import {transact,applyOperatorAction,backupState,authorizationStatus,databasePath} from '../../src/store.mjs';
export async function restoreFixture(){
 const dir=await mkdtemp(join(tmpdir(),'r8-journal-'));
 const file=join(dir,'state.json'),backup=join(dir,'backup.sqlite');
 const pair=generateKeyPairSync('ed25519'),publicKey=join(dir,'pub.pem');
 await writeFile(publicKey,pair.publicKey.export({type:'spki',format:'pem'}));
 const saved={ZANA_STATE_FILE:process.env.ZANA_STATE_FILE,
  ZANA_OPERATOR_PUBLIC_KEY_PATH:process.env.ZANA_OPERATOR_PUBLIC_KEY_PATH,
  ZANA_RESTORE_OFFLINE:process.env.ZANA_RESTORE_OFFLINE};
 process.env.ZANA_STATE_FILE=file;process.env.ZANA_OPERATOR_PUBLIC_KEY_PATH=publicKey;
 process.env.ZANA_RESTORE_OFFLINE='1';
 const mission=await transact(()=>createMission({
  objective:'Revocar grants de manera durable durante restore',
  authorization:{writesAllowed:true,allowedPaths:['docs']},
  units:[{id:'write',effect:'WRITE',paths:['docs'],instruction:'Operación con autorización'}],
 }),file);
 const signed=(kind,attrs={})=>{
  const payload={kind,missionId:mission.id,nonce:randomUUID(),
   issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),...attrs};
  return {payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),pair.privateKey).toString('base64')};
 };
 const grant=signed('GRANT_WRITE',{paths:['docs']});
 await applyOperatorAction(grant,file);await backupState(backup,file);
 await applyOperatorAction(signed('REVOKE_WRITE',{grantId:grant.payload.nonce}),file);
 if((await authorizationStatus(file)).valid)throw Error('Fixture revocation failed');
 const events=()=>{
  const db=new DatabaseSync(databasePath(file),{readOnly:true});
  try{return db.prepare('SELECT COUNT(*) AS n FROM state_events').get().n;}
  finally{db.close();}
 };
 return {dir,file,backup,grant,signed,events,close:async()=>{
  for(const [k,v] of Object.entries(saved)){
   if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
  await rm(dir,{recursive:true,force:true});
 }};
}
