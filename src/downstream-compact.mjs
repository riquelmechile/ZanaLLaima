// Compact answers for successful GitHub downstream writes, so the chat shows
// what changed (paths, SHA, link) instead of the whole GitHub payload. Any
// shape this module does not recognise is returned untouched: nothing is
// dropped by guessing. Only commit.sha / object.sha count as a commit SHA, and
// only html_url as a link (a top-level sha or url may be a blob or an API URL). Reads and errors are never compacted.
const COMPACT_TOOLS=new Set(['create_or_update_file','push_files','delete_file','create_branch',
  'create_pull_request','update_pull_request']);

function payloadOf(result){
  const items=Array.isArray(result?.content)?result.content:[];
  if(items.length!==1||items[0]?.type!=='text'||typeof items[0].text!=='string')return null;
  try{
    const value=JSON.parse(items[0].text);
    return value&&typeof value==='object'&&!Array.isArray(value)?value:null;
  }catch{return null;}
}
const str=v=>typeof v==='string'&&v?v:null;
const shaOf=v=>typeof v==='string'&&/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(v)?v:null;

function summarize(tool,j,args){
  switch(tool){
    case 'create_or_update_file':case 'delete_file':{
      const commitSha=shaOf(j.commit?.sha);
      const htmlUrl=str(j.commit?.html_url)??str(j.content?.html_url);
      if(!commitSha&&!htmlUrl)return null;
      return {path:str(args.path)??str(j.content?.path),commitSha,htmlUrl,
        ...(tool==='create_or_update_file'?{contentSha:shaOf(j.content?.sha),
          bytes:typeof args.content==='string'?Buffer.byteLength(args.content,'utf8'):null}:{})};
    }
    case 'push_files':{
      const commitSha=shaOf(j.object?.sha)??shaOf(j.commit?.sha);
      if(!commitSha)return null;
      return {files:Array.isArray(args.files)?args.files.map(f=>str(f?.path)).filter(Boolean):[],commitSha,
        ref:str(j.ref),htmlUrl:str(j.commit?.html_url)??str(j.html_url)};
    }
    case 'create_branch':{
      const sha=shaOf(j.object?.sha);
      if(!sha)return null;
      return {branch:str(args.branch),ref:str(j.ref),sha};
    }
    default:{
      const number=Number.isInteger(j.number)?j.number:null;
      const htmlUrl=str(j.html_url);
      if(number===null&&!htmlUrl)return null;
      return {number,htmlUrl,headSha:shaOf(j.head?.sha)};
    }
  }
}

export function compactWrite(tool,args,result){
  if(!COMPACT_TOOLS.has(tool)||!result||result.isError)return result;
  const payload=payloadOf(result);
  if(!payload)return result;
  const summary=summarize(tool,payload,args&&typeof args==='object'?args:{});
  if(!summary)return result;
  const compact={ok:true,tool,...summary,compacted:true};
  return {content:[{type:'text',text:JSON.stringify(compact)}],structuredContent:compact};
}
