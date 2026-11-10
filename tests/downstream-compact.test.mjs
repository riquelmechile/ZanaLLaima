import test from 'node:test';
import assert from 'node:assert/strict';
import {compactWrite,inlineResources} from '../src/downstream-compact.mjs';
import {remoteFixture,AUTHOR_TOKEN} from './helpers/remote-fixture.mjs';

const S='a'.repeat(40),C='b'.repeat(40);
const wrap=v=>({content:[{type:'text',text:JSON.stringify(v)}]});
const body=r=>r.structuredContent;

test('compactWrite: cada escritura conocida vuelve compacta',()=>{
  const file=compactWrite('create_or_update_file',{path:'src/a.mjs',content:'ñandú'},
    wrap({content:{path:'src/a.mjs',sha:S,html_url:'https://x/blob'},commit:{sha:C,html_url:'https://x/commit'}}));
  assert.deepEqual(body(file),{ok:true,tool:'create_or_update_file',path:'src/a.mjs',commitSha:C,htmlUrl:'https://x/commit',
    contentSha:S,bytes:7,compacted:true});
  assert.equal(file.content[0].text,JSON.stringify(body(file)));
  assert.deepEqual(body(compactWrite('delete_file',{path:'a'},wrap({commit:{sha:C}}))),
    {ok:true,tool:'delete_file',path:'a',commitSha:C,htmlUrl:null,compacted:true});
  assert.deepEqual(body(compactWrite('push_files',{files:[{path:'a',content:'1'},{path:'b',content:'2'}]},
    wrap({ref:'refs/heads/zana/m',object:{sha:C}}))),
    {ok:true,tool:'push_files',files:['a','b'],commitSha:C,ref:'refs/heads/zana/m',htmlUrl:null,compacted:true});
  assert.deepEqual(body(compactWrite('create_branch',{branch:'zana/m'},wrap({ref:'refs/heads/zana/m',object:{sha:S}}))),
    {ok:true,tool:'create_branch',branch:'zana/m',ref:'refs/heads/zana/m',sha:S,compacted:true});
  assert.deepEqual(body(compactWrite('create_pull_request',{},wrap({number:7,html_url:'https://x/pull/7',head:{sha:S},body:'largo'}))),
    {ok:true,tool:'create_pull_request',number:7,htmlUrl:'https://x/pull/7',headSha:S,compacted:true});
  assert.deepEqual(body(compactWrite('update_pull_request',{},wrap({number:7,url:'https://api/x/pulls/7'}))),
    {ok:true,tool:'update_pull_request',number:7,htmlUrl:null,headSha:null,compacted:true});
});

test('compactWrite: formas desconocidas, errores y lecturas vuelven íntegros',()=>{
  const cases=[
    ['create_or_update_file',{},{content:[{type:'text',text:'ok sin json'}]}],
    ['create_or_update_file',{},wrap({commit:{sha:'corto'}})],
    ['push_files',{},wrap({ref:'r'})],
    ['create_branch',{},wrap([1,2])],
    ['create_pull_request',{},wrap({id:1})],
    ['create_pull_request',{},{content:[{type:'text',text:'{}'},{type:'text',text:'{}'}]}],
    ['create_pull_request',{},{content:[{type:'image',data:'x'}]}],
    ['create_or_update_file',{},{...wrap({commit:{sha:C}}),isError:true}],
    ['get_file_contents',{},wrap({content:{sha:S}})],
    ['create_or_update_file',{},null],
  ];
  for(const [tool,args,result] of cases)assert.equal(compactWrite(tool,args,result),result,tool);
  assert.equal(body(compactWrite('delete_file',null,wrap({commit:{sha:C}}))).path,null);
  // A top-level sha (maybe a blob) or an API url is never reported as commit or link.
  for(const [tool,payload] of [['delete_file',{sha:C}],['create_branch',{sha:S}],['push_files',{sha:C}],['update_pull_request',{url:'https://api/x'}]])
    assert.equal(compactWrite(tool,{},wrap(payload)).compacted,undefined,tool);
});

test('zana_ds_github: escritura exitosa compacta y redactada; lecturas íntegras',async()=>{
  const f=await remoteFixture();
  try{
    const {author,missionId,branch}=await f.authorReady({pull:false});
    f.ds.responses.create_or_update_file={content:{path:'src/x.mjs',sha:S},commit:{sha:C,html_url:'https://x/c?t='+AUTHOR_TOKEN}};
    const r=await f.call('zana_ds_github',{operation:'create_or_update_file',missionId,
      arguments:{owner:'o',repo:'r',message:'m',branch,path:'src/x.mjs',content:'export const x=1;\n'}},author);
    assert.equal(r.compacted,true,JSON.stringify(r));
    assert.equal(r.commitSha,C);
    assert.equal(r.path,'src/x.mjs');
    assert.equal(JSON.stringify(r).includes(AUTHOR_TOKEN),false);
    f.ds.responses.get_file_contents={content:{path:'src/x.mjs',sha:S},extra:'se conserva'};
    const read=await f.call('zana_ds_github',{operation:'get_file_contents',arguments:{owner:'o',repo:'r',path:'src/x.mjs'}},author);
    assert.equal(JSON.parse(read.content[0].text).extra,'se conserva');
  }finally{await f.cleanup();}
});

// ChatGPT trata un recurso embebido como archivo adjunto y pide aprobación para
// "materializarlo" en cada lectura (observado: 39 lecturas, 39 avisos).
test('lecturas: un recurso de texto llega como texto, sin adjunto; el binario queda igual',async()=>{
  const f=await remoteFixture();
  try{
    const {author}=await f.authorReady({pull:false});
    const body='export const x=1;\n// ñ, comillas " y una línea final\n';
    f.ds.rawContent.get_file_contents=[{type:'text',text:'successfully downloaded text file (SHA: '+S+')'},
      {type:'resource',resource:{uri:'repo://o/r/contents/src/x.mjs',mimeType:'text/plain; charset=utf-8',text:body}}];
    const read=await f.call('zana_ds_github',{operation:'get_file_contents',arguments:{owner:'o',repo:'r',path:'src/x.mjs'}},author);
    assert.equal(read.content.some(c=>c.type!=='text'),false,JSON.stringify(read.content.map(c=>c.type)));
    assert.equal(read.content[0].text,'successfully downloaded text file (SHA: '+S+')');
    assert.equal(read.content.at(-1).text,body,'el contenido llega exacto');
    assert.ok(read.content.some(c=>c.text.includes('repo://o/r/contents/src/x.mjs')),'el origen se conserva');
    // Un enlace a recurso también es un adjunto para el anfitrión.
    f.ds.rawContent.get_file_contents=[{type:'resource_link',uri:'repo://o/r/contents/big.txt',name:'big.txt',mimeType:'text/plain'}];
    const link=await f.call('zana_ds_github',{operation:'get_file_contents',arguments:{owner:'o',repo:'r',path:'big.txt'}},author);
    assert.deepEqual(link.content.map(c=>c.type),['text']);
    assert.match(link.content[0].text,/repo:\/\/o\/r\/contents\/big\.txt/);
    // Un binario no se puede dar como texto: queda como llegó.
    const blob={type:'resource',resource:{uri:'repo://o/r/contents/logo.png',mimeType:'image/png',blob:'iVBORw0KGgo='}};
    f.ds.rawContent.get_file_contents=[blob];
    const bin=await f.call('zana_ds_github',{operation:'get_file_contents',arguments:{owner:'o',repo:'r',path:'logo.png'}},author);
    assert.deepEqual(bin.content,[blob]);
  }finally{await f.cleanup();}
});

test('inlineResources: formas raras quedan intactas y no se inventa contenido',()=>{
  for(const odd of [null,undefined,{},{content:'x'},{content:[null,{type:'text',text:'a'}]},
    {content:[{type:'resource'}]},{content:[{type:'resource',resource:{uri:'u',text:7}}]},
    {content:[{type:'resource',resource:{uri:'u',text:'t',blob:'b'}}]}])
    assert.deepEqual(inlineResources(odd),odd);
  const out=inlineResources({content:[{type:'resource',resource:{uri:'u',text:''}}],_meta:{a:1}});
  assert.deepEqual(out,{content:[{type:'text',text:'resource u'},{type:'text',text:''}],_meta:{a:1}});
});
