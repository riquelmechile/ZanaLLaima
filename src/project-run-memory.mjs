// Proyección pura del progreso de los hitos a la memoria por proyecto.
// El servidor persiste las entradas; este módulo nunca accede a red, DB ni reloj.
const MAX=1000;
const short=(value,size)=>{
  const text=String(value??'');
  return text.length>size?text.slice(0,Math.max(0,size-1))+'…':text;
};
const count=m=>m.parts.length;
const topic=m=>'hito:'+short(m.id,75);
const entry=(kind,topic,body,missionId=null,sha=null)=>({kind,topic,body,missionId,sha});

function milestoneLine(m){
  const n=count(m);
  let line=m.id+': ';
  if(m.status==='DONE')line+='DONE ('+n+' partes)';
  else if(m.status==='PARTIAL')line+='PARTIAL ('+n+' partes fusionadas)';
  else if(m.status==='RUNNING')line+='RUNNING misión '+m.running.missionId+
    ' (parte '+(n+1)+', final '+(m.running.final?'sí':'no')+')';
  else line+='PENDING';
  if(m.attempts.length)line+=' · '+m.attempts.length+' intentos fallidos';
  return line;
}

export function runBoard(state){
  const milestones=state.milestones;
  const done=milestones.filter(m=>m.status==='DONE').length;
  let header='Plan '+state.planDigest.slice(0,8)+' · '+state.status+
    ' · revisión '+state.revision+' · '+done+'/'+milestones.length+' hitos';
  if(state.status==='CANCELLED')header+=' · motivo: '+short(state.reason,180);
  const lines=milestones.map(milestoneLine);
  const extra=state.outsidePlan.length?'Fuera del plan: '+state.outsidePlan.length+' misiones':null;
  const all=[header,...lines,...(extra?[extra]:[])].join('\n');
  if(all.length<=MAX)return all;
  const kept=[];
  for(let i=0;i<lines.length;i++){
    const omitted=lines.length-i-1;
    const marker=omitted?'\n… +'+omitted+' hitos':'';
    if([header,...kept,lines[i]].join('\n').length+marker.length>MAX)break;
    kept.push(lines[i]);
  }
  if(kept.length<lines.length)
    return [header,...kept,'… +'+(lines.length-kept.length)+' hitos'].join('\n');
  // Todos los hitos caben; si solo sobra la línea de fuera de plan, se omite.
  return [header,...kept].join('\n');
}

const descriptions=m=>'Objetivo: '+short(m.objective,240)+'. Aceptación: '+
  short(m.acceptance,240)+'.';
// Las listas se truncan en el límite entre partes, nunca dentro de un PR o SHA.
function partsList(parts,format,max){
  let body='';
  for(let i=0;i<parts.length;i++){
    const item=(body?', ':'')+format(parts[i]);
    const reserve=i<parts.length-1?3:0;
    if(body.length+item.length+reserve>max)return body?body+', …':'…';
    body+=item;
  }
  return body;
}
const partialBody=m=>{
  const prefix='Parcial: '+count(m)+' partes fusionadas (';
  const suffix='). Falta la parte siguiente. '+descriptions(m);
  const list=partsList(m.parts,p=>'PR #'+p.prNumber+' '+p.mergeCommitSha.slice(0,7),
    MAX-prefix.length-suffix.length);
  return prefix+list+suffix;
};
const finalBody=m=>{
  const prefix='Terminado en '+count(m)+' partes: ';
  return prefix+partsList(m.parts,p=>'PR #'+p.prNumber+
    ' (misión '+p.missionId+', merge '+p.mergeCommitSha.slice(0,7)+')',MAX-prefix.length);
};
const runningBody=m=>{
  const prefix='En curso: misión '+m.running.missionId+', parte '+(count(m)+1)+
    ', final '+(m.running.final?'sí':'no')+'. ';
  return prefix+descriptions(m);
};
const issueBody=attempt=>{
  const prefix='Intento fallido: misión '+attempt.missionId+
    (attempt.prNumber===null?'':', PR #'+attempt.prNumber)+'. Motivo: ';
  return prefix+short(attempt.reason,Math.max(1,MAX-prefix.length-1))+'.';
};

export function runMemoryEntries(prev,next){
  const save=[],resolve=[];
  const before=new Map((prev?.milestones??[]).map(m=>[m.id,m]));
  const changes=next.milestones.map(m=>{
    const old=before.get(m.id);
    const oldParts=old?.parts.length??0,oldAttempts=old?.attempts.length??0;
    const started=Boolean(m.running)&&!old?.running;
    const gainedPart=m.parts.length>oldParts;
    const gainedAttempt=m.attempts.length>oldAttempts;
    const lastPart=m.parts.at(-1),lastAttempt=m.attempts.at(-1);
    const missionId=started?m.running.missionId:
      gainedPart?lastPart.missionId:gainedAttempt?lastAttempt.missionId:null;
    return {m,started,gainedPart,gainedAttempt,lastPart,lastAttempt,missionId};
  });
  const board=runBoard(next);
  if(prev===null||runBoard(prev)!==board){
    const cause=prev===null?null:
      changes.find(c=>c.missionId)?.missionId??
      (next.outsidePlan.length>prev.outsidePlan.length?
        next.outsidePlan.at(-1).missionId:null);
    save.push(entry('decision','proyecto:avance',board,cause));
  }
  for(const {m,started,gainedPart,gainedAttempt,lastPart,lastAttempt} of changes){
    const key=topic(m);
    if(started)
      save.push(entry('pending',key,short(runningBody(m),MAX),m.running.missionId));
    if(gainedPart&&m.status==='PARTIAL')
      save.push(entry('pending',key,short(partialBody(m),MAX),
        lastPart.missionId,lastPart.mergeCommitSha));
    if(gainedPart&&m.status==='DONE'){
      resolve.push(key);
      save.push(entry('decision',key,short(finalBody(m),MAX),
        lastPart.missionId,lastPart.mergeCommitSha));
    }
    if(gainedAttempt){
      save.push(entry('issue',key,short(issueBody(lastAttempt),MAX),lastAttempt.missionId));
      if(m.status==='PARTIAL'&&!(gainedPart&&m.status==='PARTIAL')){
        save.push(entry('pending',key,short(partialBody(m),MAX),
          lastPart.missionId,lastPart.mergeCommitSha));
      }
      if(m.status==='PENDING')resolve.push(key);
    }
  }
  return {save,resolve};
}
