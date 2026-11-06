// Signed actor assertions: ZanaLLaima tells a downstream MCP server who is
// really calling (host, session, mission, tool and an argument digest), bound
// to one call and a short lifetime, signed with Ed25519 (JWS alg EdDSA).
// Copied and adapted from panter-ai@1a99048
// src/core/actor-assertion.ts (types stripped, issuer and roles renamed).
// What it proves: which authenticated host/session ZanaLLaima admitted. It
// does not prove the model the host runs.
import {KeyObject,createHash,createPrivateKey,createPublicKey,generateKeyPairSync,sign,verify} from 'node:crypto';

export const ACTOR_TYP='zana-actor+jwt';
export const ACTOR_ISSUER='zana-llaima';
export const ACTOR_TTL_SECONDS=120;
export const ACTOR_MAX_TTL_SECONDS=300;
export const ACTOR_LEEWAY_SECONDS=30;
export const ACTOR_ROLES=Object.freeze(['author','reviewer','operator']);

const b64u=b=>Buffer.from(b).toString('base64url');
const fromB64u=s=>{
  if(!/^[A-Za-z0-9_-]*$/.test(s))throw new Error('actor assertion: not base64url');
  return Buffer.from(s,'base64url');
};

// JSON with object keys sorted at every depth.
export function canonicalJson(value){
  if(value===null||typeof value!=='object')return JSON.stringify(value)??'null';
  if(Array.isArray(value))return '['+value.map(v=>v===undefined?'null':canonicalJson(v)).join(',')+']';
  return '{'+Object.keys(value).sort().filter(k=>value[k]!==undefined&&typeof value[k]!=='function')
    .map(k=>JSON.stringify(k)+':'+canonicalJson(value[k])).join(',')+'}';
}
export const argsDigest=args=>b64u(createHash('sha256').update(canonicalJson(args??{})).digest());

export class ActorSigner{
  constructor(privateKey){
    if(privateKey?.asymmetricKeyType!=='ed25519')throw new Error('actor signer: an Ed25519 key is required');
    this.privateKey=privateKey;
    this.publicKey=createPublicKey(privateKey);
    this.kid=b64u(createHash('sha256').update(this.publicKey.export({format:'jwk'}).x).digest()).slice(0,16);
  }
  static generate(){return new ActorSigner(generateKeyPairSync('ed25519').privateKey);}
  static fromPkcs8(base64){
    return new ActorSigner(createPrivateKey({key:Buffer.from(base64,'base64'),format:'der',type:'pkcs8'}));
  }
  exportPkcs8(){return this.privateKey.export({format:'der',type:'pkcs8'}).toString('base64');}
  jwk(){
    const {kty,crv,x}=this.publicKey.export({format:'jwk'});
    return {kty,crv,x,kid:this.kid,alg:'EdDSA',use:'sig'};
  }
  sign(claims){
    const head=b64u(JSON.stringify({alg:'EdDSA',typ:ACTOR_TYP,kid:this.kid}));
    const body=b64u(JSON.stringify(claims));
    return head+'.'+body+'.'+b64u(sign(null,Buffer.from(head+'.'+body),this.privateKey));
  }
}

// Reference verifier for downstream servers. Throws unless the token is a
// valid assertion for exactly this call. Keep each accepted jti until exp plus
// leeway and refuse repeats.
export function verifyActorAssertion(token,key,expect){
  if(typeof token!=='string'||token.length>4096)throw new Error('actor assertion: missing');
  const parts=token.split('.');
  if(parts.length!==3)throw new Error('actor assertion: malformed');
  const [head,body,sig]=parts;
  let header,claims;
  try{
    header=JSON.parse(fromB64u(head).toString('utf8'));
    claims=JSON.parse(fromB64u(body).toString('utf8'));
  }catch{throw new Error('actor assertion: malformed');}
  if(header?.alg!=='EdDSA'||header?.typ!==ACTOR_TYP)throw new Error('actor assertion: wrong algorithm or type');
  const publicKey=key instanceof KeyObject?key:createPublicKey({key,format:'jwk'});
  if(publicKey.asymmetricKeyType!=='ed25519')throw new Error('actor assertion: an Ed25519 key is required');
  const kid=key instanceof KeyObject?undefined:key.kid;
  if(kid!==undefined&&header.kid!==kid)throw new Error('actor assertion: signed with another key');
  if(!verify(null,Buffer.from(head+'.'+body),publicKey,fromB64u(sig)))throw new Error('actor assertion: bad signature');
  const now=Math.floor((expect.now??Date.now())/1000),leeway=expect.leewaySeconds??ACTOR_LEEWAY_SECONDS;
  if(claims?.iss!==ACTOR_ISSUER)throw new Error('actor assertion: wrong issuer');
  if(claims.aud!==expect.aud)throw new Error('actor assertion: meant for another server');
  if(claims.tool!==expect.tool)throw new Error('actor assertion: meant for another tool');
  if(claims.args!==argsDigest(expect.args))throw new Error('actor assertion: arguments differ');
  if(typeof claims.sub!=='string'||!ACTOR_ROLES.includes(claims.role)||typeof claims.jti!=='string')
    throw new Error('actor assertion: incomplete');
  if(!Number.isInteger(claims.iat)||!Number.isInteger(claims.exp)||claims.exp<=claims.iat||
     claims.exp-claims.iat>ACTOR_MAX_TTL_SECONDS)throw new Error('actor assertion: bad lifetime');
  if(claims.iat>now+leeway)throw new Error('actor assertion: issued in the future');
  if(claims.exp+leeway<now)throw new Error('actor assertion: expired');
  return claims;
}
