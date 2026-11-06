import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMission} from '../src/core.mjs';
import {transact,applyOperatorAction,authorizationStatus,backupState,
  restoreBackup,databasePath} from '../src/store.mjs';

const proposal=()=>({objective:'Comprobar revocaciones durables tras restauración',
  authorization:{writesAllowed:true,allowedPaths:['docs']},
  units:[{id:'write',effect:'WRITE',paths:['docs'],
    instruction:'Escribir solamente tras autorización firmada'}]});

async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'zana-r6-restore-'));
  const file=join(dir,'state.json'),backup=join(dir,'backup.sqlite');
  const keys=generateKeyPairSync('ed25519');
  const publicPath=join(dir,'operator-public.pem');
  await writeFile(publicPath,keys.publicKey.export({type:'spki',format:'pem'}));
  const previous={key:process.env.ZANA_OPERATOR_PUBLIC_KEY_PATH,
    offline:process.env.ZANA_RESTORE_OFFLINE};
  process.env.ZANA_OPERATOR_PUBLIC_KEY_PATH=publicPath;
  process.env.ZANA_RESTORE_OFFLINE='1';
  const mission=await transact(()=>createMission(proposal()),file);
  const signed=(kind,additional={})=>{
    const payload={kind,missionId:mission.id,nonce:randomUUID(),
      issuedAt:new Date().toISOString(),
      expiresAt:new Date(Date.now()+600000).toISOString(),...additional};
    return {payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),
      keys.privateKey).toString('base64')};
  };
  const close=async()=>{
    for(const [name,value] of [['ZANA_OPERATOR_PUBLIC_KEY_PATH',previous.key],
      ['ZANA_RESTORE_OFFLINE',previous.offline]]){
      if(value===undefined)delete process.env[name];else process.env[name]=value;
    }
    await rm(dir,{recursive:true,force:true});
  };
  return {dir,file,backup,signed,mission,close};
}
async function grantAndRevoke(f){
  const grant=f.signed('GRANT_WRITE',{paths:['docs']});
  await applyOperatorAction(grant,f.file);
  assert.equal((await authorizationStatus(f.file)).valid,true);
  await backupState(f.backup,f.file);
  const revoke=f.signed('REVOKE_WRITE',{grantId:grant.payload.nonce});
  await applyOperatorAction(revoke,f.file);
  assert.equal((await authorizationStatus(f.file)).valid,false);
  return {grant,revoke};
}

test('P1-c: revocación posterior al backup permanece inválida tras restore',async()=>{
  const f=await fixture();
  try{
    await grantAndRevoke(f);
    await restoreBackup(f.backup,f.file,{offline:true});
    assert.equal((await authorizationStatus(f.file)).valid,false,
      'El restore reactivó un grant revocado');
    const db=new DatabaseSync(databasePath(f.file),{readOnly:true});
    try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operator_grants WHERE revoked=1')
      .get().n,1);}finally{db.close();}
  }finally{await f.close();}
});
test('P1-c: nonce consumido después del backup no puede reproducirse',async()=>{
  const f=await fixture();
  try{
    const {revoke}=await grantAndRevoke(f);
    await restoreBackup(f.backup,f.file,{offline:true});
    await assert.rejects(applyOperatorAction(revoke,f.file),/already consumed/,
      'El restore borró el nonce de una revocación anterior');
  }finally{await f.close();}
});
test('P1-c: forceDataLoss no suspende la monotonicidad de revocaciones',async()=>{
  const f=await fixture();
  try{
    const {revoke}=await grantAndRevoke(f);
    await restoreBackup(f.backup,f.file,{offline:true,forceDataLoss:true});
    assert.equal((await authorizationStatus(f.file)).valid,false);
    await assert.rejects(applyOperatorAction(revoke,f.file),/already consumed/);
  }finally{await f.close();}
});
test('P1-c: DB viva ilegible fuerza revocación total, incluso con forceDataLoss',async()=>{
  const f=await fixture();
  try{
    const grant=f.signed('GRANT_WRITE',{paths:['docs']});
    await applyOperatorAction(grant,f.file);
    await backupState(f.backup,f.file);
    await writeFile(databasePath(f.file),'garbled sqlite');
    await assert.rejects(restoreBackup(f.backup,f.file,{offline:true}),
      /force-data-loss|inspect/i);
    await restoreBackup(f.backup,f.file,{offline:true,forceDataLoss:true});
    assert.equal((await authorizationStatus(f.file)).valid,false,
      'DB viva ilegible permitió reactivar autorización del backup');
  }finally{await f.close();}
});
