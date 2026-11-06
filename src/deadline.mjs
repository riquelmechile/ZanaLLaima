// Time budgets for remote tools. A tool has a total deadline; steps that do
// not fit in what is left are skipped (or cut) and reported as partial, so a
// slow GitHub never turns into a hung tool call.
export const TOOL_DEADLINE_MS=45_000;
export const LOG_BUDGET_MS=10_000;

export class DeadlineError extends Error{
  constructor(label,ms){super('DEADLINE: '+label+' exceeded '+ms+' ms');this.code='DEADLINE';}
}
export function within(promise,ms,label){
  let timer;
  return Promise.race([promise,new Promise((_,no)=>{timer=setTimeout(()=>no(new DeadlineError(label,ms)),Math.max(0,ms));})])
    .finally(()=>clearTimeout(timer));
}
export function createDeadline(totalMs=TOOL_DEADLINE_MS,now=Date.now){
  const end=now()+totalMs;
  const partial=[];
  return {
    partial,
    remaining:()=>Math.max(0,end-now()),
    // Run one step within min(left, cap). On timeout record it and return fallback.
    async step(fn,label,{cap=Infinity,fallback}={}){
      const left=Math.min(cap,Math.max(0,end-now()));
      if(left<=0){partial.push(label);return fallback;}
      try{return await within(Promise.resolve().then(fn),left,label);}
      catch(error){
        if(error instanceof DeadlineError){partial.push(label);return fallback;}
        throw error;
      }
    },
  };
}
