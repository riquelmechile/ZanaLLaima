// Signed operator and lifecycle transitions use exactly one evidence predicate.
export function validReconciliationEvidence(items){
  return Array.isArray(items)&&items.length>=1&&items.length<=20&&
    items.every(x=>typeof x==='string'&&x.trim().length>=8&&x.length<=2000);
}
