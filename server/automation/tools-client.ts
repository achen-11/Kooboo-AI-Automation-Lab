/**
 * Generates the per-run `tools.mjs` CLI bridge used by Codex decision/follow-up runs.
 * Supports inline JSON, `@file` / `--file <path>` (with UTF-8 BOM stripping), and stdin
 * so Windows PowerShell callers do not lose JSON quotes to nested shell escaping.
 */
export function toolsClientScript(urlEnv:string,tokenEnv:string,transportErrorKind?:string){
  const readBody=`import { readFileSync } from 'node:fs';
const a=process.argv.slice(2);
let body='{}';
const clean=s=>s.replace(/^\\uFEFF/,'').trim()||'{}';
if(a[0]==='--file'&&a[1])body=clean(readFileSync(a[1],'utf8'));
else if(a[0]?.startsWith('@')&&a[0].length>1)body=clean(readFileSync(a[0].slice(1),'utf8'));
else if(a[0]&&a[0]!=='-')body=a[0];
else if(!process.stdin.isTTY){let t='';for await(const c of process.stdin)t+=c;body=clean(t);}`;
  const request=`const r=await fetch(process.env[${JSON.stringify(urlEnv)}],{method:'POST',headers:{Authorization:'Bearer '+process.env[${JSON.stringify(tokenEnv)}],'Content-Type':'application/json'},body});console.log(await r.text());if(!r.ok)process.exitCode=1;`;
  if(!transportErrorKind)return `${readBody}\n${request}`;
  return `${readBody}\ntry{${request}}catch(error){console.log(JSON.stringify({kind:${JSON.stringify(transportErrorKind)},code:error.cause?.code||'FETCH_FAILED',hostname:new URL(process.env[${JSON.stringify(urlEnv)}]).hostname}));process.exitCode=1;}`;
}

export const windowsToolsHint='Windows/PowerShell 下避免嵌套引号转义，推荐用 @\'{"tool":"get_task"}\'@ | node tools.mjs 或先写入 JSON 文件再 node tools.mjs @payload.json（也支持 --file payload.json）。';
