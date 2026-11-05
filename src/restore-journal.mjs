import {open,readFile,readdir,rename,rm,stat,mkdir} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

// Recovery protocol v1. The journal, not mtime or a heuristic search, owns
// quarantine identity and EXACTLY which DB/WAL/SHM movements may be resumed.
// Every intent is fsynced BEFORE its rename, each directory after the rename,
// and a completed step is fsynced before proceeding. Crashes are replayable.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class RestoreJournalError extends Error{
 constructor(code,message){super(message);this.name='RestoreJournalError';this.code=code;}
}
const refuse=(code,message)=>{throw new RestoreJournalError(code,message);};
const has=async path=>{
 try{await stat(path);return true;}
 catch(error){if(error?.code==='ENOENT')return false;throw error;}
};
const syncDir=async path=>{
 const fd=await open(path,'r');
 try{await fd.sync();}finally{await fd.close();}
};
const journalPath=path=>path+'.restore-pending';
const stable=async (marker,journal)=>{
 const tmp=marker+'.new.'+randomUUID();
 const h=await open(tmp,'wx',0o600);
 try{await h.writeFile(JSON.stringify(journal));await h.sync();}
 finally{await h.close();}
 try{await rename(tmp,marker);await syncDir(dirname(marker));}
 finally{await rm(tmp,{force:true});}
};
const create=async(marker,journal)=>{
 const h=await open(marker,'wx',0o600);
 try{await h.writeFile(JSON.stringify(journal));await h.sync();}
 finally{await h.close();}
 await syncDir(dirname(marker));
};
const erase=async marker=>{
 await rm(marker,{force:true});await syncDir(dirname(marker));
};
const read=async path=>{
 const marker=journalPath(path);
 let data;
 try{data=await readFile(marker,'utf8');}
 catch(error){if(error?.code==='ENOENT')return null;throw error;}
 let j;
 try{j=JSON.parse(data);}catch{refuse('INVALID_JOURNAL','Restore journal invalid JSON; manual recovery required');}
 if(j?.version!==1||j.path!==path||!UUID.test(j.id)||!['restoring','aborting'].includes(j.phase)||
    j.quarantine!==path+'.quarantine.'+j.id||
    typeof j.temp!=='string'||!j.temp.startsWith(path+'.restoring.')||
    !Array.isArray(j.restoreOps)||j.restoreOps.length>4)
   refuse('INVALID_JOURNAL','Restore journal invalid format/identity; manual recovery required');
 // The journal is operator state, not an authorization to rename any path.
 const allowedFrom=new Set([path,path+'-wal',path+'-shm',j.temp]);
 for(const op of j.restoreOps){
   if(!allowedFrom.has(op.from)||!['pending','intent','done'].includes(op.state)||
      op.to!==(op.from===j.temp?path:j.quarantine+op.from.slice(path.length)))
     refuse('INVALID_JOURNAL','Restore journal contains an unsafe rename');
 }
 if(j.abortOps){
  if(!Array.isArray(j.abortOps)||j.abortOps.length>7)refuse('INVALID_JOURNAL','Bad abort journal');
  const allowed=new Set([path,path+'-wal',path+'-shm',j.quarantine,
    j.quarantine+'-wal',j.quarantine+'-shm',path+'.aborted.'+j.id]);
  for(const op of j.abortOps)
   if(!allowed.has(op.from)||!allowed.has(op.to)||!['pending','intent','done'].includes(op.state))
     refuse('INVALID_JOURNAL','Unsafe abort rename');
 }
 return j;
};
export async function classifyRestoreArtifacts(path){
 const prefix=basename(path),dir=dirname(path);
 let names;
 try{names=await readdir(dir);}
 catch(error){if(error?.code==='ENOENT')names=[];else throw error;}
 const grouped={restoring:[],quarantines:[],aborted:[],journal:[]};
 for(const name of names){
  const complete=join(dir,name);
  if(name===prefix+'.restore-pending')grouped.journal.push(complete);
  else if(name.startsWith(prefix+'.restoring.'))grouped.restoring.push(complete);
  else if(name.startsWith(prefix+'.quarantine.'))grouped.quarantines.push(complete);
  else if(name.startsWith(prefix+'.aborted.'))grouped.aborted.push(complete);
 }
 return grouped;
}
export async function cleanupRestoreArtifacts(path,{confirm=false}={}){
 if(!confirm)refuse('CONFIRM_REQUIRED','Artifact cleanup requires explicit --confirm');
 if(await has(journalPath(path)))
   refuse('JOURNAL_ACTIVE','Cannot clean restore artifacts while journal exists');
 const groups=await classifyRestoreArtifacts(path);
 const targets=[...groups.restoring,...groups.aborted];
 // Quarantines can contain the ONLY original authorization history.
 // Deliberately exclude them from automatic cleanup even with --confirm.
 for(const file of targets)await rm(file,{force:true});
 await syncDir(dirname(path));
 return {cleaned:targets,quarantinesRetained:groups.quarantines};
}
const runOp=async(marker,j,op,ordinal,hook)=>{
 if(op.state==='done')return;
 const from=await has(op.from),to=await has(op.to);
 if(!from&&!to)refuse('LOST_RENAME','Missing both source and destination of journal step '+ordinal);
 if(from&&to)refuse('AMBIGUOUS_RENAME','Both sides exist for journal step '+ordinal);
 op.state='intent';await stable(marker,j);
 if(from){
  await rename(op.from,op.to);
  await syncDir(dirname(op.from));
  if(dirname(op.to)!==dirname(op.from))await syncDir(dirname(op.to));
 }
 op.state='done';await stable(marker,j);
 if(hook)await hook({ordinal,from:op.from,to:op.to,phase:j.phase});
};
export async function beginRestoreMoves({path,temp,quarantine,checkpoint,allowUnreadable=false,afterJournalReady,
  afterQuarantine,afterRename}){
 if(await has(journalPath(path)))
   refuse('JOURNAL_ACTIVE','Restore journal already exists; recover it before starting another restore');
 await checkpoint(path,{allowMissing:true,allowUnreadable});
 await checkpoint(temp,{allowMissing:false});
 const id=quarantine.slice((path+'.quarantine.').length);
 if(!UUID.test(id))refuse('INVALID_QUARANTINE','Invalid quarantine identity');
 const ops=[];
 // WAL and SHM move first while the main DB is still present. They are
 // checkpointed (WAL size zero), so a crash never separates uncommitted data.
 for(const suffix of ['-wal','-shm',''])
  if(await has(path+suffix))ops.push({from:path+suffix,to:quarantine+suffix,state:'pending'});
 ops.push({from:temp,to:path,state:'pending'});
 const j={version:1,id,path,temp,quarantine,phase:'restoring',restoreOps:ops,abortOps:null};
 const marker=journalPath(path);
 await create(marker,j);
 if(afterJournalReady)await afterJournalReady();
 let ordinal=0;
 for(const op of ops){
  if(op.from===temp){
    if(afterQuarantine)await afterQuarantine();
  }
  await runOp(marker,j,op,++ordinal,afterRename);
 }
 await erase(marker);
 return {restored:true,databasePath:path,
   quarantinePath:ops.some(x=>x.to===quarantine)?quarantine:null,
   note:'Conserve la cuarentena como evidencia y verifique todos los recibos'};
}
const infer=async (j,op)=>{
 const from=await has(op.from),to=await has(op.to);
 if(op.state==='done')return true;
 // The install target can still hold the OLD live main DB while the
 // candidate is waiting in temp. This is not an ambiguous rename.
 if(op.from===j.temp){
   if(from)return false;
   if(to)return true;
   refuse('LOST_CANDIDATE','Both candidate and installed database are missing');
 }
 if(!from&&to)return true; // SIGKILL between rename and journal commit
 if(from&&!to)return false;
 refuse('AMBIGUOUS_RENAME','Cannot reconcile incomplete restore rename');
};
export async function abortRestoreMoves(path,{checkpoint,afterRename}={}){
 const marker=journalPath(path),j=await read(path);
 if(!j)refuse('NO_JOURNAL','No interrupted restore journal');
 if(j.phase==='restoring'){
  const moved=[];
  for(const op of j.restoreOps)moved.push(await infer(j,op));
  if(!moved.some(Boolean)){
   // A crash after creating the marker but before ANY rename must not
   // select old Q1 by mtime, and must leave the live database untouched.
   await erase(marker);return {aborted:true,databasePath:path,noMoves:true};
  }
  const qMain=moved.some((yes,i)=>yes&&j.restoreOps[i].from===path);
  if(qMain)await checkpoint(j.quarantine,{allowMissing:false});
  const ops=[];
  // Displace a partially installed candidate, if any.
  const installed=moved.some((yes,i)=>yes&&j.restoreOps[i].from===j.temp);
  if(installed)ops.push({from:path,to:path+'.aborted.'+j.id,state:'pending'});
  // Restore DB main first. WAL was checkpointed and is zero-sized; remount
  // sidecars only after main exists, never the other way around.
  for(const suffix of ['','-wal','-shm']){
   const wasMoved=moved.some((yes,i)=>yes&&j.restoreOps[i].from===path+suffix);
   if(wasMoved){
    const from=j.quarantine+suffix;
    if(await has(from))ops.push({from,to:path+suffix,state:'pending'});
    else if(suffix==='')refuse('LOST_DATABASE','Quarantine main database missing');
   }
  }
  if(!qMain&&installed){
   // Blind restore has no original DB; keep the security-fenced new DB
   // instead of discarding the only recoverable state.
   await erase(marker);return {aborted:false,recovered:true,databasePath:path};
  }
  j.abortOps=ops;j.phase='aborting';await stable(marker,j);
 }
 let ordinal=0;
 for(const op of j.abortOps??[])await runOp(marker,j,op,++ordinal,afterRename);
 await erase(marker);
 return {aborted:true,databasePath:path,
   displacedPath:(j.abortOps??[]).some(x=>x.to===path+'.aborted.'+j.id)?
     path+'.aborted.'+j.id:null};
}
export async function interruptedRestoreJournal(path){
 return await has(journalPath(path));
}
