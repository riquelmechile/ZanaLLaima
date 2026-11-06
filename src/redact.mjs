// Secret redaction for remote mode.
// Adapted from riquelmechile/panter-ai@1a99048 src/core/downstream.ts
// (clean, redactDeep). Tokens live only in the server environment; nothing
// that leaves this process (tool results, errors, audit, logs) may carry one.

// Token shapes GitHub issues (classic, fine-grained, OAuth, app, refresh).
const GITHUB_TOKEN=/\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g;
const BEARER=/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi;

// Known secret values from the environment, in every form they can appear.
export function secretForms(values=[]){
  const out=new Set();
  for(const value of values){
    if(typeof value!=='string'||value.length<8)continue;
    out.add(value);
    out.add(JSON.stringify(value).slice(1,-1));
    out.add(encodeURIComponent(value));
    out.add(Buffer.from(value).toString('base64'));
  }
  return [...out].sort((a,b)=>b.length-a.length);
}

export function redactText(input,secrets=[]){
  let text=typeof input==='string'?input:String(input??'');
  for(const form of secretForms(secrets))text=text.split(form).join('[redacted]');
  return text.replace(GITHUB_TOKEN,'[redacted]').replace(BEARER,'$1 [redacted]');
}

// One bounded line, safe to show and store.
export function clean(error,secrets=[]){
  const message=error instanceof Error?error.message:String(error);
  return redactText(message,secrets).replace(/\s+/g,' ').slice(0,300);
}

// The value with every occurrence of the secrets removed, at any depth: done on
// its JSON text, so nothing is left unvisited.
export function redactDeep(value,secrets=[]){
  if(value===undefined)return value;
  return JSON.parse(redactText(JSON.stringify(value),secrets));
}

// Names of the environment variables that hold secrets in remote mode.
export const SECRET_ENV=Object.freeze(['ZANA_DOWNSTREAM_GITHUB_TOKEN','ZANA_REVIEWER_TOKEN',
  'ZANA_OAUTH_CONSENT_PASSWORD']);
export const envSecrets=(env=process.env)=>SECRET_ENV.map(name=>env[name]).filter(Boolean);
