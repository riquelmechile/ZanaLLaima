import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateRelativePath,validateWriteRequest,workspaceRoot,
  capturePathAnchors,inspectPreimage,atomicWorkspaceEffect} from '../src/write-effect.mjs';
import {verifyWorkspacePaths} from '../src/paths.mjs';

async function work(){
  const root=await mkdtemp(join(tmpdir(),'zana-fs-branches-'));
  await mkdir(join(root,'docs'));
  return {root,cleanup:()=>rm(root,{recursive:true,force:true})};
}
test('relative paths and request bytes reject malformed operations',()=>{
  for(const path of ['',null,1,'/absolute','../escape','docs//double',
    'docs/./same','docs/../parent','docs\\windows','docs/\0nul']){
    assert.throws(()=>validateRelativePath(path),/Unsafe/);
  }
  assert.deepEqual(validateRelativePath('docs/valid.txt'),['docs','valid.txt']);
  assert.throws(()=>validateWriteRequest({path:'docs/a'},1024),/content/);
  assert.throws(()=>validateWriteRequest({path:'docs/a',deleteFile:true,content:'x'},1024),/deleteFile/);
  assert.throws(()=>validateWriteRequest({path:'docs/a',deleteFile:'true'},1024),/Invalid deleteFile/);
  assert.throws(()=>validateWriteRequest({path:'docs/a',content:'hello',expectedPreSha256:'notsha'},1024),/expectedPreSha256/);
  assert.throws(()=>validateWriteRequest({path:'docs/a',content:'漢'.repeat(400)},1024),/byte budget/);
  assert.equal(validateWriteRequest({path:'docs/a',deleteFile:true},1024).bytes,0);
  assert.equal(validateWriteRequest({path:'docs/a',content:'hello'},1024).bytes,5);
});
test('workspace roots, symlinks and missing parents fail safely',async()=>{
  const f=await work();
  try{
    await assert.rejects(workspaceRoot('relative'),/Absolute workspace root/);
    const alias=join(f.root,'alias');
    await symlink(join(f.root,'docs'),alias,'dir');
    await assert.rejects(workspaceRoot(alias),/symlink/);
    await assert.rejects(verifyWorkspacePaths(['docs/a'],'relative'),/Absolute operator workspace/);
    await assert.rejects(verifyWorkspacePaths([],f.root),/No authorized paths/);
    await assert.rejects(verifyWorkspacePaths(['docs//a'],f.root),/Unsafe path/);
    await assert.rejects(verifyWorkspacePaths(['docs/a','../escape'],f.root),/Unsafe path/);
    await assert.rejects(verifyWorkspacePaths(['alias/a'],f.root),/Symlink/);
    const anchors=await capturePathAnchors(['docs/a','docs/missing/deep'],f.root);
    assert.ok(anchors.anchors['']);
    assert.ok(anchors.anchors.docs);
    assert.equal((await inspectPreimage({path:'docs/nonexistent',root:f.root,anchors:anchors.anchors})).exists,false);
    await assert.rejects(inspectPreimage({path:'docs/missing/deep',root:f.root,anchors:anchors.anchors}),/ENOENT/);
    await assert.rejects(capturePathAnchors(['alias/file'],f.root),/ELOOP|Symlink|ENOTDIR/);
  }finally{await f.cleanup();}
});
test('atomic file operation validates preimage, file type and rooted scopes',async()=>{
  const f=await work();
  try{
    const anchors=(await capturePathAnchors(['docs'],f.root)).anchors;
    await assert.rejects(atomicWorkspaceEffect({
      path:'docs/missing/deep',content:'x',root:f.root,anchors}),/ENOENT/);
    await assert.rejects(atomicWorkspaceEffect({
      path:'docs/missing',deleteFile:true,root:f.root,anchors}),/Cannot delete absent/);
    const result=await atomicWorkspaceEffect({
      path:'docs/new.txt',content:'hello',root:f.root,anchors});
    assert.equal(result.bytes,5);
    await assert.rejects(atomicWorkspaceEffect({
      path:'docs/new.txt',content:'unauthorized replacement',root:f.root,anchors,
      beforeEffect:()=>{throw Error('lease or grant expired before effect');}
    }),/lease or grant expired/);
    assert.equal(await readFile(join(f.root,'docs/new.txt'),'utf8'),'hello');
    await assert.rejects(atomicWorkspaceEffect({
      path:'docs/new.txt',content:'changed',expectedPreSha256:'f'.repeat(64),
      root:f.root,anchors}),/expectedPreSha256/);
    await mkdir(join(f.root,'docs','directory'));
    await assert.rejects(atomicWorkspaceEffect({
      path:'docs/directory',content:'x',root:f.root,anchors}),/non-regular/);
  }finally{await f.cleanup();}
});
