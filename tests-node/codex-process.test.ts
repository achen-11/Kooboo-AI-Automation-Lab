import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { confirmedCodexExit, trackedCodexProcess } from '../server/automation/codex-process.js';

test('recorded SDK PID must exit before an interrupted stream can release capacity', {skip:process.platform==='win32'}, async()=>{
  const directory=mkdtempSync(join(tmpdir(),'codex-process-')),pidFile=join(directory,'receipts','run.pid');
  const options=trackedCodexProcess(directory,pidFile,{path:process.execPath,pathDirs:[]})!;
  const child=spawn(options.codexPathOverride,['-e','setInterval(()=>{},1000)'],{env:{...process.env,...options.env},stdio:'ignore'});
  const closed=once(child,'close');
  try{
    const deadline=Date.now()+2000;let pid='';
    while(!pid){try{pid=readFileSync(pidFile,'utf8').trim();}catch{}if(Date.now()>deadline)throw new Error('PID receipt missing');await new Promise(done=>setTimeout(done,10));}
    assert.equal(Number(pid),child.pid,'exec must preserve the recorded process identity');
    assert.equal(await confirmedCodexExit(pidFile,30),false,'live SDK keeps its reservation');
    child.kill('SIGTERM');await closed;
    assert.equal(await confirmedCodexExit(pidFile),true,'actual process exit releases capacity');
    assert.equal(await confirmedCodexExit(join(directory,'missing')),false);
    writeFileSync(pidFile,'invalid');assert.equal(await confirmedCodexExit(pidFile),false);
    writeFileSync(pidFile,'1');assert.equal(await confirmedCodexExit(pidFile),false);
  }finally{child.kill();await closed;rmSync(directory,{recursive:true,force:true});}
});

test('tracked launcher resolves the installed SDK binary without model calls',{skip:process.platform==='win32'},()=>{
  const directory=mkdtempSync(join(tmpdir(),'codex-binary-'));
  try{const options=trackedCodexProcess(directory,join(directory,'receipts','run.pid'));assert.ok(options);assert.match(options.env.AUTOMATION_CODEX_BINARY,/codex$/);}
  finally{rmSync(directory,{recursive:true,force:true});}
});
