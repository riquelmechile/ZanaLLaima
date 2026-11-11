// Esqueleto para el commit rojo: las pruebas deben fallar por aserción.
const pending=()=>{throw new Error('NOT_IMPLEMENTED: eventos MCP pendientes');};
export const REVIEW_EVENT='zana.review.ready';
export const publicIp=()=>false,validCallback=pending,webhookHeaders=pending,listEvents=()=>({events:[]}),
  subscribeEvent=async()=>pending(),unsubscribeEvent=pending,queueEvent=pending,flushEvents=async()=>pending(),
  eventStatus=pending,dropClientEvents=pending;
