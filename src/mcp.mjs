#!/usr/bin/env node
// Official MCP SDK v2. Local stdio only: no HTTP listener or model-provider calls.
import {readFileSync} from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { operations } from './actions.mjs';
import { capabilityContract } from './capabilities.mjs';

const packageVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
const s = () => z.string().min(1).max(500);
const uuid = () => z.string().min(8).max(128);
const object = z.record(z.string(),z.unknown());
const hostReport = z.object({
  model: z.string().max(100).optional(),
  reasoningEffort: z.string().max(40).optional(),
  nativeSubagents: z.object({
    available: z.boolean().optional(),
    maxConcurrent: z.number().int().min(0).max(256).optional(),
  }).strict().optional(),
}).strict();
const outcome = z.object({
  success: z.boolean(),
  summary: z.string().min(5).max(10000),
  evidence: z.array(z.string().min(1).max(2000)).min(1).max(20),
}).strict();
const result = z.object({
  verdict: z.enum(['PASS','CHANGES']),
  summary: z.string().min(1).max(10000),
  evidence: z.array(z.string().min(1).max(2000)).min(1).max(20),
  findings: z.array(z.object({
    severity:z.enum(['BLOCKER','CRITICAL','HIGH','MEDIUM','LOW']),
    description:z.string().min(1).max(2000),
    path:z.string().min(1).max(240).optional(),
  }).strict()).max(30).optional(),
  execution: z.enum(['SELF_CONTEXT','NATIVE_SUBAGENT']).optional(),
  contextId: z.string().min(1).max(200).optional(),
});
const pagination = {
  limit: z.number().int().min(1).max(100).optional(),
  before: z.number().int().positive().optional(),
};
const TOOL_DESCRIPTIONS = Object.freeze({
  zana_profile: ['profile','Show requested model settings without claiming they are active',true],
  zana_capability_status: ['capabilityStatus','Separate requested, host-reported and verified execution capabilities',true],
  zana_storage_status: ['storageStatus','Read local SQLite integrity and schema status',true],
  zana_storage_history: ['storageHistory','Read bounded state-event history',true],
  zana_storage_reviews: ['storageReviews','Read archived four-lens review history',true],
  zana_mission_init: ['init','Create one mission from a bounded specification',false],
  zana_mission_status: ['status','Inspect public mission status',true],
  zana_next_batch: ['next','Plan a safe batch without reserving work',true],
  zana_start_batch: ['start','Reserve work tokens transactionally',false],
  zana_complete_unit: ['complete','Record an outcome from an exact lease token',false],
  zana_apply_write: ['applyWrite','Execute an operator-approved WRITE via an anchored atomic local effect',false],
  zana_unit_heartbeat: ['heartbeat','Extend a live lease using its attempt generation',false],
  zana_recover_expired: ['recoverExpired','Mark expired reads and uncertain writes without replaying effects',false],
  zana_unit_retry: ['retry','Reset an explicitly eligible failed read to PENDING',false],
  zana_mission_cancel: ['cancel','Cancel work, preserving uncertainty of running writes',false],
  zana_mission_close: ['close','Close a mission only after every unit completed',false],
  zana_permission_status: ['authorizationStatus','Read effective signed operator grant status',true],
  zana_mission_history: ['missionHistory','Page through archived missions',true],
  zana_review_open: ['reviewOpen','Open a clean Git candidate-bound RDD review',false],
  zana_review_status: ['reviewStatus','Check candidate Git and persist invalidation if it drifted',false],
  zana_review_next: ['reviewNext','Check candidate Git and plan review lenses; may invalidate drifted state',false],
  zana_review_start: ['reviewStart','Reserve bounded lens packets',false],
  zana_review_submit: ['reviewSubmit','Record real lens evidence for an active packet',false],
  zana_review_check: ['reviewCheckCandidate','Recheck actual Git worktree and invalidate changed candidate',false],
});

const schemas = {
  zana_profile: z.object({}).strict(),
  zana_capability_status: z.object({hostReport:hostReport.optional()}).strict(),
  zana_storage_status: z.object({}).strict(),
  zana_storage_history: z.object({...pagination,category:z.string().max(64).optional()}).strict(),
  zana_storage_reviews: z.object({...pagination}).strict(),
  zana_mission_init: z.object({spec:object}).strict(),
  zana_mission_status: z.object({}).strict(),
  zana_next_batch: z.object({hostReport:hostReport.optional()}).strict(),
  zana_start_batch: z.object({hostReport:hostReport.optional(),
    leaseSeconds:z.number().int().min(5).max(3600).optional()}).strict(),
  zana_complete_unit: z.object({
    unitId:s(),token:uuid(),leaseGeneration:z.number().int().positive().optional(),outcome,
  }).strict(),
  zana_apply_write: z.object({
    unitId:s(),token:uuid(),leaseGeneration:z.number().int().positive(),
    path:z.string().min(1).max(240),
    content:z.string().max(65536).optional(),
    deleteFile:z.boolean().optional(),
    expectedPreSha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).strict().refine(v=>(v.deleteFile===true&&v.content===undefined)||
    (v.deleteFile!==true&&typeof v.content==='string'),
    'Provide UTF-8 content or deleteFile true, never both'),
  zana_unit_heartbeat: z.object({
    unitId:s(),token:uuid(),leaseGeneration:z.number().int().positive(),
    leaseSeconds:z.number().int().min(5).max(3600).optional(),
  }).strict(),
  zana_recover_expired: z.object({}).strict(),
  zana_unit_retry: z.object({unitId:s()}).strict(),
  zana_mission_cancel: z.object({}).strict(),
  zana_mission_close: z.object({}).strict(),
  zana_permission_status: z.object({}).strict(),
  zana_mission_history: z.object({...pagination}).strict(),
  zana_review_open: z.object({
    candidateSha:z.string().regex(/^[a-f0-9]{40}$/).optional(),
    hostReport:hostReport.optional(),risk:z.enum(['LOW','MEDIUM','HIGH']).optional(),
  }).strict(),
  zana_review_status: z.object({}).strict(),
  zana_review_next: z.object({hostReport:hostReport.optional()}).strict(),
  zana_review_start: z.object({hostReport:hostReport.optional()}).strict(),
  zana_review_submit: z.object({
    lensId:z.enum(['risk','reliability','resilience','readability']),
    token:uuid(),candidateSha:z.string().regex(/^[a-f0-9]{40}$/),
  }).extend(result.shape).strict(),
  zana_review_check: z.object({}).strict(),
};


function cancelledResult(duringExecution=false){
  return {isError:true,content:[{type:'text',
    text:duringExecution
      ?'Request cancelled during an operation. The effect may have committed; inspect persisted state before retrying.'
      :'Request cancelled before dispatch. No operation started.'}]};
}

// Separate the MCP transport from the operation so cancellation can be tested
// deterministically without needing a model or a socket.
export async function dispatchTool(action,args={}, {signal,implementation=operations}={}){
  if(signal?.aborted)return cancelledResult(false);
  try{
    const data=action==='capabilityStatus' ? capabilityContract(args.hostReport??{})
      :await implementation[action](args);
    if(signal?.aborted)return cancelledResult(true);
    return {content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};
  }catch(error){
    return {isError:true,content:[{type:'text',
      text:String(error?.message||'Operation failed').slice(0,2000)}]};
  }
}

export function createServer(){
  const server=new McpServer({name:'zana-llaima',version:packageVersion},
    {maxToolInputElements:1000});
  for(const [name,[action,description,readOnly]] of Object.entries(TOOL_DESCRIPTIONS)){
    server.registerTool(name,{
      description,
      inputSchema:schemas[name],
      annotations:{readOnlyHint:readOnly,destructiveHint:!readOnly,
        idempotentHint:readOnly},
    },async(args,ctx)=>{
      return dispatchTool(action,args,{signal:ctx.mcpReq.signal});
    });
  }
  return server;
}
if(process.argv[1] && import.meta.url===new URL('file://'+process.argv[1]).href){
  try {
    serveStdio(createServer);
  } catch (error) {
    console.error('MCP stdio startup failed:',String(error?.message||error));
    process.exitCode=1;
  }
}
