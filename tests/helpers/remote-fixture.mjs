import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fakeGitHubApi,fakeGitHubMcp,AUTHOR_TOKEN,REVIEWER_TOKEN,REVIEWER_LOGIN,AUTHOR_LOGIN,sha} from './fake-github.mjs';
import {createRemoteRuntime} from '../../src/remote.mjs';
import {registerSession} from '../../src/remote-state.mjs';
import {ensureSchema} from '../../src/store.mjs';

export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// Read every diff page of a claimed ticket (no-op before zana_review_diff exists).
export async function readDiff(call,ticket,s){
  const first=await call('zana_review_diff',{ticket,page:0},s);
  if(first.error&&/Unknown tool/.test(first.error))return;
  if(first.error)throw new Error(first.error);
  for(let p=1;p<first.manifest.totalPages;p++){const r=await call('zana_review_diff',{ticket,page:p},s);if(r.error)throw new Error(r.error);}
}
export {AUTHOR_TOKEN,REVIEWER_TOKEN,REVIEWER_LOGIN,AUTHOR_LOGIN,sha};

export async function remoteFixture({envExtra={},mcp={}}={}){
  const dir=await mkdtemp(join(tmpdir(),'zana-remote-'));
  const previous=process.env.ZANA_STATE_FILE;
  process.env.ZANA_STATE_FILE=join(dir,'state.json');
  await ensureSchema();
  const api=await fakeGitHubApi();
  const ds=await fakeGitHubMcp(mcp);
  const env={ZANA_GITHUB_REPOS:'o/r',ZANA_GITHUB_API_URL:api.url,ZANA_DOWNSTREAM_GITHUB_URL:ds.url,
    ZANA_DOWNSTREAM_GITHUB_TOKEN:AUTHOR_TOKEN,ZANA_REVIEWER_TOKEN:REVIEWER_TOKEN,ZANA_REVIEWER_LOGIN:REVIEWER_LOGIN,...envExtra};
  const runtime=createRemoteRuntime({env});
  let n=0;
  const session=async(host='zana-chatgpt',clientId='zc_test')=>{
    await sleep(3); // distinct creation timestamps
    return {...await registerSession({sessionId:'sess-'+(++n)+'-'+Date.now(),host,clientId}),host};
  };
  const call=async(name,args,s)=>{
    const r=await runtime.dispatch(name,args,s);
    if(r.isError)return {error:r.content[0].text,raw:r};
    return r.structuredContent??r;
  };
  const spec={objective:'Add a small function with its test',
    units:[{id:'code',effect:'READ',code:true,instruction:'Implement the function and its test'},
      {id:'notes',effect:'READ',instruction:'Summarize the change',dependsOn:['code']}]};
  // Author: mission, started code unit, branch pushed with commit, open PR, green checks.
  // W3 order: with green checks and an open PR the code unit is completed
  // (complete:true, the default) before any ticket; complete:false keeps it RUNNING.
  async function authorReady({green=true,pull=true,complete=green&&pull}={}){
    const author=await session();
    const init=await call('zana_mission_init',{spec,github:{repo:'o/r',base:'main'}},author);
    const batch=await call('zana_start_batch',{},author);
    const branch=init.github.branch;
    api.state.push(branch,sha('a'));
    if(green)api.state.green(sha('a'));
    if(pull)api.state.openPull(branch);
    const packet=batch.packets[0];
    if(complete){
      const done=await call('zana_complete_unit',{unitId:packet.unitId,token:packet.token,leaseGeneration:packet.leaseGeneration,
        outcome:{success:true,summary:'code on '+sha('a'),evidence:['green checks on '+sha('a')]}},author);
      if(done.error)throw new Error('authorReady: '+done.error);
    }
    return {author,init,batch,branch,missionId:init.id,packet,completed:complete};
  }
  return {dir,api,ds,env,runtime,session,call,spec,authorReady,
    cleanup:async()=>{await runtime.close();await api.close();await ds.close();
      if(previous===undefined)delete process.env.ZANA_STATE_FILE;else process.env.ZANA_STATE_FILE=previous;
      await rm(dir,{recursive:true,force:true});}};
}
