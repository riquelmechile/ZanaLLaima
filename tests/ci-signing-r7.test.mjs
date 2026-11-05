import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('R7 W7/W9: Ed25519 se escribe en temporal privado validado y environment prohíbe self-review',()=>{
 const s=readFileSync(new URL('../scripts/setup-ci-signing.sh',import.meta.url),'utf8');
 assert.match(s,/TMP_PRIVATE=.*mktemp|TMP_PRIVATE=.*\$\(/s,
   'La llave privada debe escribirse a un temporal bajo KEY_DIR');
 assert.match(s,/genpkey[^\n]*-out "\$TMP_PRIVATE"/);
 assert.match(s,/openssl pkey[^\n]*TMP_PRIVATE/);
 assert.match(s,/mv -n[^\n]*TMP_PRIVATE/,'No sobrescribir nunca una llave existente');
 assert.match(s,/prevent_self_review.*true/);
});
test('R7 W7: ci-attest no conserva helper Git muerto',()=>{
 const s=readFileSync(new URL('../scripts/ci-attest.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(s,/const git=\(\.\.\.args\)=>execFileSync/);
});
