import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCliCommand,runCli} from '../src/cli.mjs';

const deps={
  json:async path=>{if(!path)throw Error('JSON path missing');return {file:path,verdict:'PASS'};},
  text:async path=>{if(!path)throw Error('Content path missing');return 'file content '+path;},
};
const parse=(command,args=[])=>parseCliCommand(command,args,deps);
test('all no-argument CLI commands map to their correct action',async()=>{
  const names=['status','profile','review-status','review-check','storage-status',
    'storage-migrate','authorization-status','recover-expired','cancel','close','archive'];
  for(const name of names){
    const item=await parse(name);
    assert.deepEqual(item.input,{});
    assert.equal(typeof item.action,'string');
  }
  assert.equal((await runCli('profile')).assurance,'REQUESTED_ONLY');
  await assert.rejects(parse('this-command-does-not-exist'),/Commands:/);
  await assert.rejects(runCli('this-command-does-not-exist'),/Commands:/);
});
test('CLI parses every file-backed, optional and numeric command',async()=>{
  assert.deepEqual((await parse('init',['mission.json'])).input.spec,{file:'mission.json',verdict:'PASS'});
  assert.deepEqual((await parse('next')).input,{hostReport:{}});
  assert.deepEqual((await parse('next',['host.json'])).input.hostReport.file,'host.json');
  assert.equal((await parse('start',['host.json','120'])).input.leaseSeconds,120);
  assert.equal((await parse('start')).input.leaseSeconds,undefined);
  assert.equal((await parse('complete',['u','t','outcome.json','3'])).input.leaseGeneration,3);
  assert.equal((await parse('complete',['u','t','outcome.json'])).input.leaseGeneration,undefined);
  assert.equal((await parse('apply-write',['u','t','4','docs/guide','text.txt'])).input.content,'file content text.txt');
  assert.equal((await parse('apply-write',['u','t','4','docs/guide','--delete','a'.repeat(64)])).input.deleteFile,true);
  assert.equal((await parse('apply-write',['u','t','4','docs/guide','--delete','a'.repeat(64)])).input.expectedPreSha256,'a'.repeat(64));
  assert.equal((await parse('heartbeat',['u','t','5','30'])).input.leaseSeconds,30);
  assert.equal((await parse('heartbeat',['u','t','5'])).input.leaseSeconds,300);
  assert.equal((await parse('retry',['u'])).input.unitId,'u');
  assert.equal((await parse('operator-import',['signed.json'])).input.envelope.file,'signed.json');
  assert.equal((await parse('review-open',['a'.repeat(40),'host.json','HIGH'])).input.risk,'HIGH');
  assert.equal((await parse('review-open',['a'.repeat(40)])).input.risk,'MEDIUM');
  assert.equal((await parse('review-next',['host.json'])).input.hostReport.file,'host.json');
  assert.equal((await parse('review-start')).input.hostReport,undefined);
  assert.equal((await parse('review-submit',['risk','t','a'.repeat(40),'review.json'])).input.lensId,'risk');
  assert.equal((await parse('delivery-check')).input.ciEnvelope,null);
  assert.equal((await parse('delivery-check',['ci.json','op.json'])).input.operatorEnvelope.file,'op.json');
  assert.deepEqual((await parse('storage-history')).input,{limit:25,before:null});
  assert.deepEqual((await parse('storage-history',['15','32','REVIEW'])).input,
    {limit:15,before:32,category:'REVIEW'});
  assert.deepEqual((await parse('storage-reviews',['5','22'])).input,{limit:5,before:22});
  assert.deepEqual((await parse('mission-history',['9','44'])).input,{limit:9,before:44});
  assert.deepEqual((await parse('mission-history')).input,{limit:25,before:null});
  assert.equal((await parse('storage-backup',['backup.sqlite'])).input.destination,'backup.sqlite');
  assert.equal((await parse('storage-restore',['backup.sqlite'])).input.offline,true);
  await assert.rejects(parse('init'),/JSON path missing/);
  await assert.rejects(parse('apply-write',['u','t','3','docs/a']),/Content path missing/);
  await assert.rejects(parse('status','not-array'),/Commands:/);
});
