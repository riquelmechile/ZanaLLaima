// Checks in GitHub Actions (the host has no shell). checksStart dispatches the
// checks workflow on the head of the mission branch, or associates the runs
// the push already started, and returns a checkId bound to that SHA without
// blocking. checksStatus reads the check runs of that exact SHA; on failure it
// returns the redacted tail of the failed job logs.
import {randomUUID} from 'node:crypto';

const OK=new Set(['success','neutral','skipped']);
const MAX_FAILED_LOGS=3;

// SUCCESS only with at least one success, every relevant run completed and
// none failed. Required names, when configured, must all be present.
export function evaluateRuns(runs,sha,required=[]){
  const exact=runs.filter(r=>!r.head_sha||r.head_sha===sha);
  const relevant=required.length?exact.filter(r=>required.includes(r.name)):exact;
  const missing=required.filter(n=>!exact.some(r=>r.name===n));
  const failed=relevant.filter(r=>r.status==='completed'&&!OK.has(r.conclusion));
  const pending=relevant.filter(r=>r.status!=='completed');
  const state=failed.length?'FAILURE':
    pending.length||missing.length||!relevant.length?'PENDING':
    relevant.some(r=>r.conclusion==='success')?'SUCCESS':'FAILURE';
  return {state,sha,missing,
    runs:relevant.map(r=>({id:r.id,name:r.name,status:r.status,conclusion:r.conclusion??null,url:r.html_url??null}))};
}

export function createChecks({github,config,remoteWrite,remoteRead,missionContext,recordActivity}){
  async function verdict(repo,sha){
    return evaluateRuns(await github.checkRuns(repo,sha),sha,config.requiredChecks);
  }
  return {
    verdict,
    async start(missionId,session){
      const ctx=await missionContext(missionId,session.sessionId,{write:true});
      const sha=await github.branchHead(ctx.repo,ctx.branch);
      const workflow=config.checksWorkflow;
      const runs=(await github.workflowRuns(ctx.repo,sha)).filter(r=>r.head_sha===sha&&
        (String(r.path??'').endsWith('/'+workflow)||String(r.path??'')===workflow));
      let dispatched=false;
      if(!runs.length){await github.dispatchWorkflow(ctx.repo,workflow,ctx.branch);dispatched=true;}
      const checkId=randomUUID();
      await remoteWrite(db=>{
        recordActivity(db,{sessionId:session.sessionId,missionId,kind:'CHECKS_START',tool:'zana_checks_start'});
        db.prepare('INSERT INTO remote_checks(check_id,mission_id,sha,workflow,dispatched,session_id,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(checkId,missionId,sha,workflow,dispatched?1:0,session.sessionId,new Date().toISOString());
      });
      return {checkId,missionId,sha,branch:ctx.branch,workflow,dispatched,
        associatedRuns:runs.map(r=>({id:r.id,status:r.status,conclusion:r.conclusion??null,url:r.html_url??null})),
        note:dispatched?'Dispatched '+workflow+' on '+ctx.branch+'; it runs on the branch head at dispatch time. Status is always read for this exact SHA.':
          'Associated the runs the push already started for this SHA.'};
    },
    async status(checkId){
      const row=await remoteRead(db=>db?.prepare('SELECT * FROM remote_checks WHERE check_id=?').get(checkId)??null);
      if(!row)throw new Error('Unknown checkId');
      const ctx=await missionContext(row.mission_id,null,{allowInactive:true});
      const result=await verdict(ctx.repo,row.sha);
      let head=null;
      try{head=await github.branchHead(ctx.repo,ctx.branch);}catch{head=null;}
      const failures=[];
      if(result.state==='FAILURE'){
        for(const run of result.runs.filter(r=>r.status==='completed'&&!OK.has(r.conclusion)).slice(0,MAX_FAILED_LOGS)){
          let logTail;
          try{logTail=await github.jobLogTail(ctx.repo,run.id,60);}
          catch(error){logTail=['(log unavailable: '+String(error?.message??error).slice(0,200)+')'];}
          failures.push({name:run.name,url:run.url,logTail});
        }
      }
      return {checkId,missionId:row.mission_id,...result,failures,
        branchHead:head,headMoved:head!==null&&head!==row.sha};
    },
  };
}
