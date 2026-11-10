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

// ChatGPT trata un recurso embebido (lo que devuelve get_file_contents del
// GitHub MCP) y un enlace a recurso como archivos adjuntos, y le pide al
// usuario aprobación para materializarlos en cada lectura. Un recurso de texto
// se entrega como texto: una línea con su origen y luego el contenido exacto.
// Un binario no se puede dar como texto y queda como llegó; cualquier forma
// que no se reconoce también.
const origin=(label,r)=>label+' '+String(r.uri??'')+(typeof r.mimeType==='string'&&r.mimeType?' ('+r.mimeType+')':'');
export function inlineResources(result){
  if(!result||!Array.isArray(result.content))return result;
  let changed=false;
  const content=result.content.flatMap(item=>{
    if(item?.type==='resource_link'&&typeof item.uri==='string'){
      changed=true;
      return [{type:'text',text:origin('resource link',item)+(typeof item.name==='string'?' '+item.name:'')}];
    }
    const r=item?.type==='resource'?item.resource:null;
    if(!r||typeof r!=='object'||typeof r.text!=='string'||r.blob!==undefined)return [item];
    changed=true;
    return [{type:'text',text:origin('resource',r)},{type:'text',text:r.text}];
  });
  return changed?{...result,content}:result;
}
