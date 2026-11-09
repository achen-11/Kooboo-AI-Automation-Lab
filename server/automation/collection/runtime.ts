import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, lstatSync, mkdirSync, openSync, closeSync, writeSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CollectionBlocked } from './errors.js';

// Source and dist-server/server/automation/collection both resolve to the project.
export function collectionEngineRoot(){const here=dirname(fileURLToPath(import.meta.url));for(let path=here;;path=dirname(path)){const target=resolve(path,'engines/site-harvest');if(existsSync(resolve(target,'bridge.py')))return target;if(dirname(path)===path)throw new Error('内置采集引擎未随平台交付');}}
export function collectionPython(directory:string){const python=resolve(directory,'collection-runtime',process.platform==='win32'?'Scripts/python.exe':'bin/python');if(!existsSync(python))throw new CollectionBlocked('平台采集运行环境尚未初始化',['在项目目录执行 npm run install:collection；需要 Python 3.12，初始化不会修改全局 Python 或现有配置。']);return python;}
export function safeCollectionPath(root:string,path:string){
  if(isAbsolute(path)||!path||path.includes('\\'))throw new Error('采集证据路径必须为包内相对路径');
  const target=resolve(root,path),rel=relative(root,target);if(rel.startsWith('..')||isAbsolute(rel))throw new Error('采集证据路径越界');
  for(let current=target;current!==dirname(root)&&current!==dirname(current);current=dirname(current)){if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw new Error('采集资料不能通过符号链接访问');if(current===root)break;}
  if(existsSync(target)&&relative(realpathSync(root),realpathSync(target)).startsWith('..'))throw new Error('采集证据越界');return target;
}
export const collectionHash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export function collectionEngineFingerprint(){const root=collectionEngineRoot(),files=['bridge.py','engine-version.json',...readdirSync(resolve(root,'siteharvest')).filter(n=>n.endsWith('.py')).map(n=>'siteharvest/'+n)].sort();return collectionHash(JSON.stringify(files.map(path=>[path,collectionHash(readFileSync(resolve(root,path)))])));}
export interface BridgeResult {summary?:unknown;receipts?:unknown[];checkpoint?:string;checklist?:string;artifacts?:{items:{path:string;bytes:number;layer:string}[];total:number;nextCursor:number|null};[key:string]:unknown}
export async function runCollectionBridge(input:{directory:string;workspace:string;requestId:string;operation:string;sourceUrl?:string;options?:unknown;payload?:Record<string,unknown>;signal:AbortSignal;onStarted?:(pid:number)=>void;timeoutMs?:number;python?:string}):Promise<BridgeResult>{
  const python=input.python||collectionPython(input.directory),engine=collectionEngineRoot();
  const logs=resolve(input.directory,'collection-logs');mkdirSync(logs,{recursive:true,mode:0o700});
  if(!/^[a-zA-Z0-9_-]{1,160}$/.test(input.requestId))throw new Error('采集操作ID不合法');
  const fd=openSync(resolve(logs,input.requestId+'.log'),'a',0o600);
  const env:Record<string,string>={PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONUNBUFFERED:'1',LANG:'en_US.UTF-8'};
  // No platform, model, browser or Kooboo credentials are inherited.
  for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP','SSL_CERT_FILE','SSL_CERT_DIR'])if(process.env[key])env[key]=process.env[key]!;
  try{return await new Promise<BridgeResult>((done,reject)=>{
    input.signal.throwIfAborted();let stdout='',stderrBytes=0,failure:Error|undefined,settled=false;
    const child=spawn(python,['-I','-B',resolve(engine,'bridge.py')],{cwd:engine,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
    const stop=()=>{failure=input.signal.reason instanceof Error?input.signal.reason:new Error('采集操作已取消');child.kill('SIGTERM');killLater();};
    const timer=setTimeout(()=>{failure=new Error('采集操作窗口到时；保留已落盘检查点');child.kill('SIGTERM');killLater();},input.timeoutMs||25*60000);timer.unref();
    let force:ReturnType<typeof setTimeout>|undefined;
    child.once('spawn',()=>{if(child.pid)input.onStarted?.(child.pid);});
    child.once('exit',()=>{if(force)clearTimeout(force);});
    const killLater=()=>{force=setTimeout(()=>child.kill('SIGKILL'),3000);force.unref();};
    input.signal.addEventListener('abort',stop,{once:true});child.once('exit',()=>input.signal.removeEventListener('abort',stop));
    child.stdout.on('data',chunk=>{stdout+=chunk;if(Buffer.byteLength(stdout)>4*1024*1024){failure=new Error('采集桥返回超过4MB，必须分页');child.kill('SIGTERM');killLater();}});
    child.stderr.on('data',chunk=>{const remaining=4*1024*1024-stderrBytes;if(remaining>0)writeSync(fd,chunk.subarray(0,remaining));stderrBytes+=chunk.length;});
    const finish=(error?:Error,value?:BridgeResult)=>{if(settled)return;settled=true;clearTimeout(timer);if(force)clearTimeout(force);input.signal.removeEventListener('abort',stop);error?reject(error):done(value!);};
    child.once('error',error=>finish(error));
    child.once('close',code=>{if(failure)return finish(failure);try{const message=JSON.parse(stdout);if(message.protocolVersion!==1||message.requestId!==input.requestId||!message.ok||code!==0)throw new Error(message.error?.message||'采集桥回执不匹配');finish(undefined,message.result);}catch(error){finish(error as Error);}});
    child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify({protocolVersion:1,requestId:input.requestId,operation:input.operation,workspace:input.workspace,sourceUrl:input.sourceUrl,options:input.options,authorization:{network:true},...input.payload}));
    if(input.signal.aborted)stop();
  });}finally{closeSync(fd);}
}
