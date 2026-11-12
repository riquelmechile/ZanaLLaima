import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteConfig} from '../src/remote-config.mjs';
import {validateGithubAdmin,githubAdminRequest,githubAdminAudit} from '../src/github-admin.mjs';

test('full access is off and fails closed without a distinct bootstrap token',()=>{
  assert.equal(remoteConfig({}).githubFullAccess,false);
  assert.throws(()=>remoteConfig({ZANA_GITHUB_FULL_ACCESS:'true'}),/TOKEN_MISSING/);
  assert.throws(()=>remoteConfig({ZANA_GITHUB_FULL_ACCESS:'true',ZANA_BOOTSTRAP_GITHUB_TOKEN:'x',ZANA_DOWNSTREAM_GITHUB_TOKEN:'x'}),/TOKEN_SHARED/);
});
test('validates paths, accept and reviewer scope',()=>{
  for(const path of ['https://x','//repos/x','/repos/../x','/repos\\x','/repos/x\r\ny'])
    assert.throws(()=>validateGithubAdmin({method:'GET',path}),/PATH/);
  assert.throws(()=>validateGithubAdmin({method:'GET',path:'/repos/x',identity:'reviewer'}),/REVIEWER_SCOPE/);
  assert.doesNotThrow(()=>validateGithubAdmin({method:'PATCH',path:'/user/repository_invitations/7',identity:'reviewer'}));
});
test('executes the bootstrap sequence and audit excludes bodies and tokens',async()=>{
  const calls=[];
  const owner={request:async(method,path,options)=>{calls.push({identity:'owner',method,path,options});return {status:201,data:{ok:true}};}};
  const reviewer={request:async(method,path,options)=>{calls.push({identity:'reviewer',method,path,options});return {status:204,data:null};}};
  await githubAdminRequest({method:'PUT',path:'/repos/o/r/contents/.github/workflows/zana-checks.yml',body:{content:'x'}},{owner,reviewer});
  await githubAdminRequest({method:'PUT',path:'/repos/o/r/collaborators/reviewer',body:{permission:'push'}},{owner,reviewer});
  await githubAdminRequest({method:'PATCH',path:'/user/repository_invitations/7',identity:'reviewer'},{owner,reviewer});
  await githubAdminRequest({method:'PUT',path:'/repos/o/r/branches/main/protection',body:{required_pull_request_reviews:{required_approving_review_count:1}}},{owner,reviewer});
  assert.deepEqual(calls.map(x=>[x.identity,x.method,x.path]),[
    ['owner','PUT','/repos/o/r/contents/.github/workflows/zana-checks.yml'],['owner','PUT','/repos/o/r/collaborators/reviewer'],
    ['reviewer','PATCH','/user/repository_invitations/7'],['owner','PUT','/repos/o/r/branches/main/protection']]);
  const audit=githubAdminAudit({method:'PUT',path:'/repos/o/r?token=secret',body:{token:'secret'},identity:'owner'},201);
  assert.deepEqual(audit,{method:'PUT',path:'/repos/o/r',status:201,identity:'owner'});
  assert.equal(JSON.stringify(audit).includes('secret'),false);
});
