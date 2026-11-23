import http from 'node:http';
import https from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type {
  AutomationTask,
  GeneratedSite,
  KoobooMethodSupport,
  KoobooSandboxCapabilities,
  KoobooTemplatePage,
  KoobooTemplateSummary,
} from '../../shared/automation.js';
import type { Vault } from '../lib/vault.js';
import type { AutomationStore } from './store.js';

export function isKoobooApiMethodNotFound(status: number, body: string): boolean {
  if (status === 404) return true;
  if (status !== 400) return false;
  const pattern = /api\s*method\s*not\s*found|找不到\s*api\s*方法/i;
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) {
      return parsed.some((entry) => typeof entry === 'string' && pattern.test(entry));
    }
    if (typeof parsed === 'string') return pattern.test(parsed);
  } catch {
    // Fall back to raw body check when response is not valid JSON.
  }
  return pattern.test(body);
}

const CAPABILITY_CACHE_TTL_MS = 60_000;
const capabilityCache = new Map<string, { value: 'supported' | 'unsupported'; expiresAt: number }>();

export function clearKoobooCapabilityCache(): void {
  capabilityCache.clear();
}

export async function probeKoobooApiMethod(options: {
  apiOrigin: string;
  token?: string;
  path: string;
  signal: AbortSignal;
  forceRefresh?: boolean;
}): Promise<KoobooMethodSupport> {
  const cleanPath = options.path.split('?')[0]!.replace(/^\/+/, '');
  const origin = new URL(options.apiOrigin).origin;
  const cacheKey = `${origin}::${cleanPath}`;
  if (!options.forceRefresh) {
    const cached = capabilityCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached) capabilityCache.delete(cacheKey);
  }
  try {
    const url = new URL(`/_api/v2/${cleanPath}`, origin);
    const result = await httpRead(url, {
      token: options.token,
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(15000)]),
    });
    if (isKoobooApiMethodNotFound(result.status, result.body)) {
      capabilityCache.set(cacheKey, { value: 'unsupported', expiresAt: Date.now() + CAPABILITY_CACHE_TTL_MS });
      return 'unsupported';
    }
    if ((result.status >= 200 && result.status < 300) || result.status === 400 || result.status === 401 || result.status === 403) {
      capabilityCache.set(cacheKey, { value: 'supported', expiresAt: Date.now() + CAPABILITY_CACHE_TTL_MS });
      return 'supported';
    }
    return 'unknown';
  } catch (error) {
    if (options.signal.aborted) throw error;
    return 'unknown';
  }
}

export async function probeKoobooSandboxCapabilities(
  environment: { id?: string; origin: string; apiOrigin?: string; token?: string },
  signal: AbortSignal,
  options?: { forceRefresh?: boolean },
): Promise<KoobooSandboxCapabilities> {
  const apiOrigin = new URL(environment.apiOrigin || environment.origin).origin;
  const [transferByLevel, importFromTemplate] = await Promise.all([
    probeKoobooApiMethod({
      apiOrigin,
      token: environment.token,
      path: 'AISandbox/TransferByLevel',
      signal,
      forceRefresh: options?.forceRefresh,
    }),
    probeKoobooApiMethod({
      apiOrigin,
      token: environment.token,
      path: 'AISandbox/ImportFromTemplate',
      signal,
      forceRefresh: options?.forceRefresh,
    }),
  ]);
  return {
    ...(environment.id ? { environmentId: environment.id } : {}),
    transferByLevel,
    importFromTemplate,
  };
}

/** Node's HTTP client also handles Kooboo's streamed JSON responses without undici parser failures. */
export function httpRead(url:URL,options:{token?:string;body?:unknown;signal:AbortSignal;limit?:number}) {
  return new Promise<{status:number;body:string}>((resolve,reject)=>{
    const body=options.body===undefined?undefined:JSON.stringify(options.body);
    const limit=options.limit||16*1024*1024;
    let settled=false;
    const finish=(fn:()=>void)=>{if(settled)return;settled=true;fn();};
    const request=(url.protocol==='https:'?https:http).request(url,{method:body?'POST':'GET',signal:options.signal,
      headers:{Connection:'close','Accept-Encoding':'gzip, deflate, br',...(options.token?{Authorization:`Bearer ${options.token}`}:{ }),...(body?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}:{})}},response=>{
      const status=response.statusCode||0;
      if(status===204||status===304){response.resume();finish(()=>resolve({status,body:''}));return;}
      const encoding=String(response.headers['content-encoding']||'').split(',')[0]!.trim().toLowerCase();
      const decoder=encoding==='gzip'||encoding==='x-gzip'?createGunzip():encoding==='deflate'?createInflate():encoding==='br'?createBrotliDecompress():null;
      const fail=(error:unknown)=>{const err=error instanceof Error?error:new Error(String(error));decoder?.destroy();request.destroy();finish(()=>reject(err));};
      if(decoder){response.on('error',fail);response.pipe(decoder);}
      const stream=decoder||response;
      let text='',bytesRead=0;
      stream.setEncoding('utf8');
      stream.on('data',(chunk:string)=>{
        bytesRead+=Buffer.byteLength(chunk);
        if(bytesRead>limit){const err=new Error('响应超过读取预算');decoder?.destroy(err);request.destroy(err);finish(()=>reject(err));return;}
        text+=chunk;
      });
      stream.on('end',()=>finish(()=>resolve({status,body:text})));
      stream.on('error',fail);
    });
    request.on('error',error=>finish(()=>reject(error)));
    request.end(body);
  });
}

export function isTransientKoobooReadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as Error).name;
  if (name === 'AbortError' || name === 'TimeoutError') return false;
  const code = String((error as NodeJS.ErrnoException).code || '').toUpperCase();
  if (['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET'].includes(code)) return true;
  const message = String((error as Error).message || '');
  return /socket hang up|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|Client network socket disconnected/i.test(message);
}

async function delayWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    signal.throwIfAborted();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const DEFAULT_READ_RETRY_DELAYS_MS = [500, 1500] as const;

export function koobooClient(task:Pick<AutomationTask,'environmentId'>,vault:Vault,signal:AbortSignal,options?:{retryDelaysMs?:readonly number[]}) {
  const environment=vault.get().environments.find(e=>e.id===task.environmentId);
  if(!environment?.token)throw new Error('缺少 Kooboo 环境令牌，请在系统设置补齐');
  const origin=new URL(environment.origin).origin,apiOrigin=new URL(environment.apiOrigin||origin).origin;
  const retryDelaysMs=options?.retryDelaysMs??DEFAULT_READ_RETRY_DELAYS_MS;
  const request=async(path:string,body?:unknown,siteId?:string):Promise<any>=>{
    const url=new URL(`/_api/v2/${path}`,apiOrigin);if(siteId)url.searchParams.set('SiteId',siteId);
    const canRetryRead=body===undefined;
    let result!:{status:number;body:string};
    for(let attempt=0;;attempt++){
      try{
        result=await httpRead(url,{token:environment.token,body,signal:AbortSignal.any([signal,AbortSignal.timeout(120000)])});
        break;
      }catch(error){
        if(!canRetryRead||signal.aborted||attempt>=retryDelaysMs.length||!isTransientKoobooReadError(error))throw error;
        await delayWithSignal(retryDelaysMs[attempt]!,signal);
      }
    }
    // ApiManager converts bool returns into Success, and v2 renders true as 200/null.
    // Decode this contract only for these read-only boolean checks; other null results stay null.
    const availability=body===undefined&&!siteId&&['Site/IsUniqueName','Site/IsSubdomainAvailable'].includes(path.split('?')[0]!);
    if(availability&&result.status===400){
      let messages:unknown;try{messages=JSON.parse(result.body);}catch{ /* Unknown failures remain errors. */ }
      if(Array.isArray(messages)&&messages.length===1&&typeof messages[0]==='string'
        && ['Api method define a bool return type and return false','Api 返回不正确'].includes(messages[0].replace(/\s+/g,' ').trim()))return false;
    }
    if(result.status<200||result.status>=300){
      const cleanPath=path.split('?')[0];
      if(isKoobooApiMethodNotFound(result.status,result.body)){
        throw new Error(`Kooboo ${cleanPath} 接口不存在（目标 Kooboo 环境版本过低，HTTP ${result.status}）`);
      }
      throw new Error(`Kooboo ${cleanPath} 请求失败（${result.status}）`);
    }
    const value=JSON.parse(result.body);
    return availability&&result.status===200&&value===null?true:value;
  };
  return {origin,environment,request};
}

export const siteIdentity=(site:any)=>typeof site==='string'?site.trim():String(site?.siteId||site?.SiteId||site?.id||site?.Id||'');

export type KoobooRequestFn = (path: string, body?: unknown, siteId?: string) => Promise<any>;
export type { KoobooTemplateSummary, KoobooTemplatePage };

export function resolveKoobooAssetUrl(raw: unknown, baseOrigin?: string): string {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('//') || value.startsWith('/')) {
    if (baseOrigin) {
      try {
        const resolved = new URL(value, baseOrigin);
        if (/^https?:$/i.test(resolved.protocol)) return resolved.href;
      } catch {
        // Fall through to protocol-relative check or raw string.
      }
    }
    if (value.startsWith('//')) return `https:${value}`;
  }
  return value;
}

export function normalizeKoobooTemplate(raw: any, baseOrigin?: string): KoobooTemplateSummary {
  const obj = raw && typeof raw === 'object' ? raw : {};
  return {
    id: String(obj.id ?? obj.Id ?? '').trim(),
    name: String(obj.name ?? obj.Name ?? '').trim(),
    typeName: String(obj.typeName ?? obj.TypeName ?? '').trim(),
    category: String(obj.category ?? obj.Category ?? '').trim(),
    description: String(obj.description ?? obj.Description ?? '').trim(),
    tags: String(obj.tags ?? obj.Tags ?? '').trim(),
    previewUrl: resolveKoobooAssetUrl(obj.previewUrl ?? obj.PreviewUrl ?? '', baseOrigin),
    thumbnailUrl: resolveKoobooAssetUrl(
      obj.thunbnailUrl ??
        obj.ThunbnailUrl ??
        obj.thumbnailUrl ??
        obj.ThumbnailUrl ??
        obj.thumbNail ??
        obj.ThumbNail ??
        '',
      baseOrigin,
    ),
    pageCount: Number(obj.pageCount ?? obj.PageCount ?? 0) || 0,
    layoutCount: Number(obj.layoutCount ?? obj.LayoutCount ?? 0) || 0,
    viewCount: Number(obj.viewCount ?? obj.ViewCount ?? 0) || 0,
    contentCount: Number(obj.contentCount ?? obj.ContentCount ?? 0) || 0,
    imageCount: Number(obj.imageCount ?? obj.ImageCount ?? 0) || 0,
    menuCount: Number(obj.menuCount ?? obj.MenuCount ?? 0) || 0,
    downloadCount: Number(obj.downloadCount ?? obj.DownloadCount ?? 0) || 0,
  };
}

export async function fetchKoobooTemplateDetail(
  request: KoobooRequestFn,
  templateId: string,
  baseOrigin?: string,
): Promise<KoobooTemplateSummary> {
  const id = String(templateId || '').trim();
  if (!id) throw new Error('模板 ID 不能为空');
  const raw = await request(`Template/Detail?Id=${encodeURIComponent(id)}`);
  const detail = normalizeKoobooTemplate(raw, baseOrigin);
  if (!raw || (!detail.id && !detail.name && !detail.previewUrl)) {
    throw new Error(`当前 Kooboo 环境未找到模板 ${id}`);
  }
  return { ...detail, id: detail.id || id };
}

export async function searchKoobooTemplates(
  request: KoobooRequestFn,
  options: {
    keyword?: string;
    pageNr?: number;
    pageSize?: number;
    typeName?: string;
    category?: string;
    color?: string;
    baseOrigin?: string;
  } = {},
): Promise<KoobooTemplatePage> {
  const pageNr = Math.max(1, Number(options.pageNr || 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(options.pageSize || 24) || 24));
  const raw = await request('Template/FullTextSearch', {
    keyword: String(options.keyword || '').trim(),
    pageNr,
    pageSize,
    typeName: options.typeName ?? 'Site',
    category: options.category ?? '',
    color: options.color ?? '',
  });
  const listRaw = Array.isArray(raw?.list ?? raw?.List) ? (raw.list ?? raw.List) : [];
  return {
    list: listRaw.map((item: any) => normalizeKoobooTemplate(item, options.baseOrigin)),
    totalCount: Number(raw?.totalCount ?? raw?.TotalCount ?? listRaw.length) || 0,
    pageNr: Number(raw?.pageNr ?? raw?.PageNr ?? pageNr) || pageNr,
    pageSize: Number(raw?.pageSize ?? raw?.PageSize ?? pageSize) || pageSize,
    totalPages: Number(raw?.totalPages ?? raw?.TotalPages ?? 1) || 1,
  };
}
export async function refreshSite(task:AutomationTask,store:AutomationStore,vault:Vault,signal:AbortSignal):Promise<GeneratedSite|undefined> {
  if(!task.generatedSiteId)return;
  const site=store.site(task.generatedSiteId);if(!site)return;
  const {request}=koobooClient(task,vault,signal),list=await request('Site/List');
  const actual=(Array.isArray(list)?list:[]).find(s=>siteIdentity(s).toLowerCase()===site.siteId.toLowerCase());
  const url=await publicSiteUrl(site,actual,request);
  if(typeof url==='string'&&/^https?:\/\//i.test(url)) {
    site.url=url;task.siteUrl=url;store.saveSite(site);store.put(task);
  }
  return site;
}

/** A newly added binding need not be Kooboo's first/default binding. */
export async function publicSiteUrl(site:GeneratedSite|undefined,actual:any,request:ReturnType<typeof koobooClient>['request']) {
  if(site?.preferredDomain){
    const bindings=await request('Binding/ListBySite',undefined,site.siteId);
    const binding=Array.isArray(bindings)&&bindings.find(item=>String(item.fullName||item.FullName||'').toLowerCase()===site.preferredDomain&&!Number(item.port??item.Port??0));
    if(!binding)throw new Error('已选择的站点域名绑定不存在，请重新绑定域名');
    const url=new URL(site.url);
    url.hostname=site.preferredDomain;url.port='';url.protocol=(binding.enableSsl??binding.EnableSsl)?'https:':'http:';
    return url.href;
  }
  return actual?.homePageLink||actual?.HomePageLink;
}

export async function probeSite(url:string,signal:AbortSignal) {
  if(!url)throw new Error('站点首页地址尚未取得');
  const initial=new URL(url);let current=initial;
  for(let count=0;count<5;count++) {
    // A site readiness probe never carries the environment bearer token.
    const result=await new Promise<{status:number;location?:string}>((resolve,reject)=>{
      const req=(current.protocol==='https:'?https:http).get(current,{signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),headers:{Connection:'close'}},response=>{
        response.resume();resolve({status:response.statusCode||0,location:response.headers.location});
      });req.on('error',reject);
    });
    if(result.status>=300&&result.status<400&&result.location){const next=new URL(result.location,current);if(next.hostname!==initial.hostname)throw new Error('首页重定向到了任务站点之外');current=next;continue;}
    if(result.status<200||result.status>=300)throw new Error(`站点首页暂不可访问（HTTP ${result.status}）`);
    return {url:current.href,status:result.status};
  }
  throw new Error('站点重定向次数过多');
}

export function summarizeMessages(messages:any[]) {
  const pending=new Map<string,string>();
  for(const message of messages)for(const content of message.contents||[]) {
    if(content.$type==='functionCall')pending.set(content.callId,content.name);
    if(content.$type==='functionResult')pending.delete(content.callId);
  }
  const last=messages.at(-1);
  return {messageCount:messages.length,pendingCalls:[...pending].map(([callId,name])=>({callId,name})),lastRole:last?.role,
    finalText:last?.role==='assistant'?(last.contents||[]).filter((c:any)=>c.$type==='text').map((c:any)=>c.text).join('').slice(-12000):'',
    // Raw histories may contain screenshots, base64 or enormous function results.
    messages:messages.slice(-20).map(m=>({id:m.messageId,role:m.role,time:m.createdAt,contents:(m.contents||[]).slice(-10).map((c:any)=>({
      type:c.$type,callId:c.callId,name:c.name,
      text:typeof c.text==='string'?c.text.slice(-3000):undefined,
      arguments:c.$type==='functionCall'?JSON.stringify(c.arguments||c.args||{}).slice(0,3000):undefined,
      result:c.$type==='functionResult'?JSON.stringify(c.result??c.content??{}).slice(-2000):undefined,
    }))})),};
}

export async function readConversation(task:AutomationTask,store:AutomationStore,vault:Vault,signal:AbortSignal) {
  const site=task.generatedSiteId&&store.site(task.generatedSiteId);if(!site)throw new Error('尚未关联生成站');
  const {request}=koobooClient(task,vault,signal);
  let id=task.generation?.conversationId;
  if(!id){
    const raw=await request('AIConversation/List',undefined,site.siteId);
    const conversations=(Array.isArray(raw)?raw:[]).filter(c=>Date.parse(c.createAt||c.CreateAt)>=task.createdAt-30000);
    if(conversations.length!==1)throw new Error('没有可唯一关联的原会话，不能猜测或重复发送委托');
    id=String(conversations[0].id||conversations[0].Id);task.generation={...task.generation,conversationId:id};store.put(task);
  }
  const raw=await request(`AIConversation/GetMessages?conversationId=${encodeURIComponent(id)}`,undefined,site.siteId);
  const summary=summarizeMessages(Array.isArray(raw)?raw:[]);
  task.context=JSON.stringify(summary).slice(-50000);store.put(task);
  return {conversationId:id,...summary};
}
