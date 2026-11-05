// Public-key readers must never coerce a PRIVATE KEY PEM into a public key.
export function assertPublicPem(pem){
  if(typeof pem!=='string'||!/^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PUBLIC KEY-----\r?\n?$/.test(pem))
    throw new Error('Only PUBLIC KEY PEM is accepted; PRIVATE KEY material is forbidden');
  return pem;
}
