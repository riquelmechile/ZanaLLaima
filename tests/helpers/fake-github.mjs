// Local fakes for remote-mode tests: a GitHub REST API and a GitHub-like MCP
// server exposing the catalog tools with their real annotations. Nothing here
// reaches the network.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {McpServer,WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

export const AUTHOR_TOKEN='github_pat_'+'A'.repeat(40);
export const REVIEWER_TOKEN='ghp_'+'R'.repeat(36);
export const sha=c=>c.repeat(40);
const CATALOG=JSON.parse(readFileSync(new URL('../../data/github-mcp-tools.json',import.meta.url),'utf8'));

const listen=server=>new Promise(ok=>server.listen(0,'127.0.0.1',()=>ok('http://127.0.0.1:'+server.address().port)));
async function bodyOf(req){const parts=[];for await(const c of req)parts.push(c);return Buffer.concat(parts).toString('utf8');}

export async function fakeGitHubApi(){
  const state={repo:'o/r',defaultBranch:'main',branches:{main:sha('0')},pulls:[],checkRuns:{},statuses:{},
    reviews:{},commits:{},workflowRuns:{},runJobs:{},dispatches:[],merges:[],logs:{},comments:{},requests:[],
    failNext:null};
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://x');
    const body=req.method==='GET'?'':await bodyOf(req);
    const token=String(req.headers.authorization??'').replace(/^Bearer /,'');
    state.requests.push({method:req.method,path:url.pathname,search:url.search,token,body});
    const send=(status,data,type='application/json')=>{res.writeHead(status,{'content-type':type});
      res.end(typeof data==='string'?data:JSON.stringify(data));};
    if(state.failNext){const f=state.failNext;state.failNext=null;return send(f.status,{message:f.message});}
    const p=url.pathname.replace('/repos/o/r','');
    if(!url.pathname.startsWith('/repos/o/r'))return send(404,{message:'Not Found'});
    if(p===''&&req.method==='GET')return send(200,{full_name:'o/r',default_branch:state.defaultBranch});
    let m;
    if((m=/^\/branches\/(.+)$/.exec(p))){
      const b=decodeURIComponent(m[1]);
      return state.branches[b]?send(200,{name:b,commit:{sha:state.branches[b]}}):send(404,{message:'Branch not found'});
    }
    if(p==='/pulls'&&req.method==='GET'){
      const head=url.searchParams.get('head');
      return send(200,state.pulls.filter(x=>x.state==='open'&&(!head||'o:'+x.head.ref===head)));
    }
    if((m=/^\/compare\/(.+)\.\.\.([0-9a-f]{40})$/.exec(p)))
      return send(200,state.diffText??('diff --git a/x b/x\n+'+AUTHOR_TOKEN+'\n'),'text/plain');
    if((m=/^\/pulls\/comments\/(\d+)$/.exec(p)))return state.comments[m[1]]?send(200,state.comments[m[1]]):send(404,{message:'nf'});
    if((m=/^\/pulls\/(\d+)$/.exec(p))&&req.method==='GET'){
      const pull=state.pulls.find(x=>x.number===Number(m[1]));
      if(!pull)return send(404,{message:'nf'});
      const current={...pull,head:{...pull.head,sha:state.branches[pull.head.ref]??pull.head.sha}};
      if(String(req.headers.accept).includes('diff'))return send(200,state.diffText??('diff --git a/x b/x\n+'+AUTHOR_TOKEN+'\n'),'text/plain');
      return send(200,current);
    }
    if((m=/^\/pulls\/(\d+)\/commits$/.exec(p)))return send(200,state.commits[m[1]]??[]);
    if((m=/^\/pulls\/(\d+)\/reviews$/.exec(p))){
      if(req.method==='GET')return send(200,state.reviews[m[1]]??[]);
      const r=JSON.parse(body);const id=1000+(state.reviews[m[1]]??[]).length;
      const login=token===REVIEWER_TOKEN?'sebastianriquelme95-max':'riquelmechile';
      (state.reviews[m[1]]??=[]).push({id,user:{login},state:r.event==='APPROVE'?'APPROVED':'CHANGES_REQUESTED',
        commit_id:r.commit_id,body:r.body});
      return send(200,{id,html_url:'https://github.com/o/r/pull/'+m[1]+'#pullrequestreview-'+id});
    }
    if((m=/^\/pulls\/(\d+)\/merge$/.exec(p))){
      const pull=state.pulls.find(x=>x.number===Number(m[1]));
      const r=JSON.parse(body);
      state.merges.push({number:pull.number,...r,token});
      if(r.sha!==state.branches[pull.head.ref])return send(409,{message:'Head branch was modified. Review and try the merge again.'});
      pull.state='closed';pull.merged=true;pull.merge_commit_sha=sha('9');
      if(state.loseMergeResponse){state.loseMergeResponse=false;res.destroy();return;}
      return send(200,{merged:true,sha:sha('9'),message:'Pull Request successfully merged'});
    }
    if((m=/^\/commits\/([0-9a-f]{40})\/check-runs$/.exec(p)))
      return send(200,{total_count:(state.checkRuns[m[1]]??[]).length,check_runs:state.checkRuns[m[1]]??[]});
    if((m=/^\/commits\/([0-9a-f]{40})\/statuses$/.exec(p)))return send(200,state.statuses[m[1]]??[]);
    if((m=/^\/statuses\/([0-9a-f]{40})$/.exec(p))){
      const r=JSON.parse(body);
      const login=token===REVIEWER_TOKEN?'sebastianriquelme95-max':'riquelmechile';
      (state.statuses[m[1]]??=[]).unshift({...r,creator:{login}});
      return send(201,{id:1,...r});
    }
    if(p==='/actions/runs')return send(200,{workflow_runs:state.workflowRuns[url.searchParams.get('head_sha')]??[]});
    if((m=/^\/actions\/workflows\/([^/]+)\/dispatches$/.exec(p))){
      state.dispatches.push({workflow:decodeURIComponent(m[1]),...JSON.parse(body)});
      res.writeHead(204);return res.end();
    }
    if((m=/^\/actions\/runs\/(\d+)\/jobs$/.exec(p))){
      const jobs=state.runJobs[m[1]]??[];
      return send(200,{total_count:jobs.length,jobs});
    }
    if((m=/^\/actions\/jobs\/(\d+)\/logs$/.exec(p)))
      return state.logs[m[1]]?send(200,state.logs[m[1]],'text/plain'):send(404,{message:'nf'});
    return send(404,{message:'Not Found '+p});
  });
  const url=await listen(server);
  // Convenience mutators.
  state.push=(branch,commit)=>{state.branches[branch]=commit;};
  state.green=(commit,name='test')=>{(state.checkRuns[commit]??=[]).push({id:500+Object.keys(state.checkRuns).length,
    name,status:'completed',conclusion:'success',head_sha:commit,html_url:'https://github.com/o/r/runs/1'});};
  // A failed check run: its id is NOT the Actions job id (as on GitHub, where
  // the job is found from details_url or from the run's job list).
  // link: 'job' (details_url .../actions/runs/R/job/J), 'run' (only the run; the job is found by name), 'none'.
  state.red=(commit,jobId=77,name='test',link='job',runId=900)=>{
    const url=link==='job'?'https://github.com/o/r/actions/runs/'+runId+'/job/'+jobId:
      link==='run'?'https://github.com/o/r/actions/runs/'+runId:'https://example.invalid/checks/'+jobId;
    (state.checkRuns[commit]??=[]).push({id:jobId+50_000,name,status:'completed',
      conclusion:'failure',head_sha:commit,html_url:url,details_url:url});
    (state.runJobs[runId]??=[]).push({id:jobId,name,run_id:runId});
    state.logs[jobId]='line 1\n\x1b[31merror: expected 2 got 3\x1b[0m\ntoken '+AUTHOR_TOKEN+'\n';};
  state.openPull=(branch,number=7,base='main')=>{state.pulls.push({number,state:'open',draft:false,mergeable:true,
    mergeable_state:'clean',html_url:'https://github.com/o/r/pull/'+number,user:{login:'riquelmechile'},
    head:{ref:branch,sha:state.branches[branch],repo:{full_name:'o/r'}},base:{ref:base}});
    state.commits[number]=[{author:{login:'riquelmechile'},committer:{login:'web-flow'}}];};
  return {url,state,close:()=>new Promise(ok=>{server.closeAllConnections?.();server.close(ok);})};
}

// GitHub-like MCP server: every catalog tool (except the one outside the
// configured toolsets) with its real annotations, plus `extra` tools.
export async function fakeGitHubMcp({extra=[],echoToken=false,annotationsOverride={}}={}){
  const calls=[];
  const tools=Object.entries(CATALOG.tools).filter(([,t])=>t.toolset!=='issues').map(([name,t])=>({name,
    annotations:annotationsOverride[name]??{readOnlyHint:t.readOnlyHint,...(t.destructiveHint===null?{}:{destructiveHint:t.destructiveHint})}}));
  tools.push(...extra);
  const factory=()=>{
    const server=new McpServer({name:'fake-github',version:'2.1.0'});
    for(const t of tools)server.registerTool(t.name,{description:'fake '+t.name,inputSchema:z.looseObject({}),annotations:t.annotations},
      async(args,ctx)=>{
        calls.push({name:t.name,args,meta:ctx.mcpReq?._meta??null});
        return {content:[{type:'text',text:'ok '+t.name+(echoToken?' Authorization: Bearer '+AUTHOR_TOKEN:'')}]};
      });
    return server;
  };
  const headers=[];
  const http=createServer(async(req,res)=>{
    headers.push({authorization:req.headers.authorization,toolsets:req.headers['x-mcp-toolsets']});
    if(req.headers.authorization!=='Bearer '+AUTHOR_TOKEN){res.writeHead(401);res.end();return;}
    const raw=req.method==='POST'?await bodyOf(req):undefined;
    const request=new Request('http://127.0.0.1'+req.url,{method:req.method,headers:req.headers,...(raw?{body:raw}:{})});
    const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    await factory().connect(transport);
    const response=await transport.handleRequest(request);
    res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  const url=await listen(http);
  return {url:url+'/mcp',calls,headers,tools,close:()=>new Promise(ok=>{http.closeAllConnections?.();http.close(ok);})};
}
