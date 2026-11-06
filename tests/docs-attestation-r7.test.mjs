import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
const docs=['operator-checklist.md','mcp-v2.md','release-security.md'];
for(const name of docs){
  test('R7 CRITICAL 2: '+name+' describe firma workflow_run segura para '+pkg.version,()=>{
    const body=readFileSync(new URL('../docs/'+name,import.meta.url),'utf8');
    assert.match(body,new RegExp('ZanaLLaima '+pkg.version.replaceAll('.','[.]')),
      'Versión desactualizada: '+name);
    assert.match(body,/ci-attestation[.]yml/,'Falta workflow firmante real');
    assert.match(body,/workflow_run/,'El firmante no es un job en ci.yml');
    assert.match(body,/ci-attestation/,'Falta environment protegido');
    assert.match(body,/main-only|solo main|exclusivamente main/i,'Policies deben ser main-only');
    assert.match(body,/reviewer|revisor/i,'La firma requiere reviewer humano');
    assert.doesNotMatch(body,/refs\/pull\/\d+\/merge/i,'Nunca aprobar policy de PR');
    assert.doesNotMatch(body,/(?:policy|environment|branch policy)[^\n]{0,100}feat\/gpt-native-solo-engine/i,
      'Nunca habilitar feature branch en policy de firma');
    assert.doesNotMatch(body,/(?:job|trabajo)\s+(?:de\s+Actions\s+)?[\x60]?attest[\x60]?[^\n]{0,90}ci[.]yml/i,
      'No hay job attest dentro de ci.yml');
  });
}
