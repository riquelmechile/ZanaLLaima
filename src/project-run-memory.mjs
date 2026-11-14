// Proyección pura de estados YA validados por la máquina zana.project-run.v2.
// prev puede ser null/undefined o del mismo plan; otro proyecto/plan se reconcilia como corrida nueva.
// Aplicar retire ANTES de save en la misma transacción que la transición: un retire perdido no se repara solo.
// Sin red, DB ni reloj. retire.prefix identifica topics vivos del proyecto por prefijo.
const MAX=1000;
const clean=value=>String(value??'').replace(/\s+/g,' ').replace(/[\p{Cc}\p{Cf}]/gu,'')
  .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,'')
  .replace(/\s+/g,' ').trim()||'—';
const short=(value,size)=>{
  const s=clean(value);
  if(s.length<=size)return s;
  let cut=s.slice(0,Math.max(0,size-1));
  if(/[\uD800-\uDBFF]$/.test(cut))cut=cut.slice(0,-1);
  return cut+'…';
};
const sentence=s=>/[.!?…]$/.test(s)?s:s+'.';
const count=m=>m.parts.length;
const topic=m=>'hito:'+short(m.id,75);
const entry=(kind,key,body,missionId=null,sha=null)=>({kind,topic:key,body,missionId,sha});
const mergeSha=p=>p?.mergeCommitSha;

function milestoneLine(m){
  const n=count(m);
  let line=short(m.id,75)+': ';
  if(m.status==='PARTIAL')line+='PARTIAL ('+n+' '+(n===1?'parte fusionada':'partes fusionadas')+')';
  else if(m.status==='RUNNING')line+='RUNNING misión '+short(m.running.missionId,75)+
    ' (parte '+(n+1)+', final '+(m.running.final?'sí':'no')+')';
  else line+='PENDING';
  if(m.attempts.length)line+=' · '+(m.attempts.length>=20?'20+':m.attempts.length)+
    ' '+(m.attempts.length===1?'intento fallido':'intentos fallidos');
  return line;
}
export function runBoard(state){
  const ms=state.milestones,completed=ms.filter(m=>m.status==='DONE');
  let header='Plan '+clean(state.planDigest).slice(0,8)+' · '+clean(state.status)+
    ' · revisión '+state.revision+' · '+completed.length+'/'+ms.length+' hitos';
  if(state.status==='CANCELLED')header+=' · motivo: '+short(state.reason,180);
  if(state.outsidePlan.length)header+=' · fuera del plan: '+
    (state.outsidePlan.length>=50?'50+':state.outsidePlan.length);
  let doneLine='';
  if(completed.length){
    const ids=completed.map(m=>short(m.id,75)),prefix='DONE ('+completed.length+'):';
    let included=0;
    for(let i=0;i<ids.length;i++){
      const candidate=prefix+' '+ids.slice(0,i+1).join(', ');
      const missing=ids.length-i-1;
      if(candidate.length+(missing?' … +'+missing:'').length>300)break;
      included=i+1;
    }
    doneLine=prefix+(included?' '+ids.slice(0,included).join(', '):'')+
      (included<ids.length?' … +'+(ids.length-included):'');
  }
  const pending=ms.filter(m=>m.status!=='DONE');
  const lines=['RUNNING','PARTIAL','PENDING'].flatMap(status=>
    pending.filter(m=>m.status===status).map(milestoneLine));
  const kept=[],base=[header,...(doneLine?[doneLine]:[])];
  const marker=n=>'… +'+n+(n===1?' hito':' hitos');
  for(let i=0;i<lines.length;i++){
    const remaining=lines.length-i-1,suffix=remaining?'\n'+marker(remaining):'';
    if([...base,...kept,lines[i]].join('\n').length+suffix.length>MAX)break;
    kept.push(lines[i]);
  }
  if(kept.length<lines.length){
    let missing=lines.length-kept.length;
    while(kept.length&&[...base,...kept,marker(missing)].join('\n').length>MAX){
      kept.pop();missing++;
    }
    kept.push(marker(missing));
  }
  return [...base,...kept].join('\n');
}
const descriptions=m=>'Objetivo: '+sentence(short(m.objective,240))+
  ' Aceptación: '+sentence(short(m.acceptance,240));
// Conserva siempre las partes más recientes; nunca corta un PR, misión o SHA.
function partsList(parts,format,max){
  const shown=[];
  for(let i=parts.length-1;i>=0;i--){
    const item=format(parts[i]),rest=[item,...shown].join(', ');
    if((i?'…, ':'').length+rest.length>max)break;
    shown.unshift(item);
  }
  return (shown.length<parts.length?'…, ':'')+shown.join(', ');
}
const partialBody=m=>{
  const n=count(m),prefix='Parcial: '+n+' '+(n===1?'parte fusionada (':'partes fusionadas (');
  const suffix='). Falta la parte siguiente. '+descriptions(m);
  return prefix+partsList(m.parts,p=>'PR #'+p.prNumber+' '+clean(p.mergeCommitSha).slice(0,7),
    MAX-prefix.length-suffix.length)+suffix;
};
const runningBody=m=>'En curso: misión '+short(m.running.missionId,75)+', parte '+(count(m)+1)+
  ', final '+(m.running.final?'sí':'no')+'. '+descriptions(m);
const attemptText=a=>{
  const prefix='Intento fallido: misión '+short(a.missionId,75)+
    (a.prNumber==null?'':', PR #'+a.prNumber)+'. Motivo: ';
  return prefix+sentence(short(a.reason,MAX-prefix.length-1));
};
const issueBody=(m,run)=>run.status==='CANCELLED'||m.status==='DONE'||!m.attempts.length?
  null:attemptText(m.attempts.at(-1));
const pendingBody=(m,run)=>run.status==='CANCELLED'?null:
  m.status==='RUNNING'?runningBody(m):m.status==='PARTIAL'?partialBody(m):null;
const isNewAttempt=(m,old)=>{
  const last=m.attempts.at(-1);
  return Boolean(last)&&!old?.attempts.some(a=>a.missionId===last.missionId);
};
const isNewPart=(m,old)=>{
  const a=m.parts.at(-1),b=old?.parts.at(-1);
  return Boolean(a)&&(!b||a.missionId!==b.missionId||mergeSha(a)!==mergeSha(b));
};

export function runMemoryEntries(prev,next){
  if(prev&&(prev.planDigest!==next.planDigest||prev.projectId!==next.projectId))prev=null;
  const save=[],retire=[],before=new Map((prev?.milestones??[]).map(m=>[m.id,m]));
  const fresh=prev==null;
  if(fresh)for(const kind of ['pending','issue','decision'])retire.push({kind,prefix:'hito:'});
  if(next.status==='CANCELLED'&&prev?.status!=='CANCELLED'&&!fresh)
    for(const kind of ['pending','issue'])retire.push({kind,prefix:'hito:'});
  const changes=next.milestones.map(m=>{
    const old=before.get(m.id),lastPart=m.parts.at(-1),lastAttempt=m.attempts.at(-1);
    return {m,old,lastPart,lastAttempt,part:isNewPart(m,old),attempt:isNewAttempt(m,old),
      claim:Boolean(m.running)&&m.running.missionId!==old?.running?.missionId};
  });
  const board=runBoard(next);
  if(fresh||runBoard(prev)!==board){
    const last=next.outsidePlan.at(-1),previous=prev?.outsidePlan.at(-1);
    const outside=last&&(!previous||last.missionId!==previous.missionId||
      last.at!==previous.at||last.reason!==previous.reason);
    const cause=changes.find(c=>c.claim)?.m.running.missionId??
      changes.find(c=>c.part)?.lastPart.missionId??
      changes.find(c=>c.attempt)?.lastAttempt.missionId??
      (outside?last.missionId:null);
    save.push(entry('decision','proyecto:avance',board,cause));
  }
  if(next.status==='CANCELLED')return {save,retire};
  for(const {m,old,lastPart,lastAttempt} of changes){
    const key=topic(m),was=old?pendingBody(old,prev):null,now=pendingBody(m,next);
    const beforeIssue=old?issueBody(old,prev):null,afterIssue=issueBody(m,next);
    if(!fresh){
      if(beforeIssue!==null&&afterIssue===null)retire.push({kind:'issue',topic:key});
      if(was!==null&&now===null)retire.push({kind:'pending',topic:key});
    }
    if(afterIssue!==null&&afterIssue!==beforeIssue)
      save.push(entry('issue',key,afterIssue,lastAttempt.missionId));
    if(now!==null&&now!==was)
      save.push(entry('pending',key,now,m.status==='RUNNING'?m.running.missionId:lastPart.missionId,
        m.status==='RUNNING'?null:lastPart.mergeCommitSha));
  }
  return {save,retire};
}
