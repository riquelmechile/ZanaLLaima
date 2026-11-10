// Checks in GitHub Actions (the only evidence, whatever the host can run).
// checksStart dispatches the checks workflow on the head of the mission branch,
// or associates the runs that SHA already has, and returns a checkId bound to
// that SHA without blocking. checksStatus reads the check runs of that exact SHA; on failure it
// returns the redacted tail of the failed job logs.
import {randomUUID} from 'node:crypto';
import {createDeadline,LOG_BUDGET_MS} from './deadline.mjs';

const OK=new Set(['success','neutral','skipped']);
const MAX_FAILED_LOGS=3;
const UNTESTED_NOTE='Solo hay checks saltados o neutros sobre este SHA: ninguno lo probó todavía. Si acabas de llamar zana_checks_start, vuelve a consultar; no hagas un commit de corrección por esto.';

// SUCCESS only with at least one success, every relevant run completed and
// none failed. Required names, when configured, must all be present. Si solo
// hay checks saltados o neutros, nadie probó el SHA: es PENDING con una nota,
// no FAILURE (el CI propio del repo, saltado en zana/**, aparece antes que la
// corrida real).
export function evaluateRuns(runs,sha,required=[]){
  const exact=runs.filter(r=>!r.head_sha||r.head_sha===sha);
  const relevant=required.length?exact.filter(r=>required.includes(r.name)):exact;
  const missing=required.filter(n=>!exact.some(r=>r.name===n));
  const failed=relevant.filter(r=>r.status==='completed'&&!OK.has(r.conclusion));
  const pending=relevant.filter(r=>r.status!=='completed');
  const untested=!failed.length&&!pending.length&&relevant.length>0&&!relevant.some(r=>r.conclusion==='success');
  const state=failed.length?'FAILURE':
    pending.length||missing.length||!relevant.length||untested?'PENDING':'SUCCESS';
  return {state,sha,missing,...(untested?{note:UNTESTED_NOTE}:{}),
    runs:relevant.map(r=>({id:r.id,name:r.name,status:r.status,conclusion:r.conclusion??null,url:r.html_url??null,
      ...(r.details_url?{detailsUrl:r.details_url}:{})}))};
}

// A check run id is not the Actions job id. The job comes from the check
// run's details_url/html_url (.../actions/runs/R/job/J) or, when only the run
// is linked, from that run's job list by exact name.
const JOB_URL=/\/actions\/runs\/(\d+)\/jobs?\/(\d+)(?:[/?#]|$)/;
const RUN_URL=/\/actions\/runs\/(\d+)(?:[/?#]|$)/;
export async function actionsJobId(github,repo,run){
  const urls=[run.detailsUrl,run.url].map(u=>String(u??''));
  for(const u of urls){const m=JOB_URL.exec(u);if(m)return Number(m[2]);}
  for(const u of urls){
    const m=RUN_URL.exec(u);
    if(!m)continue;
    const jobs=(await github.runJobs(repo,Number(m[1]))).filter(j=>j?.name===run.name);
    if(jobs.length===1&&Number.isSafeInteger(Number(jobs[0].id)))return Number(jobs[0].id);
  }
  return null;
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
        recordActivity(db,{sessionId:session.sessionId,clientId:session.clientId,missionId,kind:'CHECKS_START',tool:'zana_checks_start'});
        db.prepare('INSERT INTO remote_checks(check_id,mission_id,sha,workflow,dispatched,session_id,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(checkId,missionId,sha,workflow,dispatched?1:0,session.sessionId,new Date().toISOString());
      });
      return {checkId,missionId,sha,branch:ctx.branch,workflow,dispatched,
        associatedRuns:runs.map(r=>({id:r.id,status:r.status,conclusion:r.conclusion??null,url:r.html_url??null})),
        note:dispatched?'Dispatched '+workflow+' on '+ctx.branch+'; it runs on the branch head at dispatch time. Status is always read for this exact SHA.':
          'Associated the runs this SHA already has.'};
    },
    async status(checkId){
      const row=await remoteRead(db=>db?.prepare('SELECT * FROM remote_checks WHERE check_id=?').get(checkId)??null);
      if(!row)throw new Error('Unknown checkId');
      const ctx=await missionContext(row.mission_id,null,{allowInactive:true});
      const deadline=createDeadline(config.toolDeadlineMs);
      const result=await deadline.step(()=>verdict(ctx.repo,row.sha),'check-runs',
        {fallback:{state:'UNKNOWN',sha:row.sha,missing:[],runs:[]}});
      let head=null,headError=null;
      try{head=await deadline.step(()=>github.branchHead(ctx.repo,ctx.branch),'branch-head',{fallback:null});}
      catch(error){headError=String(error?.message??error).slice(0,200);}
      if(head===null&&!headError&&deadline.partial.includes('branch-head'))headError='branch head read exceeded the tool deadline';
      const failures=[];
      if(result.state==='FAILURE'){
        // Job logs get their own budget, shared by all failed jobs.
        const logs=createDeadline(Math.min(LOG_BUDGET_MS,deadline.remaining()));
        for(const run of result.runs.filter(r=>r.status==='completed'&&!OK.has(r.conclusion)).slice(0,MAX_FAILED_LOGS)){
          let logTail;
          try{logTail=await logs.step(async()=>{
            const jobId=await actionsJobId(github,ctx.repo,run);
            return jobId===null?['(log unavailable: no GitHub Actions job found for this check run)']:github.jobLogTail(ctx.repo,jobId,60);
          },'log:'+run.name,{fallback:['(log omitted: log time budget exhausted)']});}
          catch(error){logTail=['(log unavailable: '+String(error?.message??error).slice(0,200)+')'];}
          failures.push({name:run.name,url:run.url,logTail});
        }
        deadline.partial.push(...logs.partial);
      }
      return {checkId,missionId:row.mission_id,...result,failures,branchHead:head,
        headMoved:head===null?null:head!==row.sha,...(head===null?{headMovedReason:headError??'unknown'}:{}),
        partial:deadline.partial.length?deadline.partial:undefined};
    },
  };
}
