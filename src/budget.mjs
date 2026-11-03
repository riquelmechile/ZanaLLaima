// Hard upper bounds are global. A mission may choose stricter limits, never larger.
export const DEFAULT_BUDGET=Object.freeze({
  maxActiveReads:4,
  maxUnitAttempts:3,
  maxWorkStarts:300,
  maxLeaseSeconds:300,
  maxResultBytes:16384,
  maxReviewRounds:5,
  maxMissionSeconds:86400,
});
const RANGES=Object.freeze({
  maxActiveReads:[1,4],
  maxUnitAttempts:[1,3],
  maxWorkStarts:[1,300],
  maxLeaseSeconds:[5,3600],
  maxResultBytes:[1024,65536],
  maxReviewRounds:[1,5],
  maxMissionSeconds:[60,604800],
});
const reject=message=>{throw new Error('Mission resource budget: '+message);};

export function createBudget(options={},createdAt=Date.now(),totalUnits=1){
  if(!options||typeof options!=='object'||Array.isArray(options))
    reject('budget must be an object');
  for(const key of Object.keys(options))
    if(!(key in RANGES))reject('unknown limit '+key);
  const budget={};
  for(const [key,[min,max]] of Object.entries(RANGES)){
    const value=options[key]??DEFAULT_BUDGET[key];
    if(!Number.isSafeInteger(value)||value<min||value>max)
      reject(key+' must be an integer between '+min+' and '+max);
    budget[key]=value;
  }
  if(budget.maxWorkStarts<totalUnits)
    reject('total work starts cannot be below the number of mission units');
  if(!Number.isFinite(createdAt))reject('invalid creation time');
  budget.deadlineAt=new Date(createdAt+budget.maxMissionSeconds*1000).toISOString();
  return budget;
}

export function budgetOf(mission){
  // Existing SQLite / JSON snapshots are grandfathered without retroactive
  // expiration. All NEW mission snapshots carry a durable creation deadline.
  return mission?.budget||{...DEFAULT_BUDGET,deadlineAt:null};
}
export function budgetExpired(mission,now=Date.now()){
  const deadline=budgetOf(mission).deadlineAt;
  return deadline!==null&&deadline!==undefined&&
    (!Number.isFinite(Date.parse(deadline))||Date.parse(deadline)<=now);
}
export function totalStarts(mission){
  return mission.units.reduce((sum,unit)=>sum+(unit.attempts||0),0);
}
export function remainingStarts(mission){
  return Math.max(0,budgetOf(mission).maxWorkStarts-totalStarts(mission));
}
export function requirePayloadBudget(mission,payload,kind='result'){
  const bytes=Buffer.byteLength(JSON.stringify(payload),'utf8');
  if(bytes>budgetOf(mission).maxResultBytes)
    reject(kind+' exceeds '+budgetOf(mission).maxResultBytes+' UTF-8 bytes');
  return bytes;
}
export function budgetStatus(mission){
  const b=budgetOf(mission);
  return {
    limits:{...b},
    workStartsUsed:totalStarts(mission),
    workStartsRemaining:remainingStarts(mission),
    activeReads:mission.units.filter(x=>x.effect==='READ'&&x.status==='RUNNING').length,
    activeWrites:mission.units.filter(x=>x.effect==='WRITE'&&x.status==='RUNNING').length,
    deadlineExpired:budgetExpired(mission),
    revision:mission.revision,
    assurance:'LOCAL_DURABLE_COUNTERS',
  };
}
