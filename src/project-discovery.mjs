// Contrato puro y sin efectos para Project Discovery. No acredita permisos,
// identidad de subagentes, consultas documentales ni consentimiento del usuario.
import {createHash} from 'node:crypto';

const MAX_TEXT=3000;
const FIELDS=Object.freeze([
  {key:'goal',question:'¿Qué problema debe resolver el proyecto y qué resultado esperas?',required:true},
  {key:'users',question:'¿Quién lo utilizará y qué necesita hacer?',required:true},
  {key:'platform',question:'¿Será web, móvil, escritorio, API u otro tipo de producto?',required:true},
  {key:'features',question:'¿Cuáles son las funcionalidades indispensables de la primera versión?',required:true},
  {key:'data',question:'¿Manejará datos personales, secretos o información sensible?',required:true},
  {key:'scale',question:'¿Qué escala, concurrencia o límites operativos debemos considerar?',required:false},
  {key:'integrations',question:'¿Con qué servicios o sistemas debe integrarse?',required:false},
  {key:'constraints',question:'¿Qué límites de costo, plazo, seguridad o tecnología debemos respetar?',required:false},
  {key:'deployment',question:'¿Tienes alguna preferencia de alojamiento o infraestructura?',required:false},
]);
const FIELD_MAP=new Map(FIELDS.map(x=>[x.key,x]));
const IDENTIFIER=/^[a-z][a-z0-9-]{0,47}$/;

function fail(code,message){
  const e=new Error(`${code}: ${message}`);e.code=code;throw e;
}
function plain(value,label){
  if(value===null||typeof value!=='object'||Array.isArray(value)||
    ![Object.prototype,null].includes(Object.getPrototypeOf(value)))
    fail('INVALID_OBJECT',label+' must be a plain object');
  return value;
}
function str(value,label,{min=1,max=MAX_TEXT}={}){
  if(typeof value!=='string'||value.trim().length<min||value.trim().length>max)
    fail('INVALID_TEXT',label+' must have '+min+'-'+max+' characters');
  return value.trim().normalize('NFC');
}
function exactKeys(value,allowed,label){
  const keys=Object.keys(plain(value,label));
  for(const key of keys)if(!allowed.includes(key))fail('UNKNOWN_FIELD',label+'.'+key);
}
function frozen(value){
  if(value&&typeof value==='object'){
    for(const child of Object.values(value))frozen(child);
    Object.freeze(value);
  }
  return value;
}

export const discoveryQuestions=()=>FIELDS.map(x=>({...x}));

export function startDiscovery(idea){
  return frozen({schema:'zana.discovery.v1',idea:str(idea,'idea',{min:12,max:2000}),
    answers:{},revision:0,status:'COLLECTING'});
}

export function answerDiscovery(brief,answers){
  checkBrief(brief);
  // Un brief listo puede revisarse antes de que exista una aprobación autenticada.
  exactKeys(answers,[...FIELD_MAP.keys()],'answers');
  if(Object.keys(answers).length===0)fail('EMPTY_ANSWERS','At least one answer is required');
  const normalized={...brief.answers};
  for(const [key,value] of Object.entries(answers))normalized[key]=str(value,key,{max:2000});
  const complete=FIELDS.filter(x=>x.required).every(x=>normalized[x.key]);
  return frozen({schema:brief.schema,idea:brief.idea,answers:normalized,
    revision:brief.revision+1,status:complete?'READY_FOR_PLAN':'COLLECTING'});
}

export function nextDiscoveryQuestions(brief,{limit=3,includeOptional=false}={}){
  checkBrief(brief);
  if(!Number.isInteger(limit)||limit<1||limit>5)fail('INVALID_LIMIT','limit must be 1-5');
  return FIELDS.filter(x=>(x.required||includeOptional)&&!brief.answers[x.key])
    .slice(0,limit).map(x=>({...x}));
}

export function checkBrief(brief){
  exactKeys(brief,['schema','idea','answers','revision','status'],'brief');
  if(brief.schema!=='zana.discovery.v1')fail('INVALID_SCHEMA','Unsupported discovery schema');
  str(brief.idea,'idea',{min:12,max:2000});
  exactKeys(brief.answers,[...FIELD_MAP.keys()],'brief.answers');
  for(const [key,value] of Object.entries(brief.answers))str(value,key,{max:2000});
  if(!Number.isSafeInteger(brief.revision)||brief.revision<0)
    fail('INVALID_REVISION','revision must be a nonnegative integer');
  const complete=FIELDS.filter(x=>x.required).every(x=>brief.answers[x.key]);
  if(brief.status!==(complete?'READY_FOR_PLAN':'COLLECTING'))
    fail('INVALID_STATE','brief status does not match required answers');
  return true;
}

function source(value){
  exactKeys(value,['title','url','checkedOn'],'source');
  const url=str(value.url,'source.url',{max:1000});
  let parsed;
  try{parsed=new URL(url)}catch{fail('INVALID_SOURCE','Source must have a valid URL')}
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||!parsed.hostname||parsed.hash)
    fail('INVALID_SOURCE','Only public HTTPS URLs without credentials or fragments are accepted');
  const checkedOn=str(value.checkedOn,'source.checkedOn',{min:10,max:10});
  if(!/^\d{4}-\d\d-\d\d$/.test(checkedOn)||
    Number.isNaN(Date.parse(checkedOn+'T00:00:00Z'))||
    new Date(checkedOn+'T00:00:00Z').toISOString().slice(0,10)!==checkedOn)
    fail('INVALID_DATE','Source verification date must be a real YYYY-MM-DD');
  return {title:str(value.title,'source.title',{max:160}),url:parsed.href,checkedOn};
}
function option(value){
  exactKeys(value,['id','technology','rationale','benefits','tradeoffs','sources'],'option');
  const id=str(value.id,'option.id',{max:48});
  if(!IDENTIFIER.test(id))fail('INVALID_ID','Option ids must be lowercase kebab-case');
  if(!Array.isArray(value.sources)||value.sources.length===0||value.sources.length>12)
    fail('MISSING_EVIDENCE','Every alternative needs at least one source');
  return {id,technology:str(value.technology,'technology',{max:180}),
    rationale:str(value.rationale,'rationale',{max:1000}),
    benefits:str(value.benefits,'benefits',{max:1000}),
    tradeoffs:str(value.tradeoffs,'tradeoffs',{max:1000}),
    sources:value.sources.map(source)};
}
function milestones(raw){
  if(!Array.isArray(raw)||raw.length===0||raw.length>40)
    fail('INVALID_MILESTONES','Provide 1-40 milestones');
  const result=raw.map(m=>{
    exactKeys(m,['id','objective','acceptance','dependsOn'],'milestone');
    const id=str(m.id,'milestone.id',{max:48});
    if(!IDENTIFIER.test(id))fail('INVALID_ID','Milestone ids must be lowercase kebab-case');
    if(!Array.isArray(m.dependsOn)||m.dependsOn.length>20||
      m.dependsOn.some(d=>typeof d!=='string'||!IDENTIFIER.test(d)))
      fail('INVALID_DEPENDENCIES','dependsOn must contain milestone ids');
    return {id,objective:str(m.objective,'objective',{max:1000}),
      acceptance:str(m.acceptance,'acceptance',{max:1000}),dependsOn:[...m.dependsOn]};
  });
  const ids=new Set(result.map(x=>x.id));
  if(ids.size!==result.length)fail('DUPLICATE_ID','Milestone ids must be unique');
  for(const m of result){
    if(new Set(m.dependsOn).size!==m.dependsOn.length||m.dependsOn.some(d=>!ids.has(d)||d===m.id))
      fail('INVALID_DEPENDENCIES','Unknown, duplicate or self-dependency');
  }
  const map=new Map(result.map(m=>[m.id,m]));
  const visited=new Set(),visiting=new Set();
  function visit(id){
    if(visiting.has(id))fail('CYCLIC_DEPENDENCY','Milestone graph has a cycle');
    if(visited.has(id))return;
    visiting.add(id);for(const dep of map.get(id).dependsOn)visit(dep);
    visiting.delete(id);visited.add(id);
  }
  for(const m of result)visit(m.id);
  return result;
}

export function draftProjectPlan({brief,alternatives,selectedId,milestones:steps}){
  checkBrief(brief);
  if(brief.status!=='READY_FOR_PLAN')fail('DISCOVERY_INCOMPLETE','Required questions remain');
  if(!Array.isArray(alternatives)||alternatives.length<2||alternatives.length>12)
    fail('INVALID_ALTERNATIVES','Compare 2-12 technical alternatives');
  const options=alternatives.map(option),ids=new Set(options.map(x=>x.id));
  if(ids.size!==options.length)fail('DUPLICATE_ID','Alternative ids must be unique');
  if(!ids.has(selectedId))fail('INVALID_SELECTION','Select a documented alternative');
  const payload={schema:'zana.project-plan.v1',brief:{idea:brief.idea,answers:Object.fromEntries(FIELDS.filter(f=>brief.answers[f.key]).map(f=>[f.key,brief.answers[f.key]])),revision:brief.revision},
    alternatives:options,selectedId,milestones:milestones(steps)};
  const digest=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  // A draft is NOT permission to create a repository, merge or deploy.
  return frozen({...payload,digest,approval:'PENDING_AUTHENTICATED_USER'});
}
