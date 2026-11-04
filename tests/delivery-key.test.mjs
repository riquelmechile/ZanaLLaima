import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readVerifierKey} from '../src/delivery.mjs';
test('CI verifier reads only Ed25519 public keys and rejects invalid PEM or RSA',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zana-ci-key-'));
  try{
    assert.equal(readVerifierKey(null),null);
    assert.equal(readVerifierKey(''),null);
    const ed=generateKeyPairSync('ed25519');
    const pub=join(dir,'ci-public.pem');
    await writeFile(pub,ed.publicKey.export({type:'spki',format:'pem'}));
    assert.equal(readVerifierKey(pub).asymmetricKeyType,'ed25519');
    const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
    const path=join(dir,'rsa.pem');
    await writeFile(path,rsa.publicKey.export({type:'spki',format:'pem'}));
    assert.throws(()=>readVerifierKey(path),/must be Ed25519/);
    const invalid=join(dir,'invalid.pem');
    await writeFile(invalid,'no signer is configured');
    assert.throws(()=>readVerifierKey(invalid));
  }finally{await rm(dir,{recursive:true,force:true});}
});
