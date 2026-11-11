// Configuración de CI por repositorio. El operador la define en el servidor;
// ni la misión ni el modelo pueden modificarla mediante una tool MCP.
const WORKFLOW=/^[A-Za-z0-9._-]{1,100}\.ya?ml$/;
const REPO=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const plain=o=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&
  [Object.prototype,null].includes(Object.getPrototypeOf(o));
const fail=m=>{throw new Error('INVALID_REPO_CHECKS: '+m);};

export function parseRepoChecks(raw,allowedRepos=[]){
  const result=Object.create(null);
  if(raw===undefined||raw===null||raw==='')return Object.freeze(result);
  if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>16000)
    fail('configuración demasiado grande o tipo inválido');
  let data;
  try{data=JSON.parse(raw);}catch{fail('JSON mal formado');}
  if(!plain(data)||Object.keys(data).length>100)fail('se requiere un objeto acotado');
  const allowed=new Set(allowedRepos.map(r=>String(r).toLowerCase()));
  for(const [repo,entry] of Object.entries(data)){
    const name=repo.toLowerCase();
    if(!REPO.test(repo)||repo.split('/').some(s=>s==='.'||s==='..')||
      !allowed.has(name)||Object.hasOwn(result,name))
      fail('repositorio desconocido o duplicado: '+repo);
    if(!plain(entry)||Object.keys(entry).sort().join(',')!=='requiredChecks,workflow'||
      typeof entry.workflow!=='string'||!WORKFLOW.test(entry.workflow))
      fail('workflow o campos inválidos para '+repo);
    const checks=entry.requiredChecks;
    if(!Array.isArray(checks)||checks.length<1||checks.length>20||
      checks.some(n=>typeof n!=='string'||!n||n.length>120||n!==n.trim()||/[\x00-\x1f\x7f]/.test(n))||
      new Set(checks).size!==checks.length)fail('checks requeridos inválidos para '+repo);
    result[name]=Object.freeze({workflow:entry.workflow,requiredChecks:Object.freeze([...checks])});
  }
  return Object.freeze(result);
}

export function checksForRepo(config,repo){
  return config.repoChecks?.[String(repo).toLowerCase()]??
    {workflow:config.checksWorkflow,requiredChecks:config.requiredChecks};
}
