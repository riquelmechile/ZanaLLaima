import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

const deny=reason=>{throw new Error('Write boundary rejected: '+reason);};
// Shared lexical policy for mission paths, signed grants and applied effects.
export function validateRelativePath(path){
  if(typeof path!=='string'||!path||path.length>240||
    path.startsWith('/')||path.includes('\\')||path.includes('\0')||
    path.split('/').some(x=>!x||x==='.'||x==='..'||x==='~'||
      ['.git','.zana'].includes(x.normalize('NFKC').toLowerCase().replace(/[. ]+$/u,''))))
    throw new Error('Unsafe path: invalid relative path');
  return path.split('/');
}
export function inScope(path,roots){
  try{validateRelativePath(path);}
  catch{return false;}
  return Array.isArray(roots)&&roots.some(root=>{
    try{validateRelativePath(root);}
    catch{return false;}
    return path===root||path.startsWith(root+'/');
  });
}

// The state database and its WAL must not be writable through the effect root.
export function assertWorkspaceRootIsolated(home){
  const state=resolve(process.env.ZANA_STATE_FILE||'.zana/state.json');
  const database=state.replace(/\.json$/i,'.sqlite');
  for(const target of [state,database,database+'-wal',database+'-shm']){
    if(target===home||target.startsWith(home+sep))
      deny('Workspace root contains the Zana state database');
  }
}
export async function verifyWorkspacePaths(paths,root=process.env.ZANA_WORKSPACE_ROOT){
  if(typeof root!=='string'||!isAbsolute(root))deny('Absolute operator workspace root not configured');
  const home=await realpath(root);
  if(home!==resolve(root))deny('Workspace root cannot be a symbolic link');
  assertWorkspaceRootIsolated(home);
  if(!Array.isArray(paths)||!paths.length)deny('No authorized paths');
  for(const path of paths){
    validateRelativePath(path);
    const target=resolve(home,path);
    if(target!==home&&!target.startsWith(home+sep))deny('Path escapes workspace');
    const pieces=path.split('/');
    let parent=home;
    for(const part of pieces){
      parent=join(parent,part);
      try{
        const st=await lstat(parent);
        if(st.isSymbolicLink())deny('Symlink traversal forbidden');
      }catch(error){
        if(error.code==='ENOENT')break;
        throw error;
      }
    }
  }
  return {scopeVerified:true,workspaceRoot:home,
    assurance:'PATH_INSPECTED_NOT_ATOMIC_WRITE_ENFORCEMENT'};
}
