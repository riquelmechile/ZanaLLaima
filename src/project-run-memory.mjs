// Proyección pura de estados YA validados por la máquina zana.project-run.v2.
// Con estados malformados, el comportamiento no está definido. Sin red, DB ni reloj.
const MAX=1000;
const clean=value=>String(value??'').replace(/\s+/g,' ').trim();
const short=(value,size)=>{
  const s=clean(value);
  if(s.length<=size)return s;
  let cut=s.slice(0,Math.max(0,size-1));
  if(/[\uD800-\uDBFF]$/.test(cut))cut=cut.slice(0,-1);
  return cut+'…';
};
const sentence=s=>s.endsWith('.')?s:s+'.';
const count=m=>m.parts.length;
const topic=m=>'hito:'+short(m.id,75);
const entry=(kind,key,body,missionId=null,sha=null)=>({kind,topic:key,body,missionId,sha});
const tail=p=>p?.mergeCommitSha;

function milestoneLine(m){
  const n=count(m);
  let line=short(m.id,75)+': ';
  if(m.status==='DONE')line+='DONE ('+n+' partes)';
  else if(m.status==='PARTIAL')line+='PARTIAL ('+n+' partes fusionadas)';
  else if(m.status==='RUNNING')line+='RUNNING misión '+short(m.running.missionId,75)+
    ' (parte '+(n+1)+', final '+(m.running.final?'sí':'no')+')';
  else line+='PENDING';
  if(m.attempts.length)line+=' · '+(m.attempts.length===20?'20+':m.attempts.length)+' intentos fallidos';
  return line;
}
export function runBoard(state){
  const ms=state.milestones,done=ms.filter(m=>m.status==='DONE').length;
  let header='Plan '+clean(state.planDigest).slice(0,8)+' · '+clean(state.status)+
    ' · revisión '+state.revision+' · '+done+'/'+ms.length+' hitos';
  if(state.status==='CANCELLED')header+=' · motivo: '+short(state.reason,180);
  if(state.outsidePlan.length)header+=' · fuera del plan: '+
    (state.outsidePlan.length===50?'50+':state.outsidePlan.length);
  const lines=ms.map(milestoneLine),all=[header,...lines].join('\n');
  if(all.length<=MAX)return all;
  const kept=[];
  for(let i=0;i<lines.length;i++){
    const omitted=lines.length-i-1;
    const marker=omitted?'\n… +'+omitted+' hitos':'';
    if([header,...kept,lines[i]].join('\n').length+marker.length>MAX)break;
    kept.push(lines[i]);
  }
  return [header,...kept,'… +'+(lines.length-kept.length)+' hitos'].join('\n');
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
  const prefix='Parcial: '+count(m)+' partes fusionadas (';
  const suffix='). Falta la parte siguiente. '+descriptions(m);
  return prefix+partsList(m.parts,p=>'PR #'+p.prNumber+' '+clean(p.mergeCommitSha).slice(0,7),
    MAX-prefix.length-suffix.length)+suffix;
};
const finalBody=m=>{
  const prefix='Terminado en '+count(m)+' partes: ';
  return prefix+partsList(m.parts,p=>'PR #'+p.prNumber+
    ' (misión '+short(p.missionId,75)+', merge '+clean(p.mergeCommitSha).slice(0,7)+')',MAX-prefix.length);
};
const runningBody=m=>'En curso: misión '+short(m.running.missionId,75)+', parte '+(count(m)+1)+
  ', final '+(m.running.final?'sí':'no')+'. '+descriptions(m);
const issueBody=a=>{
  const prefix='Intento fallido: misión '+short(a.missionId,75)+
    (a.prNumber==null?'':', PR #'+a.prNumber)+'. Motivo: ';
  return prefix+sentence(short(a.reason,MAX-prefix.length-1));
};
const pendingBody=(m,run)=>run.status==='CANCELLED'?null:
  m.status==='RUNNING'?runningBody(m):m.status==='PARTIAL'?partialBody(m):null;
const isNewAttempt=(m,old)=>{
  const a=m.attempts.at(-1),b=old?.attempts.at(-1);
  return Boolean(a)&&(!b||a.missionId!==b.missionId||a.at!==b.at);
};
const isNewPart=(m,old)=>{
  const a=m.parts.at(-1),b=old?.parts.at(-1);
  return Boolean(a)&&(!b||a.missionId!==b.missionId||tail(a)!==tail(b));
};

export function runMemoryEntries(prev,next){
  const save=[],resolve=[],before=new Map((prev?.milestones??[]).map(m=>[m.id,m]));
  const changes=next.milestones.map(m=>{
    const old=before.get(m.id),lastPart=m.parts.at(-1),lastAttempt=m.attempts.at(-1);
    return {m,old,lastPart,lastAttempt,part:isNewPart(m,old),attempt:isNewAttempt(m,old),
      claim:Boolean(m.running)&&m.running.missionId!==old?.running?.missionId};
  });
  const board=runBoard(next);
  if(prev===null||runBoard(prev)!==board){
    const last=next.outsidePlan.at(-1),previous=prev?.outsidePlan.at(-1);
    const outside=last&&(!previous||last.missionId!==previous.missionId||
      last.at!==previous.at||last.reason!==previous.reason);
    const cause=changes.find(c=>c.claim)?.m.running.missionId??
      changes.find(c=>c.part)?.lastPart.missionId??
      changes.find(c=>c.attempt)?.lastAttempt.missionId??
      (outside?last.missionId:null);
    save.push(entry('decision','proyecto:avance',board,cause));
  }
  for(const {m,old,lastPart,lastAttempt,attempt} of changes){
    const key=topic(m),was=old&&prev?pendingBody(old,prev):null,now=pendingBody(m,next);
    if(attempt)save.push(entry('issue',key,issueBody(lastAttempt),lastAttempt.missionId));
    if(m.status==='DONE'&&old?.status!=='DONE'){
      save.push(entry('decision',key,finalBody(m),lastPart.missionId,lastPart.mergeCommitSha));
      if(m.attempts.length){
        const prefix='Resuelto: el hito terminó después de '+m.attempts.length+
          ' intentos fallidos. Último motivo: ';
        save.push(entry('issue',key,prefix+sentence(short(lastAttempt.reason,MAX-prefix.length-1)),
          lastPart.missionId,lastPart.mergeCommitSha));
      }
    }
    if(now!==null&&now!==was)
      save.push(entry('pending',key,now,m.status==='RUNNING'?m.running.missionId:lastPart.missionId,
        m.status==='RUNNING'?null:lastPart.mergeCommitSha));
    if(now===null&&was!==null)resolve.push(key);
  }
  return {save,resolve};
}
