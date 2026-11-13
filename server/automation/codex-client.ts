import { Codex } from '@openai/codex-sdk';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Vault } from '../lib/vault.js';
import type { AutomationTask } from '../../shared/automation.js';
import { trackedCodexProcess } from './codex-process.js';
export function responsesBaseUrl(endpoint:string){
  const url=new URL(endpoint);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('评测服务端点必须是无凭据、无查询参数的 HTTP(S) 地址');
  url.pathname=url.pathname.replace(/\/(?:chat\/completions|responses)\/?$/,'').replace(/\/$/,'');
  return url.toString().replace(/\/$/,'');
}

export function codexClient(vault:Vault,directory:string,extra:Record<string,string>={},model?:AutomationTask['model'],pidFile?:string){
  const settings=vault.automation();const runtime=vault.get();
  const endpoint=responsesBaseUrl(model?.endpoint||settings.evaluationEndpoint||runtime.model.endpoint);
  const home=resolve(directory,'codex-runtime');mkdirSync(home,{recursive:true,mode:0o700});
  const tracking=pidFile?trackedCodexProcess(home,pidFile):undefined;
  const env:Record<string,string>={PATH:process.env.PATH||'',HOME:process.env.HOME||'',TMPDIR:process.env.TMPDIR||'/tmp',CODEX_HOME:home,EVALUATOR_MODEL_KEY:runtime.model.apiKey,...extra,...tracking?.env};
  const client=new Codex({env,codexPathOverride:tracking?.codexPathOverride,config:{model_provider:'evaluation',model_providers:{evaluation:{name:'Configured evaluation provider',base_url:extra.AUTOMATION_RESPONSES_URL||endpoint,env_key:'EVALUATOR_MODEL_KEY',wire_api:'responses',request_max_retries:0,stream_max_retries:0}}}});
  if(process.platform!=='win32')return client;
  // Codex CLI 0.167.0 on Windows with sandbox disabled blocks CreateProcess and image reads in read-only/workspace-write.
  const winOptions=(options:Record<string,unknown>={})=>({...options,sandboxMode:'danger-full-access' as const});
  return new Proxy(client,{
    get(target,prop,receiver){
      if(prop==='startThread')return (options?:Record<string,unknown>)=>target.startThread(winOptions(options));
      if(prop==='resumeThread')return (id:string,options?:Record<string,unknown>)=>target.resumeThread(id,winOptions(options));
      const value=Reflect.get(target,prop,receiver);
      return typeof value==='function'?value.bind(target):value;
    },
  });
}
