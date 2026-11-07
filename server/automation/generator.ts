import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AutomationTask, GeneratedSite } from '../../shared/automation.js';
import type { AutomationStore } from './store.js';
import type { Vault } from '../lib/vault.js';
import { Pending, UnconfirmedStop } from './errors.js';

async function delay(ms:number,signal:AbortSignal){await new Promise<void>((r,j)=>{signal.throwIfAborted();const done=()=>{signal.removeEventListener('abort',abort);r();};const timer=setTimeout(done,ms);const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);j(signal.reason);};signal.addEventListener('abort',abort,{once:true});});}

/** Existing Kooboo APIs + the existing frontend stream/function loop. No server generation API is introduced. */
export async function executeGeneration(task:AutomationTask,store:AutomationStore,vault:Vault,directory:string,signal:AbortSignal){
  const settings=vault.get();const environment=settings.environments.find(e=>e.id===task.environmentId);const input=store.version(task.versionId);
  if(!environment?.token||!input)throw new Error('缺少 Kooboo 环境令牌或输入版本，请先在设置中配置');
  const origin=new URL(environment.origin).origin;const apiOrigin=new URL(environment.apiOrigin||origin).origin;
  const request=async(path:string,body?:unknown,siteId?:string):Promise<any>=>{
    const url=new URL(`/_api/v2/${path}`,apiOrigin);if(siteId)url.searchParams.set('SiteId',siteId);
    const response=await fetch(url,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${environment.token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.any([signal,AbortSignal.timeout(120000)])});
    if(!response.ok)throw new Error(`Kooboo ${path.split('?')[0]} 请求失败（${response.status}）`);return response.json();
  };
  let site=task.generatedSiteId?store.site(task.generatedSiteId):undefined;
  const continuation=!!site;
  if(!site){
    const slug=`auto-${task.id.slice(0,12)}`;
    const domains=await request('Domain/Available');
    const domainList=Array.isArray(domains)?domains:[];
    const root=domainList.map((d:any)=>typeof d==='string'?d:d.domainName||d.domain||d.name||d.rootDomain).find((d:unknown)=>typeof d==='string'&&d);
    if(!root)throw new Error('Kooboo 未返回可用根域名，请核对连接环境');
    store.event(task.id,`准备新站 ${slug}；创建结果不确定时停止，不自动重发创建请求`);
    let created:any;
    try{
      created=task.scenario==='upgrade'
        ?await request('Transfer/ByLevel',{siteName:slug,subDomain:slug,rootDomain:root,url:input.contentUrl,headless:false,convertToRoot:false,TotalPages:20,Depth:2})
        :await request('Site/Create',{SiteName:slug,SubDomain:slug,RootDomain:root,SiteType:'p'});
    }catch{throw new Pending(`新站 ${slug} 创建结果未确认，请在 Kooboo 检查后将实际站点关联到此资源，禁止自动重复建站。`);}
    const siteId=String(created?.siteId||created?.id||created?.Id||'');
    if(!/^[a-f0-9-]{36}$/i.test(siteId)||/^00000000-0000-0000-0000-000000000000$/i.test(siteId))throw new Pending(`新站 ${slug} 未返回有效身份，请检查 Kooboo 实际站点。`);
    site={id:randomUUID(),resourceId:task.resourceId,versionId:task.versionId,environmentId:task.environmentId,siteId,name:slug,url:'',createdAt:Date.now()};
    store.saveSite(site);task.generatedSiteId=site.id;store.put(task);store.event(task.id,`已绑定生成站 ${siteId}`);
    if(task.scenario==='upgrade'){
      const taskId=created.taskId;if(!taskId)throw new Pending('内容站克隆未返回任务标识，请检查实际克隆状态');
      let previous=-1,stable=0;
      while(stable<2){
        signal.throwIfAborted();
        const status=await request(`Transfer/GetStatus?id=${encodeURIComponent(taskId)}`,undefined,siteId);
        const pages=Array.isArray(status)?status:[];const done=pages.length>0&&pages.every((p:any)=>p.done===true);
        stable=done&&previous===pages.length?stable+1:0;previous=pages.length;await delay(2000,signal);
      }
      const status=await request('Transfer/GetTaskStatus',undefined,siteId);if(!status?.pages)throw new Pending('内容站克隆未确认有页面导入，需检查原站与目标站');
      store.event(task.id,'内容站克隆完成；参考站由 Kooboo AI 使用 Sandbox tools 准备');
    }
  }
  if(!site)throw new Error('没有可执行的生成站');
  // Materials are copied into the chosen target; no mandatory README or naming convention.
  const uploaded:string[]=[];
  for(const file of input.files){
    signal.throwIfAborted();const bytes=readFileSync(resolve(directory,'materials',file.id));
    const filename=file.name.replaceAll('\\','/').split('/').at(-1)||file.id;
    if(/\.(md|txt|json|csv|ya?ml|html?|css|js|ts|xml|svg)$/i.test(file.name)){
      const path=`_materials/${task.resourceId}/${file.name}`;
      const response=await request('AI/CallFunction',{name:'run_kscript',callId:randomUUID(),arguments:{code:`k.file.write(${JSON.stringify(path)}, ${JSON.stringify(bytes.toString('utf8'))}); return true;`}},site.siteId);
      const content=response?.contents?.[0];if(!content||content.isError||content.result?.error||content.result===false)throw new Error(`资料写入未确认：${file.name}`);
      uploaded.push(`${file.name} → kfile:${path}`);
    }else{
      const form=new FormData();form.append('Folder',`materials/${task.resourceId}`);form.append('file',new Blob([bytes],{type:file.type}),`${file.id}-${filename}`);
      const url=new URL('/_api/v2/Upload/File',apiOrigin);url.searchParams.set('SiteId',site.siteId);
      const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${environment.token}`},body:form,signal});
      if(!response.ok)throw new Error(`上传资料失败：${file.name}`);uploaded.push(`${file.name} → /materials/${task.resourceId}/${file.id}-${filename}`);
    }
  }
  if(uploaded.length){task.message+='\n\n已导入资料位置：\n'+uploaded.join('\n');store.put(task);}
  const sites=await request('Site/List');const actual=(Array.isArray(sites)?sites:[]).find((s:any)=>String(s.id||s.Id)===site!.siteId);
  const publicUrl=actual?.homePageLink||actual?.HomePageLink;
  if(typeof publicUrl==='string'&&/^https?:\/\//.test(publicUrl)){site.url=publicUrl;task.siteUrl=publicUrl;store.saveSite(site);store.put(task);}
  const browser=await chromium.launch({headless:false});
  try{
    const context=await browser.newContext();await context.addCookies([{name:'jwt_token',value:environment.token,url:origin,httpOnly:false,secure:origin.startsWith('https:')}]);
    const page=await context.newPage();
    const url=new URL('/_Admin/ai-chat/overview',origin);url.searchParams.set('SiteId',site.siteId);if(!continuation)url.searchParams.set('starterSiteCreated','1');
    await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:60000});
    // Freeform materials may exceed the server URL limit. Send the message through
    // the existing editor instead of putting it into a long query string.
    const editor=page.locator('.composer-editor [contenteditable="true"]');
    await editor.waitFor({state:'visible',timeout:90000});await editor.fill(task.message);
    const previousTurns=await page.locator('.chat-turn[data-turn-id]').evaluateAll(elements=>elements.map(e=>e.getAttribute('data-turn-id')));
    const button=page.locator('.send-btn.is-active');await button.waitFor({state:'visible',timeout:90000});
    const sendDeadline=Date.now()+90000;while(!await button.isEnabled()){if(Date.now()>sendDeadline)throw new Pending('发送按钮未就绪，请检查登录与会话');await delay(500,signal);}
    signal.throwIfAborted();await button.click();store.event(task.id,'已提交委托，Kooboo AI Chat 正在驱动 streamChat / function-call loop');
    let turnId='';let sawRunning=false;let idleSince=Date.now();let lastSaved=0;
    while(true){
      signal.throwIfAborted();
      if(page.isClosed())throw new Pending('执行页已关闭，需要检查原会话再跟进');
      const state=await page.evaluate(()=>{
        const turns=Array.from(document.querySelectorAll('.chat-turn[data-turn-id]'));const last=turns.at(-1);const pending=document.querySelector('.ai-user-input-message:not(.answered),.ai-function-approval-dialog');
        return {id:last?.getAttribute('data-turn-id')||'',status:last?.getAttribute('data-turn-status')||'',running:!!document.querySelector('.stop-btn'),pending:pending?.textContent?.trim().slice(0,12000)||'',error:document.querySelector('.message-bubble--error,.message-error-tag')?.textContent?.trim().slice(0,3000)||'',context:last?.textContent?.trim().slice(-24000)||''};
      });
      if(state.id&&!previousTurns.includes(state.id)){
        if(turnId&&turnId!==state.id)throw new Pending('会话出现另一轮执行，需要检查当前状态');
        if(!turnId){turnId=state.id;task.threadId=turnId;store.put(task);}
      }
      task.context=state.context;
      if(Date.now()-lastSaved>5000){store.put(task);lastSaved=Date.now();}
      if(state.pending)throw new Pending(state.pending);
      if(state.error&&turnId&&state.id===turnId)throw new Error(state.error);
      if(turnId&&state.id===turnId&&state.status==='completed'){store.event(task.id,'Kooboo 本轮执行已结束；质量需独立评测');return;}
      if(turnId&&state.id===turnId&&['failed','cancelled'].includes(state.status))throw new Pending('Kooboo 本轮执行中断，需要跟进检查');
      if(state.running){sawRunning=true;idleSince=Date.now();}
      if(!state.running&&sawRunning&&Date.now()-idleSince>30000)throw new Pending('执行页已停止，但没有取得可信终态，需要检查原会话');
      await delay(1000,signal);
    }
  }finally{try{await browser.close();}catch{throw new UnconfirmedStop('无法确认生成执行窗口已关闭，请检查原执行后确认停止');}}
}
