import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const script=resolve('scripts/setup-ci-signing.sh');
async function sandbox(){
  const dir=await mkdtemp(join(tmpdir(),'zana-ci-setup-'));
  const home=join(dir,'home'),bin=join(dir,'bin'),calls=join(dir,'gh-called');
  await mkdir(home);await mkdir(bin);
  await writeFile(join(bin,'gh'),`#!/bin/sh\nprintf 'CALLED\\n' >> "$GH_CALL_LOG"\nexit 88\n`,{mode:0o755});
  return {dir,home,bin,calls,env:{...process.env,HOME:home,
      PATH:bin+':'+process.env.PATH,GH_CALL_LOG:calls},
    close:()=>rm(dir,{recursive:true,force:true})};
}
async function missing(path){
  try{await stat(path);return false;}
  catch(e){if(e.code==='ENOENT')return true;throw e;}
}

test('dry-run with simulated gh has no filesystem or remote side effects',async()=>{
  const s=await sandbox();
  try{
    const publicBefore=await readFile('keys/ci-verifier.pub','utf8');
    const run=spawnSync('bash',[script,'--dry-run'],{encoding:'utf8',env:s.env});
    assert.equal(run.status,0,run.stderr);
    assert.match(run.stdout,/SIMULACIÓN/);
    assert.match(run.stdout,/main con revisor independiente/);
    assert.equal(await missing(s.calls),true,'gh must not be invoked');
    assert.equal(await missing(join(s.home,'.config')),true,'key directory must not be created');
    assert.equal(await readFile('keys/ci-verifier.pub','utf8'),publicBefore);
    assert.doesNotMatch(run.stdout,/BEGIN (PRIVATE|PUBLIC) KEY/);
  }finally{await s.close();}
});
test('unexpected CLI flags and absent operator public key fail closed before any mutation',async()=>{
  const s=await sandbox();
  try{
    const bad=spawnSync('bash',[script,'--dangerous'],{encoding:'utf8',env:s.env});
    assert.notEqual(bad.status,0);
    assert.match(bad.stderr,/Único argumento permitido/);
    const missingPublic=spawnSync('bash',[script],{encoding:'utf8',env:s.env});
    assert.notEqual(missingPublic.status,0);
    assert.match(missingPublic.stderr,/Falta llave pública válida/);
    assert.equal(await missing(s.calls),true);
    assert.equal(await missing(join(s.home,'.config')),true);
  }finally{await s.close();}
});
