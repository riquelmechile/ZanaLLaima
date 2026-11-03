import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

const deny=reason=>{throw new Error('Write boundary rejected: '+reason);};
export async function verifyWorkspacePaths(paths,root=process.env.ZANA_WORKSPACE_ROOT){
  if(typeof root!=='string'||!isAbsolute(root))deny('Absolute operator workspace root not configured');
  const home=await realpath(root);
  if(home!==resolve(root))deny('Workspace root cannot be a symbolic link');
  if(!Array.isArray(paths)||!paths.length)deny('No authorized paths');
  for(const path of paths){
    if(typeof path!=='string'||!path||path.startsWith('/')||path.includes('\\')||
       path.split('/').some(s=>!s||s==='.'||s==='..'))deny('Unsafe path');
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
