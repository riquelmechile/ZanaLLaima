import {constants} from 'node:fs';
import {open, lstat, realpath, rename, unlink} from 'node:fs/promises';
import {resolve, isAbsolute, sep} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

const dirFlags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;
const readFlags=constants.O_RDONLY|constants.O_NOFOLLOW;
const writeFlags=constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW;
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
const fail=message=>{throw Error('Write effect boundary: '+message);};
const inside=(root,value)=>value===root||value.startsWith(root+sep);

export function validateRelativePath(path){
  if(typeof path!=='string'||!path||path.length>240||
      path.startsWith('/')||path.includes('\\')||path.includes('\0')||
      path.split('/').some(x=>!x||x==='.'||x==='..'||x==='~'))
    fail('Unsafe relative path');
  return path.split('/');
}

export function validateWriteRequest({path,content,deleteFile,expectedPreSha256},limit){
  validateRelativePath(path);
  if(deleteFile===true){
    if(content!==undefined)fail('deleteFile cannot include content');
  }else if(deleteFile===undefined||deleteFile===false){
    if(typeof content!=='string')fail('content must be UTF-8 text');
    if(Buffer.byteLength(content,'utf8')>limit)fail('Content exceeds mission byte budget');
  }else fail('Invalid deleteFile flag');
  if(expectedPreSha256!==undefined &&
    !(typeof expectedPreSha256==='string'&&/^[a-f0-9]{64}$/.test(expectedPreSha256)))
    fail('Invalid expectedPreSha256');
  return {path,operation:deleteFile===true?'DELETE':'REPLACE',
    bytes:deleteFile===true?0:Buffer.byteLength(content,'utf8'),
    expectedPreSha256:expectedPreSha256??null};
}

export async function workspaceRoot(root=process.env.ZANA_WORKSPACE_ROOT){
  if(typeof root!=='string'||!isAbsolute(root))fail('Absolute workspace root required');
  if(process.platform!=='linux')fail('Anchored directory descriptors require Linux /proc/self/fd');
  const path=resolve(root),actual=await realpath(path);
  if(path!==actual)fail('Workspace root cannot be a symlink');
  return path;
}

const fdPath=(parent,name='')=>'/proc/self/fd/'+parent.fd+(name?'/'+name:'');
const id=stat=>[String(stat.dev),String(stat.ino)];
const sameId=(a,b)=>a?.[0]===b?.[0]&&a?.[1]===b?.[1];

async function traverse(root,relative,{anchors={}}={}){
  const parts=validateRelativePath(relative);
  const openHandles=[];
  try{
    const base=await open(root,dirFlags);
    openHandles.push(base);
    const baseId=id(await base.stat());
    if(anchors['']&&!sameId(anchors[''],baseId))fail('Workspace root changed after reservation');
    let current=base,at='';
    for(const segment of parts.slice(0,-1)){
      at=at?at+'/'+segment:segment;
      const child=await open(fdPath(current,segment),dirFlags);
      openHandles.push(child);
      const meta=await child.stat();
      if(!meta.isDirectory())fail('Non-directory path component');
      if(anchors[at]&&!sameId(anchors[at],id(meta)))
        fail('Directory inode changed after reservation: '+at);
      current=child;
    }
    const parentLocation=await realpath(fdPath(current));
    if(!inside(root,parentLocation))fail('Parent was relocated outside the workspace');
    return {parts,current,openHandles,baseId,parentLocation};
  }catch(e){
    await Promise.all(openHandles.reverse().map(h=>h.close().catch(()=>{})));
    throw e;
  }
}

export async function capturePathAnchors(paths,root=process.env.ZANA_WORKSPACE_ROOT){
  const home=await workspaceRoot(root);
  const handles=[];
  const anchors={};
  try{
    const base=await open(home,dirFlags);
    handles.push(base);anchors['']=id(await base.stat());
    for(const scope of paths){
      const parts=validateRelativePath(scope);
      let parent=base,at='';
      const scoped=[];
      for(const part of parts){
        at=at?at+'/'+part:part;
        let child;
        try{child=await open(fdPath(parent,part),dirFlags);}
        catch(error){
          if(error.code==='ENOENT')break;
          if(error.code==='ELOOP')fail('Symlink in reservation path');
          if(error.code==='ENOTDIR'){
            const meta=await lstat(fdPath(parent,part));
            if(meta.isSymbolicLink())fail('Symlink in reservation path');
            if(meta.isFile())break; // A scope may name one regular file.
            fail('Invalid non-directory reservation component');
          }
          throw error;
        }
        scoped.push(child);anchors[at]=id(await child.stat());parent=child;
      }
      handles.push(...scoped);
    }
    return {workspaceRoot:home,anchors};
  }finally{
    await Promise.all(handles.reverse().map(h=>h.close().catch(()=>{})));
  }
}

async function inspectTarget(parent,baseName){
  const target=fdPath(parent,baseName);
  let stat;
  try{stat=await lstat(target);}
  catch(e){if(e.code==='ENOENT')return {exists:false,hash:null,bytes:0};throw e;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)
    fail('Destination is symlink, hardlink, or non-regular file');
  const handle=await open(target,readFlags);
  try{
    const actual=await handle.stat();
    if(!actual.isFile()||actual.nlink!==1||!sameId(id(actual),id(stat)))
      fail('Destination changed during inspection');
    if(actual.size>32*1024*1024)fail('Existing file exceeds 32 MiB inspection limit');
    const contents=await handle.readFile();
    return {exists:true,hash:hash(contents),bytes:contents.length};
  }finally{await handle.close();}
}

export async function inspectPreimage({path,root=process.env.ZANA_WORKSPACE_ROOT,anchors={}}){
  const home=await workspaceRoot(root);
  const fd=await traverse(home,path,{anchors});
  try{return await inspectTarget(fd.current,fd.parts.at(-1));}
  finally{await Promise.all(fd.openHandles.reverse().map(h=>h.close().catch(()=>{})));}
}

export async function atomicWorkspaceEffect({path,content,deleteFile=false,expectedPreSha256,
  root=process.env.ZANA_WORKSPACE_ROOT,anchors={},beforeEffect=()=>{}}){
  const home=await workspaceRoot(root);
  const fd=await traverse(home,path,{anchors});
  let temp=null;
  try{
    const basename=fd.parts.at(-1);
    const pre=await inspectTarget(fd.current,basename);
    if(expectedPreSha256!==undefined&&pre.hash!==expectedPreSha256)
      fail('expectedPreSha256 differs from observed file');
    if(deleteFile&&!pre.exists)fail('Cannot delete absent file');
    const target=fdPath(fd.current,basename);
    let postHash=null,bytes=0;
    if(deleteFile){
      await beforeEffect();
      // unlinkat equivalent over an anchored procfd. Directory fd stays open.
      await unlink(target);
    }else{
      const buffer=Buffer.from(content,'utf8');
      bytes=buffer.length;postHash=hash(buffer);
      temp='.zana-effect-'+randomUUID();
      const writer=await open(fdPath(fd.current,temp),writeFlags,0o600);
      try{
        await writer.writeFile(buffer);
        await writer.sync();
      }finally{await writer.close();}
      // Re-validate before replacement. rename() never follows a destination
      // symlink; it replaces the directory entry itself.
      const recheck=await inspectTarget(fd.current,basename);
      if(recheck.hash!==pre.hash||recheck.exists!==pre.exists)
        fail('Target preimage changed before rename');
      if(!inside(home,await realpath(fdPath(fd.current))))
        fail('Directory moved outside workspace before rename');
      await beforeEffect();
      await rename(fdPath(fd.current,temp),target);
      temp=null;
    }
    await fd.current.sync();
    return {preSha256:pre.hash,postSha256:postHash,bytes,
      appliedAt:new Date().toISOString(),operation:deleteFile?'DELETE':'REPLACE',
      assurance:'LINUX_ANCHORED_ATOMIC_EFFECT_NO_OS_SANDBOX'};
  }finally{
    if(temp)await unlink(fdPath(fd.current,temp)).catch(()=>{});
    await Promise.all(fd.openHandles.reverse().map(h=>h.close().catch(()=>{})));
  }
}
