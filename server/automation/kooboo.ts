import http from 'node:http';
import https from 'node:https';
import type { AutomationTask, GeneratedSite } from '../../shared/automation.js';
import type { Vault } from '../lib/vault.js';
import type { AutomationStore } from './store.js';

/** Node's HTTP client also handles Kooboo's streamed JSON responses without undici parser failures. */
export function httpRead(url:URL,options:{token?:string;body?:unknown;signal:AbortSignal;limit?:number}) {
  return new Promise<{status:number;body:string}>((resolve,reject)=>{
    const body=options.body===undefined?undefined:JSON.stringify(options.body);
    const request=(url.protocol==='https:'?https:http).request(url,{method:body?'POST':'GET',signal:options.signal,
      headers:{Connection:'close',...(options.token?{Authorization:`Bearer ${options.token}`}:{ }),...(body?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}:{})}},response=>{
      let text='';response.setEncoding('utf8');response.on('data',chunk=>{text+=chunk;if(Buffer.byteLength(text)>(options.limit||16*1024*1024))request.destroy(new Error('响应超过读取预算'));});
      response.on('end',()=>resolve({status:response.statusCode||0,body:text}));response.on('error',reject);
    });request.on('error',reject);request.end(body);
  });
}

export function koobooClient(task:Pick<AutomationTask,'environmentId'>,vault:Vault,signal:AbortSignal) {
  const environment=vault.get().environments.find(e=>e.id===task.environmentId);
  if(!environment?.token)throw new Error('缺少 Kooboo 环境令牌，请在系统设置补齐');
  const origin=new URL(environment.origin).origin,apiOrigin=new URL(environment.apiOrigin||origin).origin;
  const request=async(path:string,body?:unknown,siteId?:string):Promise<any>=>{
    const url=new URL(`/_api/v2/${path}`,apiOrigin);if(siteId)url.searchParams.set('SiteId',siteId);
    const result=await httpRead(url,{token:environment.token,body,signal:AbortSignal.any([signal,AbortSignal.timeout(120000)])});
    // ApiManager converts bool returns into Success, and v2 renders true as 200/null.
    // Decode this contract only for these read-only boolean checks; other null results stay null.
    const availability=body===undefined&&!siteId&&['Site/IsUniqueName','Site/IsSubdomainAvailable'].includes(path.split('?')[0]!);
    if(availability&&result.status===400){
      let messages:unknown;try{messages=JSON.parse(result.body);}catch{ /* Unknown failures remain errors. */ }
      if(Array.isArray(messages)&&messages.length===1&&typeof messages[0]==='string'
        && ['Api method define a bool return type and return false','Api 返回不正确'].includes(messages[0].replace(/\s+/g,' ').trim()))return false;
    }
    if(result.status<200||result.status>=300)throw new Error(`Kooboo ${path.split('?')[0]} 请求失败（${result.status}）`);
    const value=JSON.parse(result.body);
    return availability&&result.status===200&&value===null?true:value;
  };
  return {origin,environment,request};
}

export const siteIdentity=(site:any)=>String(site?.siteId||site?.SiteId||site?.id||site?.Id||'');
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
