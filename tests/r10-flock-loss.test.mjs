import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const lockURL=new URL('../src/restore-lock.mjs',import.meta.url).href;
test('R10-W5: pérdida de flock activa fail-stop antes de seguir moviendo DB',()=>{
 const dir=mkdtempSync(join(tmpdir(),'zana-r10-flock-loss-'));
 try{
  const code=
   'import {readFileSync} from "node:fs";\n'+
   'import {withRestoreLock} from '+JSON.stringify(lockURL)+';\n'+
   'await withRestoreLock(process.argv[1],async()=>{\n'+
   ' const children=readFileSync("/proc/self/task/"+process.pid+"/children","utf8").trim().split(/\\s+/);\n'+
   ' if(!children[0])throw Error("No flock child PID");\n'+
   ' process.kill(Number(children[0]),"SIGKILL");\n'+
   ' await new Promise(resolve=>setTimeout(resolve,200));\n'+
   ' throw Error("SECURITY FAILURE: callback continued after flock loss");\n'+
   '});\n';
  const result=spawnSync(process.execPath,['--input-type=module','-e',code,join(dir,'db')],
   {encoding:'utf8',timeout:10000});
  assert.equal(result.signal,'SIGKILL',
   'El trabajo continuó sin su mutex: '+result.stderr);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
