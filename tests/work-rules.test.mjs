// PR5: reglas de trabajo. La skill zana-pr se sirve por MCP y las reglas del verificador
// están en las skills; además, inTouchedFile calza rutas en NFD y fullwidth (S14).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {remoteFixture} from './helpers/remote-fixture.mjs';
import {inTouchedFile} from '../src/remote-review.mjs';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('zana-pr: aparece en el catálogo MCP y se carga',async()=>{
  const f=await remoteFixture();
  try{
    const s=await f.session();
    const {skills}=await f.call('zana_skill_list',{},s);
    assert.ok(skills.some(x=>x.name==='zana-pr'&&/Risk/.test(x.description)),JSON.stringify(skills));
    const pr=await f.call('zana_skill_load',{name:'zana-pr'},s);
    assert.equal(pr.name,'zana-pr');
    assert.match(pr.text,/conventional commits, en español: `feat:`, `fix:`, `test:`, `docs:`/);
    assert.match(pr.text,/Ninguna casilla marcada sin evidencia/);
    for(const cat of ['none','irreversible-data','security','public-contract','concurrency','ci-or-deps','untestable'])
      assert.match(pr.text,new RegExp('`(Risk: )?'+cat+'`'),cat);
    assert.match(pr.text,/400 líneas[\s\S]*`zana-odd`[\s\S]*`zana_budget_extend`/);
  }finally{await f.cleanup();}
});

test('reglas del verificador en zana-4r, review-reliability y review-discipline; zana-odd carga zana-pr',()=>{
  const r4=read('skills/zana-4r/SKILL.md'),rel=read('skills/review-reliability/SKILL.md'),disc=read('skills/review-discipline/SKILL.md');
  for(const text of [r4,rel,disc]){
    assert.match(text,/Que los tests pasen no prueba un requisito que ningún test ejecuta/);
    assert.match(text,/"0 tests corridos" con (el|su) error/);
    assert.match(text,/[Uu]na corrección por check fallido y como máximo un reintento; después se reporta/);
  }
  for(const text of [r4,disc])assert.match(text,/`Risk:`[\s\S]*hallazgo de R2, y (también )?de R1 si esconde un riesgo/);
  assert.match(read('skills/review-readability/SKILL.md'),/sin línea `Risk:`/);
  assert.match(read('skills/review-risk/SKILL.md'),/línea `Risk:` del cuerpo del PR que esconde un riesgo/);
  const odd=read('skills/zana-odd/SKILL.md');
  assert.match(odd,/Antes de abrir el PR, carga `zana-pr` con `zana_skill_load` y síguela/);
  assert.ok(odd.indexOf('`zana-pr`')<odd.indexOf('`create_pull_request` con `head'),'zana-pr va antes de abrir el PR');
  const rdd=read('docs/solo-rdd.md').split('**No prueba:**')[1];
  assert.match(rdd,/vuelve alcanzable \(`ACTIVATED`\), no se etiquete `PREEXISTING`/);
  assert.match(rdd,/el servidor no la busca en el árbol de `baseSha`/);
});

test('S14: inTouchedFile normaliza con NFKC (NFD y fullwidth calzan con la ruta tocada)',()=>{
  const nfc='docs/año.md',nfd='docs/año.md';
  assert.notEqual(nfc,nfd);
  assert.equal(inTouchedFile([nfc],nfd+':3'),true);
  assert.equal(inTouchedFile([nfd],nfc+':3'),true);
  assert.equal(inTouchedFile(['src/s.mjs'],'ｓrc/s.mjs:1'),true);
  assert.equal(inTouchedFile(['src/s.mjs'],'ｓrc/Ｓ.mjs:1'),true);
  // Las mismas formas con otra ruta no calzan: el true de arriba viene de normalizar.
  assert.equal(inTouchedFile([nfc],'docs/ano.md:3'),false);
  assert.equal(inTouchedFile(['src/s.mjs'],'ｓrc/t.mjs:1'),false);
});
