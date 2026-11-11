import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, delimiter } from 'node:path';

/** exec preserves the PID recorded before Codex enters its workspace sandbox. */
export function trackedCodexProcess(directory:string,pidFile:string,binary?:{path:string;pathDirs:string[]}) {
  if(process.platform==='win32')return undefined;
  if(!binary){
    const arch=process.arch==='arm64'?'aarch64':process.arch==='x64'?'x86_64':undefined;
    const os=process.platform==='darwin'?'apple-darwin':process.platform==='linux'?'unknown-linux-musl':undefined;
    if(!arch||!os)return undefined;
    const require=createRequire(import.meta.url),codexRequire=createRequire(require.resolve('@openai/codex/package.json'));
    const platform=process.platform==='darwin'?'darwin':'linux',pkg=codexRequire.resolve(`@openai/codex-${platform}-${process.arch}/package.json`);
    const root=resolve(dirname(pkg),'vendor',`${arch}-${os}`),modern=resolve(root,'bin','codex');
    binary=existsSync(modern)&&existsSync(resolve(root,'codex-package.json'))?{path:modern,pathDirs:[resolve(root,'codex-path')]}:{path:resolve(root,'codex','codex'),pathDirs:[resolve(root,'path')]};
    if(!existsSync(binary.path))return undefined;
  }
  const wrapper=resolve(directory,'codex-process-v1.sh');mkdirSync(directory,{recursive:true,mode:0o700});mkdirSync(dirname(pidFile),{recursive:true,mode:0o700});
  try{writeFileSync(wrapper,'#!/bin/sh\nprintf "%s\\n" "$$" > "$AUTOMATION_CODEX_PID_FILE" || exit 125\nexec "$AUTOMATION_CODEX_BINARY" "$@"\n',{mode:0o700,flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  return {codexPathOverride:wrapper,env:{AUTOMATION_CODEX_PID_FILE:pidFile,AUTOMATION_CODEX_BINARY:binary.path,PATH:[...binary.pathDirs.filter(path=>existsSync(path)),process.env.PATH||''].join(delimiter)}};
}

/** Absence, invalid receipts and permission errors never prove termination. */
export async function confirmedCodexExit(pidFile:string,timeoutMs=3000) {
  let pid:number;
  try{const raw=readFileSync(pidFile,'utf8').trim();if(!/^[1-9]\d{0,9}$/.test(raw))return false;pid=Number(raw);if(!Number.isSafeInteger(pid)||pid<=1)return false;}catch{return false;}
  const deadline=Date.now()+timeoutMs;
  do{
    try{process.kill(pid,0);}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH';}
    if(Date.now()>=deadline)return false;
    await new Promise(done=>setTimeout(done,25));
  }while(true);
}
