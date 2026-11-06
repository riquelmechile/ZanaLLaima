import test from 'node:test';
import assert from 'node:assert/strict';
import {createMission} from '../src/core.mjs';
import {validateRelativePath,inScope} from '../src/paths.mjs';
import {validateWriteRequest} from '../src/write-effect.mjs';
const aliases=['.GIT','.Zana','.git.','.git ','．ＧＩＴ','．ｚａｎａ',
  'docs/.Git/config','docs/.ZANA/state.sqlite','docs/.git.','docs/.zana '];
for(const path of aliases){
 test('R7 WARNING reserved: normalized path '+JSON.stringify(path)+' is unsafe everywhere',()=>{
   assert.throws(()=>validateRelativePath(path),/Unsafe path/);
   assert.equal(inScope(path,['docs']),false);
   assert.throws(()=>createMission({objective:'No reserved path may be authorized',
     authorization:{writesAllowed:true,allowedPaths:[path]},
     units:[{id:'write',effect:'WRITE',paths:[path],instruction:'No access'}]}),/Unsafe/);
   assert.throws(()=>validateWriteRequest({path,content:'never'},1024),/Unsafe/);
 });
}
