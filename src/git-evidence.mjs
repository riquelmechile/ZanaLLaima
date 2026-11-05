import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants,closeSync,existsSync,fstatSync,lstatSync,mkdirSync,mkdtempSync,
  openSync,readFileSync,readdirSync,readlinkSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';

// RDD invariant: the candidate's object database is NOT a source of trees or
// blobs. One strictly isolated cat-file reads HEAD's commit; we hash its bytes
// in Node. Worktree bytes and Git tree framing are hashed only in Node.
// A second Git subprocess may read ignore patterns only against OUR private
// empty gitdir. Never use fsck, ls-tree, status, ls-files or git hash-object.
const SHA=/^[0-9a-f]{40}$/;
const deny=reason=>{throw new Error('Git candidate rejected: '+reason);};
const safeRef=ref=>typeof ref==='string'&&ref.startsWith('refs/heads/')&&
  /^[A-Za-z0-9_./-]{12,200}$/.test(ref)&&!ref.includes('..')&&
  !ref.endsWith('/')&&!ref.includes('//')&&!ref.includes('@{');
const gitEnv=()=>{
  const env={...process.env};
  for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete env[key];
  return {...env,GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_NOSYSTEM:'1',
    GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1',
    GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:'',
    GIT_TERMINAL_PROMPT:'0',GIT_ATTR_NOSYSTEM:'1'};
};
const safeArgs=['--no-replace-objects','-c','core.fsmonitor=false',
  '-c','core.untrackedCache=false','-c','core.hooksPath=/dev/null',
  '-c','core.sshCommand=false','-c','protocol.allow=never',
  '-c','core.excludesFile=/dev/null','-c','diff.external=false',
  '-c','core.pager=cat'];
const gitCall=(args,{env=gitEnv(),input,maxBuffer=8*1024*1024,allowNoMatch=false}={})=>{
  try{return execFileSync('git',[...safeArgs,...args],{
    env,input,stdio:['pipe','pipe','pipe'],timeout:10000,maxBuffer});
  }catch(error){
    if(allowNoMatch&&error?.status===1)return Buffer.alloc(0);
    deny('Git command failed safely: '+(args.at(-2)??args.at(-1)));
  }
};
const hash=(kind,bytes)=>{
  const body=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);
  return createHash('sha1').update(Buffer.from(kind+' '+body.length+'\0')).update(body).digest('hex');
};
const safePath=path=>typeof path==='string'&&path.length>0&&
  !isAbsolute(path)&&!path.includes('\\')&&
  !path.split('/').some(s=>!s||s==='.'||s==='..');
const readRequired=(path,label)=>{
  try{return readFileSync(path);}
  catch{deny('Missing or unreadable '+label);}
};
const asUtf8=(buf,label)=>{
  const value=buf.toString('utf8');
  if(!Buffer.from(value).equals(buf))deny('Non-UTF8 '+label+' is unsupported');
  return value;
};
const within=(outer,inner)=>inner===outer||inner.startsWith(outer+sep);
const gitDirFor=(root,parentGitDir)=>{
  const dot=join(root,'.git');
  let dir;
  try{
    const st=lstatSync(dot);
    if(st.isDirectory()&&!st.isSymbolicLink())dir=realpathSync(dot);
    else if(st.isFile()&&!st.isSymbolicLink()){
      const match=/^gitdir:\s*(.+?)\s*$/i.exec(readRequired(dot,'submodule gitdir').toString('utf8'));
      if(!match)deny('Invalid .git pointer');
      dir=realpathSync(resolve(root,match[1]));
    }else deny('Unsafe .git metadata');
  }catch(error){
    if(error?.message?.startsWith('Git candidate rejected:'))throw error;
    deny(parentGitDir
      ?'Submodule not initialized; inicializa con git submodule update --init'
      :'Repository .git metadata unavailable');
  }
  if(parentGitDir&&!within(parentGitDir,dir))
    deny('Submodule gitdir escapes its parent repository metadata');
  return dir;
};
const commonDirFor=gitDir=>{
  const pointer=join(gitDir,'commondir');
  return existsSync(pointer)?realpathSync(resolve(gitDir,
    readRequired(pointer,'commondir').toString('utf8').trim())):gitDir;
};
// Read config text WITHOUT asking Git to expand includes or invoke any
// configured helper. Reject unknown extensions and fetch-capable settings
// before the only object-reading subprocess (cat-file).
const validateConfig=gitDir=>{
  const common=commonDirFor(gitDir);
  const files=[join(common,'config'),join(gitDir,'config.worktree')];
  if(common!==gitDir)files.push(join(gitDir,'config'));
  for(const file of new Set(files)){
    if(!existsSync(file))continue;
    const config=asUtf8(readRequired(file,'Git config'),'Git config').split(/\r?\n/);
    let section='',subsection='';
    for(let line of config){
      line=line.trim();
      if(!line||line.startsWith('#')||line.startsWith(';'))continue;
      if(line.startsWith('[')){
        const m=/^\[\s*([-\w.]+)(?:\s+"([^"]+)")?\s*\](?:\s*[#;].*)?$/.exec(line);
        if(!m)deny('Unrecognized Git configuration section');
        section=m[1].toLowerCase();subsection=(m[2]??'').toLowerCase();
        if(section==='include'||section==='includeif')
          deny('Git config include/includeIf is not permitted for isolated observation');
        continue;
      }
      const m=/^([-\w.]+)(?:\s*=\s*(.*))?$/.exec(line);
      if(!m)deny('Unsupported Git configuration syntax');
      const key=m[1].toLowerCase(),value=(m[2]??'true').trim().replace(/^"(.*)"$/,'$1');
      if(section==='extensions'&&!['worktreeconfig'].includes(key))
        deny('Unsupported Git extension '+key);
      if(section==='extensions'&&key==='worktreeconfig'&&
          !['true','false','1','0'].includes(value.toLowerCase()))
        deny('Invalid worktreeConfig extension');
      if(section==='remote'&&['promisor','uploadpack'].includes(key))
        deny('Unsafe remote '+key+' configuration');
      if(section==='core'&&['sshcommand'].includes(key))
        deny('Unsafe Git command configuration');
      if(section==='protocol'&&key==='allow'&&value.toLowerCase()==='always')
        deny('Protocol override not permitted');
      if(section==='url'&&key.startsWith('insteadof'))
        deny('URL rewrite not permitted in isolated observation');
    }
  }
  return common;
};
const reference=(gitDir,common,ref)=>{
  if(!safeRef(ref))deny('Invalid branch reference');
  for(const base of new Set([gitDir,common])){
    const file=resolve(base,ref);
    if(!within(base,file))deny('Ref escapes Git metadata');
    if(existsSync(file)){
      const sha=readRequired(file,'Git ref').toString('utf8').trim();
      if(!SHA.test(sha))deny('Unsupported ref hash');
      return sha;
    }
  }
  const packed=join(common,'packed-refs');
  if(existsSync(packed)){
    const lines=readRequired(packed,'packed refs').toString('utf8').split(/\r?\n/);
    for(const line of lines){
      const m=/^([0-9a-f]{40}) (refs\/heads\/[^\s]+)$/.exec(line);
      if(m&&m[2]===ref)return m[1];
    }
  }
  deny('Target ref unavailable: '+ref);
};
const snapshot=(root,parentGitDir)=>{
  const gitDir=gitDirFor(root,parentGitDir),common=validateConfig(gitDir);
  const head=readRequired(join(gitDir,'HEAD'),'HEAD').toString('utf8').trim();
  const m=/^ref: (refs\/heads\/[A-Za-z0-9_.\/-]+)$/.exec(head);
  if(!m&&!(parentGitDir&&SHA.test(head)))deny('Detached or invalid local branch');
  if(m&&!safeRef(m[1]))deny('Detached or invalid local branch');
  // Submodule checkouts are normally detached at a gitlink SHA.
  const branch=m?m[1]:null,sha=m?reference(gitDir,common,branch):head;
  const commit=gitCall(['--git-dir='+gitDir,'--work-tree='+root,'cat-file','commit',sha],
    {maxBuffer:2*1024*1024});
  if(hash('commit',commit)!==sha)deny('Commit object hash mismatch; candidate object store is untrusted');
  const tree=/^tree ([0-9a-f]{40})\n/.exec(commit.toString('utf8'));
  if(!tree)deny('Commit missing valid Git tree ID');
  return {gitDir,common,branch,sha,treeSha:tree[1]};
};
// Index is merely an independent staged-change guard, never a source of HEAD
// tree content. We parse its bytes in Node to reject unmerged, sparse and
// assume-unchanged flags, and compare its tree hash with verified HEAD.
const readIndex=(gitDir,common)=>{
  const file=join(gitDir,'index');
  if(!existsSync(file))deny('Git index unavailable; sparse or incomplete checkout');
  const data=readRequired(file,'index');
  if(data.length<32||data.toString('ascii',0,4)!=='DIRC')deny('Invalid Git index header');
  const version=data.readUInt32BE(4),count=data.readUInt32BE(8);
  if(![2,3].includes(version))deny('Sparse checkout or unsupported Git index format');
  if(hashBytes(data.subarray(0,-20))!==data.subarray(-20).toString('hex'))
    deny('Git index checksum mismatch');
  const entries=new Map();let offset=12;
  for(let i=0;i<count;i++){
    const origin=offset;
    if(offset+62>data.length-20)deny('Truncated Git index');
    const mode=data.readUInt32BE(offset+24),sha=data.subarray(offset+40,offset+60).toString('hex');
    const flags=data.readUInt16BE(offset+60),extended=Boolean(flags&0x4000);
    const extra=extended?2:0;
    if((flags&0x8000)||(flags&0x3000)||extended)
      deny('Git index contains hidden/unsupported tracked-file flags or sparse checkout');
    const start=offset+62+extra,stop=data.indexOf(0,start);
    if(stop<0||stop>=data.length-20)deny('Missing Git index path terminator');
    const path=asUtf8(data.subarray(start,stop),'index path');
    if(!safePath(path)||entries.has(path))deny('Invalid or duplicate Git index path');
    const type=mode===0o100644?'100644':mode===0o100755?'100755':
      mode===0o120000?'120000':mode===0o160000?'160000':null;
    if(!type||!SHA.test(sha))deny('Unsupported Git index entry');
    entries.set(path,{mode:type,sha});
    offset=origin+Math.ceil((stop-origin+1)/8)*8;
  }
  return entries;
};
const hashBytes=bytes=>createHash('sha1').update(bytes).digest('hex');
const dirNode=()=>new Map();
function insertTree(root,path,mode,sha){
  if(!safePath(path))deny('Unsafe worktree path');
  const parts=path.split('/');let at=root;
  for(const name of parts.slice(0,-1)){
    if(!at.has(name))at.set(name,{dir:dirNode()});
    const child=at.get(name);
    if(!child.dir)deny('Git file/directory collision');
    at=child.dir;
  }
  const name=parts.at(-1);
  if(at.has(name))deny('Duplicate tree path');
  at.set(name,{mode,sha});
}
const serializeTree=tree=>{
  const items=[...tree].map(([name,item])=>({name,item,
    sort:Buffer.from(name+(item.dir?'/':''))}));
  items.sort((a,b)=>Buffer.compare(a.sort,b.sort));
  const parts=[];
  for(const {name,item} of items){
    const type=item.dir?'40000':item.mode;
    const oid=item.dir?serializeTree(item.dir):item.sha;
    if(!SHA.test(oid))deny('Invalid tree object ID');
    parts.push(Buffer.from(type+' '+name+'\0'),Buffer.from(oid,'hex'));
  }
  return hash('tree',Buffer.concat(parts));
};
const entryTree=entries=>{
  const tree=dirNode();
  for(const [path,entry] of entries)insertTree(tree,path,entry.mode,entry.sha);
  return serializeTree(tree);
};
const privateIgnoreDir=()=>{
  const root=mkdtempSync(join(tmpdir(),'zana-rdd-ignore-'));
  mkdirSync(join(root,'objects'));mkdirSync(join(root,'refs'));
  writeFileSync(join(root,'HEAD'),'ref: refs/heads/main\n',{mode:0o600});
  writeFileSync(join(root,'config'),'[core]\n\trepositoryformatversion = 0\n\tbare = false\n',{mode:0o600});
  return root;
};
const ignoredNames=(repo,gitdir,paths)=>{
  if(!paths.length)return new Set();
  const data=Buffer.from(paths.join('\0')+'\0');
  const out=gitCall(['--git-dir='+gitdir,'--work-tree='+repo,'check-ignore',
    '--no-index','--stdin','-z'],{input:data,maxBuffer:Math.max(data.length*2,1024*1024),
      allowNoMatch:true});
  return new Set(out.toString('utf8').split('\0').filter(Boolean));
};
const safeFile=(path,stat)=>{
  let fd;
  try{
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const current=fstatSync(fd);
    if(current.dev!==stat.dev||current.ino!==stat.ino||!current.isFile())
      deny('Tracked file changed during observation');
    return readFileSync(fd);
  }catch(error){
    if(error?.message?.startsWith('Git candidate rejected:'))throw error;
    deny('Unable to read worktree file without following symlink');
  }finally{if(fd!==undefined)closeSync(fd);}
};
const matchesDangerousAttributes=bytes=>/(?:^|\s)(?:filter\s*=|eol\s*=|(?:-?text)(?:\s|=|$)|ident(?:\s|=|$))/m
  .test(bytes.toString('utf8'));
function inspect(root,expectedSha,parentGitDir,depth=0){
  if(depth>16)deny('Git submodule nesting exceeds inspection limit');
  const committed=snapshot(root,parentGitDir);
  if(expectedSha&&committed.sha!==expectedSha)deny('Submodule HEAD differs from parent gitlink');
  const index=readIndex(committed.gitDir,committed.common);
  const stageSha=entryTree(index);
  const trackedDirs=new Set();
  for(const path of index.keys()){
    const pieces=path.split('/');
    for(let i=1;i<pieces.length;i++)trackedDirs.add(pieces.slice(0,i).join('/'));
  }
  const ignoreGit=privateIgnoreDir(),observed=new Map(),nestedDirty=[];
  try{
    const walk=(dir,prefix='')=>{
      let listing;
      try{listing=readdirSync(dir,{withFileTypes:true});}
      catch{deny('Unable to enumerate worktree directory');}
      // One isolated ignore-query per directory, not per file.
      const paths=listing.filter(e=>e.name!=='.git').map(e=>{
        const p=prefix?prefix+'/'+e.name:e.name;
        return p+(e.isDirectory()?'/':'');
      });
      const ignored=ignoredNames(root,ignoreGit,paths);
      for(const ent of listing){
        if(ent.name==='.git')continue; // metadata is excluded, never trusted
        const path=prefix?prefix+'/'+ent.name:ent.name;
        if(!safePath(path))deny('Unsafe path in worktree');
        const abs=join(root,path),st=lstatSync(abs),isDir=st.isDirectory();
        const tracked=index.has(path)||trackedDirs.has(path);
        if(!tracked&&ent.name!=='.gitignore'&&ignored.has(path+(isDir?'/':'')))continue;
        if(isDir){
          if(index.get(path)?.mode==='160000'){
            const nested=realpathSync(abs);
            if(nested!==abs||!within(root,nested))
              deny('Git submodule entry is not a real directory');
            const child=inspect(nested,index.get(path).sha,committed.common,depth+1);
            observed.set(path,{mode:'160000',sha:child.sha});
            if(!child.clean)nestedDirty.push({path,type:'submodule',detail:child.reason});
          }else walk(abs,path);
          continue;
        }
        if(st.isSymbolicLink()){
          observed.set(path,{mode:'120000',sha:hash('blob',readlinkSync(abs,{encoding:'buffer'}))});
          continue;
        }
        if(!st.isFile())deny('Unsupported non-regular worktree object: '+path);
        const body=safeFile(abs,st);
        if(ent.name==='.gitattributes'&&matchesDangerousAttributes(body))
          deny('Git attribute filter/text/eol/ident normalization unsupported at '+path);
        observed.set(path,{mode:(st.mode&0o100)?'100755':'100644',sha:hash('blob',body)});
      }
    };
    walk(root);
  }finally{rmSync(ignoreGit,{recursive:true,force:true});}
  for(const [path,entry] of index){
    if(entry.mode==='160000'&&!observed.has(path))
      deny('Submodule not initialized; inicializa con git submodule update --init: '+path);
  }
  const tree=entryTree(observed);
  let reason=null;
  const paths=[...new Set([...observed.keys(),...index.keys()])].sort();
  for(const path of paths){
    const a=observed.get(path),b=index.get(path);
    if(!a){reason={path,type:'missing'};break;}
    if(!b){reason={path,type:'extra'};break;}
    if(a.mode!==b.mode){reason={path,type:'mode'};break;}
    if(a.sha!==b.sha){reason={path,type:'content'};break;}
  }
  if(!reason&&nestedDirty.length)reason=nestedDirty[0];
  if(!reason&&stageSha!==committed.treeSha)
    reason={path:paths[0]??'.',type:'staged',detail:'Git index tree differs from the verified commit'};
  if(!reason&&tree!==committed.treeSha)
    reason={path:paths[0]??'.',type:'tree',detail:'Worktree tree differs from verified commit (index may be manipulated)'};
  return {...committed,clean:!reason,reason,computedTreeSha:tree};
}
export function observeGit({
  repoPath=process.env.ZANA_REVIEW_REPO||process.cwd(),
  targetRef=process.env.ZANA_REVIEW_TARGET_REF||'refs/heads/main'
}={}){
  if(!safeRef(targetRef))deny('Invalid target branch ref');
  let root;
  try{root=realpathSync(resolve(repoPath));}
  catch{deny('Repository path is not available');}
  const first=inspect(root,null,null);
  const baseSha=reference(first.gitDir,first.common,targetRef);
  return Object.freeze({assurance:'LOCAL_GIT_OBSERVED',repoRoot:root,
    candidateSha:first.sha,treeSha:first.treeSha,branchRef:first.branch,
    targetRef,baseSha,clean:first.clean,reason:first.reason,
    observedAt:new Date().toISOString()});
}
export function matchesReviewCandidate(review,observed){
  const frozen=review?.gitEvidence;
  if(!frozen||frozen.assurance!=='LOCAL_GIT_OBSERVED')return false;
  return observed?.clean===true&&frozen.clean===true&&
    frozen.repoRoot===observed.repoRoot&&
    frozen.candidateSha===observed.candidateSha&&
    frozen.treeSha===observed.treeSha&&
    frozen.branchRef===observed.branchRef&&
    frozen.targetRef===observed.targetRef&&
    frozen.baseSha===observed.baseSha&&
    review.candidateSha===observed.candidateSha;
}
