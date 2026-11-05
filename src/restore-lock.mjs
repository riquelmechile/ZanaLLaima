import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {mkdir,open} from 'node:fs/promises';
import {dirname} from 'node:path';

// Offline Linux-only inter-process mutex: the flock utility owns the advisory
// lock while the Node caller performs ALL restore/abort/cleanup operations.
// The child's stdin pipe closes on parent SIGKILL so no stale lock survives.
// No code from a candidate repository is ever invoked here.
export async function withRestoreLock(databasePath,operation){
  const lock=databasePath+'.restore.lock';
  await mkdir(dirname(lock),{recursive:true,mode:0o700});
  const fd=await open(lock,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
  try{
    const st=await fd.stat();
    if(!st.isFile()||st.nlink!==1)
      throw Error('Restore lock must be a regular, unlinked-only file');
  }finally{await fd.close();}
  const child=spawn('/usr/bin/flock',
    ['-x','-w','20',lock,'/bin/sh','-c','printf "LOCKED\\n"; IFS= read -r release || :'],
    {stdio:['pipe','pipe','pipe']});
  await new Promise((resolve,reject)=>{
    let output='',settled=false;
    const finish=(error)=>{
      if(settled)return;settled=true;
      if(error)reject(error);else resolve();
    };
    child.stdout.on('data',data=>{
      output+=data.toString();
      if(output.includes('LOCKED\n'))finish();
      if(output.length>4096)finish(Error('Restore lock handshake overflow'));
    });
    child.once('error',error=>finish(Error('Cannot acquire offline flock: '+error.message)));
    child.once('exit',code=>finish(Error('Restore flock unavailable or timed out (exit '+code+')')));
  });
  try{return await operation();}
  finally{
    if(child.exitCode===null){
      child.stdin.end('RELEASE\n');
      await new Promise(resolve=>child.once('exit',resolve));
    }
  }
}
