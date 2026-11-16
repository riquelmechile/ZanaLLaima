import {validateRun} from './project-orchestrator.mjs';
import {runMemoryEntries} from './project-run-memory.mjs';
import {saveEntry} from './project-memory.mjs';
import {nowIso} from './remote-state.mjs';

const key=id=>'zana:run:'+id,dirty=id=>'zana:run-memory-dirty:'+id;
const fail=(code,msg)=>{throw new Error(code+': '+msg);};

export function loadRun(db,projectId){
  const row=db.prepare('SELECT value FROM metadata WHERE key=?').get(key(projectId));
  if(!row)return null;
  try{return validateRun(JSON.parse(row.value));}
  catch{fail('RUN_CORRUPT','la corrida persistida no es válida');}
}

export function retireRunMemory(db,projectId,item){
  const base='UPDATE project_memory SET resolved_at=? WHERE project_id=? AND kind=? AND superseded_by IS NULL AND resolved_at IS NULL AND ';
  return Number((item.topic?db.prepare(base+'topic=?').run(nowIso(),projectId,item.kind,item.topic):
    db.prepare(base+'substr(topic,1,length(?))=?').run(nowIso(),projectId,item.kind,item.prefix,item.prefix)).changes);
}
export function applyRunMemory(db,projectId,prev,next,{missionId=null,secrets=[]}={}){
  const changes=runMemoryEntries(prev,next);let retired=0;
  for(const item of changes.retire)retired+=retireRunMemory(db,projectId,item);
  for(const item of changes.save)saveEntry(db,{projectId,...item,missionId:item.missionId??missionId,secrets});
  return {saved:changes.save.length,retired};
}

function project(db,run,prev,options){
  db.exec('SAVEPOINT run_memory');
  try{
    const memory=applyRunMemory(db,run.projectId,prev,run,options);
    db.exec('RELEASE run_memory');
    db.prepare('DELETE FROM metadata WHERE key=?').run(dirty(run.projectId));
    return memory;
  }catch(error){
    if(!db.isTransaction)throw error;
    db.exec('ROLLBACK TO run_memory');db.exec('RELEASE run_memory');
    db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run(dirty(run.projectId),nowIso());
    return {memoryError:'MEMORY_UNAVAILABLE: no se pudo proyectar la corrida'};
  }
}
export function repairRunMemory(db,run,options={}){
  if(!db.prepare('SELECT 1 FROM metadata WHERE key=?').get(dirty(run.projectId)))return {};
  const result=project(db,run,null,options);
  return result.memoryError?result:{...result,memoryRepaired:true};
}
export function saveRun(db,prev,next,options={}){
  validateRun(next);
  if(prev&&next.projectId!==prev.projectId)fail('STALE_REVISION','el proyecto cambió');
  if(next.revision!==(prev?prev.revision+1:0))fail('STALE_REVISION','la revisión no es consecutiva');
  db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run(key(next.projectId),JSON.stringify(next));
  const stale=db.prepare('SELECT 1 FROM metadata WHERE key=?').get(dirty(next.projectId));
  return project(db,next,stale?null:prev,options);
}
