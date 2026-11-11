// Gate de proyecto. GitHub es la fuente de verdad; nunca ejecuta merge ni deploy.
const SHA=/^[0-9a-f]{40}$/;
const fail=(c,m)=>{const e=new Error(c+': '+m);e.code=c;throw e;};
const isObj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);

export async function assessProjectDelivery(run,{repo,expectedSha},verifyGitHub){
  if(run?.schema!=='zana.project-run.v1'||run.status!=='READY_TO_DELIVER'||
    !Array.isArray(run.milestones)||!run.milestones.length||
    run.milestones.some(m=>m.status!=='DONE'))fail('PROJECT_INCOMPLETE','Hitos sin completar');
  if(typeof repo!=='string'||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)||!SHA.test(expectedSha))
    fail('INVALID_DELIVERY_TARGET','Repositorio o SHA inválido');
  const milestoneHeads=run.milestones.map(m=>({id:m.id,sha:m.headSha}));
  if(milestoneHeads.some(m=>typeof m.id!=='string'||!SHA.test(m.sha))||
    new Set(milestoneHeads.map(m=>m.id)).size!==milestoneHeads.length)
    fail('INVALID_DELIVERY_MILESTONES','Hitos sin SHA final verificable o IDs duplicados');
  if(typeof verifyGitHub!=='function')fail('VERIFIER_REQUIRED','Falta el verificador de GitHub');
  // El SHA de integración no tiene por qué ser el del último hito del arreglo.
  // El callback autenticado debe comprobar que TODOS los hitos están contenidos
  // en la revisión integrada del repo, además del CI y 4R del SHA objetivo.
  // GitHub devuelve mergeable:null después del merge: nunca exigirlo junto a merged:true.
  const proof=await verifyGitHub({repo,sha:expectedSha,projectId:run.projectId,
    planDigest:run.planDigest,milestoneHeads});
  if(!isObj(proof)||proof.sha!==expectedSha||proof.ci!=='SUCCESS'||
    proof.review!=='APPROVED'||proof.merged!==true||proof.integrationVerified!==true)
    fail('DELIVERY_NOT_READY','GitHub no acredita integración de todos los hitos, CI y 4R del SHA de entrega');
  return Object.freeze({schema:'zana.delivery.v1',state:'READY_FOR_OPERATOR',
    projectId:run.projectId,repo,sha:expectedSha,planDigest:run.planDigest,
    documentationRequired:true,deploymentAuthorized:false,source:'VERIFIED_BACKEND'});
}

// La decisión humana se verifica por el backend contra objetivo y SHA.
// Esta función no es una ejecución de despliegue, sólo entrega una autorización
// que un ejecutor externo debe revalidar antes de cualquier efecto.
export async function authorizeProjectDelivery(ticket,{target,kind='deployment'},verifyOperator){
  if(ticket?.schema!=='zana.delivery.v1'||ticket.state!=='READY_FOR_OPERATOR'||
    ticket.source!=='VERIFIED_BACKEND'||!SHA.test(ticket.sha))
    fail('INVALID_DELIVERY_TICKET','Ticket de entrega inválido');
  if(typeof target!=='string'||target.length<3||target.length>200||
    !/^[A-Za-z0-9._/-]+$/.test(target)||!['deployment','release'].includes(kind))
    fail('INVALID_TARGET','Destino o tipo de operación inválidos');
  if(typeof verifyOperator!=='function')fail('VERIFIER_REQUIRED','Validación de operador obligatoria');
  const authorized=await verifyOperator({projectId:ticket.projectId,repo:ticket.repo,
    sha:ticket.sha,planDigest:ticket.planDigest,target,kind});
  if(authorized!==true)fail('OPERATOR_APPROVAL_REQUIRED','No hay autorización exacta del operador');
  return Object.freeze({kind,target,sha:ticket.sha,projectId:ticket.projectId,
    state:'AUTHORIZED_NOT_EXECUTED',mustReverifyBeforeEffect:true});
}
