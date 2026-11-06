// Secret redaction for remote mode.
// Adapted from panter-ai@1a99048 src/core/downstream.ts
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

// Formas comunes de credencial que no están en el entorno del servidor, para
// texto que se guarda (memoria). El orden importa: bloques y URLs antes que
// las asignaciones clave=valor, que conservan la clave. Las repeticiones van
// acotadas o ancladas para que un texto hostil no sea cuadrático.
const CREDENTIALS=[
  [/-----BEGIN ([A-Z ]*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END \1-----|$)/g,'[redacted]'],
  [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]*:[^\s/]*@/gi,'$1[redacted]@'],
  [/(?<![\w-])eyJ[\w-]{10,4096}\.[\w-]{10,4096}\.[\w-]{10,4096}/g,'[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{35}/g,'[redacted]'],
  [/\b(?:[sr]k_(?:live|test)|pk_live)_[0-9A-Za-z]{16,}/g,'[redacted]'],
  [/\b(?:whsec_[A-Za-z0-9+/=]{20,}|hf_[A-Za-z0-9]{30,})/g,'[redacted]'],
  [/\b(Authorization[ \t]*:[ \t]*Basic)[ \t]+[A-Za-z0-9+/=]{8,}/gi,'$1 [redacted]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g,'[redacted]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,'[redacted]'],
  [/\b(?:xox[a-z]|xapp)-[A-Za-z0-9-]{10,}/g,'[redacted]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g,'[redacted]'],
  [/\bnpm_[A-Za-z0-9]{36}/g,'[redacted]'],
  // Con prefijo (DB_PASSWORD, access_token); el valor entre comillas hasta la de cierre, o sin
  // comillas de 6+ caracteres que no sean un operador ni una llamada a código: 'token: usar JWT',
  // 'token === null' o 'password: z.string()' no cambian (una llamada termina en ')');
  // 'password=p@ss(word1' sí.
  [/(?<![A-Za-z0-9_])((?:[A-Za-z0-9]+_)*(?:secret|password|passwd|token|api[_-]?key|aws_secret_access_key))(["']?[ \t]*[=:][ \t]*)("[^"]*"|'[^']*'|(?![=:])(?![A-Za-z_$][\w$.]{0,64}\(\S{0,128}\)[;,]?(?:\s|$))\S{6,})/gi,'$1$2[redacted]']];
export const scrubCredentials=text=>CREDENTIALS.reduce((t,[re,to])=>t.replace(re,to),text);
// Texto de memoria: secretos del entorno, tokens de GitHub/Bearer y las formas de arriba.
export const redactStored=(input,secrets=[])=>scrubCredentials(redactText(input,secrets));

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
