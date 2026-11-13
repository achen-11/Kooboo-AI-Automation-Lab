import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Frame, type Page } from 'playwright';
import { inspectTemplateLayout } from './template-layout.js';
import { z } from 'zod';
import type { MaterialFile } from '../../shared/automation.js';
import { pageScreenshotPolicy, takePageScreenshots, type ScreenshotPosition, type ScreenshotReadiness, type ScreenshotReceipt } from './page-screenshots.js';

export const browserAction=z.object({action:z.enum(['inspect_layout','snapshot','screenshot','navigate','take_page_screenshots','click','fill','select','press']),role:z.enum(['target','reference','content']).default('target'),viewport:z.enum(['desktop','mobile']).default('desktop'),url:z.string().optional(),name:z.string().max(1000).optional(),element:z.string().max(100).optional(),value:z.string().max(10000).optional(),key:z.string().min(1).max(100).optional(),fullPage:z.boolean().default(false),safeReversible:z.boolean().default(false),scope:z.enum(['page','regions']).default('page'),selectors:z.array(z.string().min(1).max(500)).max(20).default([]),maxScreenshots:z.number().int().min(1).max(40).default(16),startY:z.number().int().min(0).max(10000000).default(0),startSelectorIndex:z.number().int().min(0).default(0),settleTimeoutMs:z.number().int().min(1000).max(10000).default(4000)}).superRefine((input,ctx)=>{
  if(input.action==='press'&&!input.value&&!input.key)ctx.addIssue({code:'custom',message:'press 需要 value 或 key 指定按键，不能默认触发 Enter',path:['value']});
  if(input.action==='press'&&input.value&&input.key&&input.value!==input.key)ctx.addIssue({code:'custom',message:'value 与 key 指定了不同按键',path:['key']});
  if(input.action==='take_page_screenshots'){
    if(input.fullPage)ctx.addIssue({code:'custom',message:'take_page_screenshots 不支持 fullPage',path:['fullPage']});
    if(input.scope==='page'&&(input.selectors.length||input.startSelectorIndex))ctx.addIssue({code:'custom',message:'page 范围不能指定 selectors',path:['selectors']});
    if(input.scope==='regions'&&(!input.selectors.length||input.startSelectorIndex>=input.selectors.length))ctx.addIssue({code:'custom',message:'regions 需要 selectors 和有效 startSelectorIndex',path:['selectors']});
  }
});
export const evaluationCapturePolicy=pageScreenshotPolicy;
export interface EvaluationBrowserBinding { taskId:string; siteRevision:string; inputVersionId?:string; sourceSnapshotId?:string; viewportEvidence?:boolean }
export interface VisibleBrowserFrame { url:string; text:string }

/** Runs in the containing frame, including ancestors outside a shadow root. */
export function visibleFrameElement(element:Element) {
  for(let current:Element|null=element;current;current=current.parentElement||(current.getRootNode() as ShadowRoot).host||null){
    const style=getComputedStyle(current);
    if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return false;
  }
  return true;
}

/** Frame contents remain separately attributed; hidden frames cannot supply visible proof. */
export async function visibleFrames(page:Page) {
  const frames:VisibleBrowserFrame[]=[];let complete=true,remaining=30000;
  for(const frame of page.frames()){
    if(frame===page.mainFrame())continue;
    try{
      let visible=true;
      for(let current:Frame|null=frame;current&&current!==page.mainFrame();current=current.parentFrame()){
        const element=await current.frameElement();
        try{if(!await element.isVisible()||!await element.evaluate(visibleFrameElement)){visible=false;break;}}finally{await element.dispose();}
      }
      if(!visible)continue;
      if(frames.length>=50){complete=false;break;}
      const text=await frame.locator('body').innerText({timeout:5000});
      if(text.length>remaining)complete=false;
      frames.push({url:frame.url(),text:text.slice(0,remaining)});remaining=Math.max(0,remaining-text.length);
    }catch{complete=false;}
  }
  return {frames,framesComplete:complete};
}
export interface PageSettlement { settled:boolean; loaded:boolean; networkIdle:boolean; images:number; pendingImages:number; blankImageRatio:number }
/** Serialized into the page; keep this function independent of host helpers. */
export async function settleVisibleImages(timeout:number){
  const visible=Array.from(document.images).filter(image=>{
    const box=image.getBoundingClientRect();
    if(box.width<=1||box.height<=1||box.bottom<=0||box.top>=window.innerHeight||box.right<=0||box.left>=window.innerWidth)return false;
    for(let current:Element|null=image;current;current=current.parentElement||(current.getRootNode() as ShadowRoot).host||null){
      const style=getComputedStyle(current);if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return false;
    }
    return true;
  });
  await Promise.race([Promise.all(visible.map(image=>image.complete?undefined:image.decode().catch(()=>{}))),new Promise(resolve=>setTimeout(resolve,timeout))]);
  await Promise.race([document.fonts?.ready,new Promise(resolve=>setTimeout(resolve,2000))]);
  return {images:visible.length,pending:visible.filter(image=>!image.complete).length,blank:visible.filter(image=>image.complete&&image.naturalWidth===0).length};
}
/** Lazy images, carousels and fonts arrive after DOMContentLoaded. Scrolling is only safe right after a navigation, before any interaction state exists. */
export async function settlePage(page:Page,scroll:boolean,quick=false):Promise<PageSettlement> {
  const loaded=await page.waitForLoadState('load',{timeout:quick?3000:15000}).then(()=>true,()=>false);
  const networkIdle=await page.waitForLoadState('networkidle',{timeout:quick?2000:8000}).then(()=>true,()=>false);
  if(scroll)await page.evaluate(async()=>{
    const start=window.scrollY,step=Math.max(200,window.innerHeight),end=Math.min(document.documentElement.scrollHeight,step*40);
    for(let y=0;y<end;y+=step){window.scrollTo(0,y);await new Promise(resolve=>setTimeout(resolve,150));}
    window.scrollTo(0,start);
  }).catch(()=>{});
  const stats=await page.evaluate(settleVisibleImages,quick?3000:5000);
  await page.waitForTimeout(1000);
  return {settled:loaded&&stats.pending===0,loaded,networkIdle,images:stats.images,pendingImages:stats.pending,blankImageRatio:stats.images?Math.round(stats.blank/stats.images*100)/100:0};
}
/** Popup / new-tab navigation requests arrive before Playwright creates their Frame, so request.frame() throws. */
export function shouldAbortNavigation(request:{isNavigationRequest():boolean;frame():Frame;url():string},allowedOrigin:string,mainFrame?:Frame|null):boolean {
  if(!request.isNavigationRequest())return false;
  let frame:Frame|null=null;
  try{frame=request.frame();}catch{frame=null;}
  const isTopLevel=frame===null||(mainFrame?frame===mainFrame:frame.parentFrame()===null);
  if(!isTopLevel)return false;
  try{
    const parsed=new URL(request.url());
    return (parsed.protocol!=='http:'&&parsed.protocol!=='https:')||parsed.origin!==allowedOrigin;
  }catch{return true;}
}

/** A per-run browser session, kept outside the management UI and closed with the worker. */
export async function evaluationBrowser(urls:{target:string;reference:string;content:string},directory:string,signal:AbortSignal,initial:MaterialFile[]=[],checkpoint:(files:MaterialFile[])=>void=()=>{},binding?:EvaluationBrowserBinding){
  const allowed=new Set(Object.values(urls).filter(Boolean).map(u=>new URL(u).origin));
  const trustedBinding=binding?{...binding,capturePolicy:evaluationCapturePolicy}:undefined;
  signal.throwIfAborted();
  const browser=await chromium.launch({headless:true});
  const pages=new Map<string,Page>();
  const artifacts:MaterialFile[]=structuredClone(initial);
  let busy=false;
  const token=randomUUID()+randomUUID();
  const capture=async(raw:unknown)=>{
      if(busy)throw new Error('上一浏览器操作仍在执行，请顺序调用');busy=true;
      try{const input=browserAction.parse(raw);signal.throwIfAborted();
      if(!urls[input.role])throw new Error('没有提供此角色的站点');
      if(binding?.viewportEvidence&&input.fullPage)throw new Error('AI Site 模板只允许逐屏取证，请使用 take_page_screenshots；禁止 fullPage');
      if(input.url){const url=new URL(input.url,urls[input.role]);if(url.origin!==new URL(urls[input.role]).origin||url.username||url.password)throw new Error('只能访问当前任务的站点');input.url=url.href;}
      const key=input.role+'-'+input.viewport;let page=pages.get(key),navigated=false,navigationStatus:number|undefined;
      if(!page){navigated=true;const mobile=input.viewport==='mobile',roleOrigin=new URL(urls[input.role]).origin;const context=await browser.newContext({viewport:{width:mobile?390:1440,height:mobile?844:1000},isMobile:mobile,hasTouch:mobile});
        await context.route('**/*',route=>{
          if(shouldAbortNavigation(route.request(),roleOrigin,page?.mainFrame()))return route.abort().catch(()=>{});
          return route.continue().catch(()=>{});
        });
        page=await context.newPage();pages.set(key,page);const initialUrl=['navigate','take_page_screenshots','inspect_layout'].includes(input.action)&&input.url?input.url:urls[input.role];navigationStatus=(await page.goto(initialUrl,{waitUntil:'domcontentloaded',timeout:45000}))?.status();}
      if(input.action==='navigate'||input.action==='take_page_screenshots'||input.action==='inspect_layout'){
        const url=input.url||(['take_page_screenshots','inspect_layout'].includes(input.action)?page.url():undefined);if(!url)throw new Error('navigate 需要 url');
        if((input.action!=='inspect_layout'||page.url()!==url)&&(input.action==='navigate'||input.startY===0||page.url()!==url)&&(!navigated||page.url()!==url)){navigationStatus=(await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000}))?.status();navigated=true;}
      }
      else if(['click','fill','select','press'].includes(input.action)){
        if(!input.element||!input.name)throw new Error('请提供可访问角色 element 和名称 name');
        const locator=page.getByRole(input.element as Parameters<Page['getByRole']>[0],{name:input.name,exact:true});
        if(input.safeReversible){
          if(input.action==='press'&&!['Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Tab','Shift+Tab'].includes(input.value||input.key||''))throw new Error('新流程仅允许安全导航按键，不能按 Enter 提交表单');
          const safe=await locator.evaluate(element=>{const html=element as HTMLInputElement;const label=(element.textContent||'')+' '+(element.getAttribute('aria-label')||'');if(/delete|remove|buy|purchase|pay|checkout|send|submit|logout|sign.?out|删除|移除|购买|支付|结算|发送|提交|退出/i.test(label))return false;if(element.closest('form')&&['submit','reset'].includes(html.type||'submit'))return false;if(element.tagName==='A'){const href=(element as HTMLAnchorElement).href;try{const url=new URL(href,location.href);return /^https?:$/.test(url.protocol)&&url.origin===location.origin&&!url.username&&!url.password;}catch{return false;}}return true;});
          if(!safe)throw new Error('无法确认此操作安全可逆，保留交互未验证');
        }
        if(input.action==='click')await locator.click({timeout:15000});
        if(input.action==='fill')await locator.fill(input.value||'',{timeout:15000});
        if(input.action==='select')await locator.selectOption(input.value||'',{timeout:15000});
        if(input.action==='press')await locator.press(input.value||input.key!,{timeout:15000});
      }
      if(input.action==='inspect_layout'){await page.evaluate(()=>window.scrollTo(0,0));const settlement=await settlePage(page,navigated);const layout=await inspectTemplateLayout(page,input.viewport);if(!settlement.settled){layout.dependencyHash=null;layout.dependencyGaps.push('测量时页面尚未稳定');}return layout;}
      const saveObservation=async(pixels:Buffer,settlement:PageSettlement,extra:Record<string,unknown>={})=>{
      const file=randomUUID()+'.png';writeFileSync(resolve(directory,'evidence',file),pixels,{mode:0o600});
      const snapshot=await page!.locator('body').ariaSnapshot({timeout:15000});
      const text=await page!.locator('body').innerText({timeout:15000});
      const frameEvidence=await visibleFrames(page!);
      const observation={action:input.action,role:input.role,viewport:input.viewport,url:page!.url(),title:await page!.title(),file,capturedAt:Date.now(),navigationStatus,snapshot:snapshot.slice(0,30000),text:text.slice(0,30000),textTruncated:text.length>30000,...frameEvidence,settlement,...extra,...(trustedBinding?{binding:trustedBinding}:{})};
      const textEvidence=Buffer.from(JSON.stringify(observation));const jsonFile=file.replace('.png','.json');
      writeFileSync(resolve(directory,'evidence',jsonFile),textEvidence,{mode:0o600});
      artifacts.push(...[{name:file,type:'image/png',bytes:pixels},{name:jsonFile,type:'application/json',bytes:textEvidence}].map(f=>({id:randomUUID(),name:f.name,type:f.type,size:f.bytes.length,sha256:createHash('sha256').update(f.bytes).digest('hex'),role:input.role,viewport:input.viewport,settled:settlement.settled})));
      checkpoint(structuredClone(artifacts));
      return {...observation,imagePath:resolve(directory,'evidence',file),...(settlement.settled?{}:{warning:`页面未稳定（仍有 ${settlement.pendingImages} 张可见图片未加载${settlement.loaded?'':'，load 未完成'}）：不能据此判断参考站缺少区段或图片。`})};
      };
      if(input.action==='take_page_screenshots'){
        const loaded=await page.waitForLoadState('load',{timeout:5000}).then(()=>true,()=>false);
        return await takePageScreenshots(page,input,signal,async(bytes:Buffer,position:ScreenshotPosition,readiness:ScreenshotReadiness,capture:ScreenshotReceipt['capture'])=>{
          const settlement:PageSettlement={settled:readiness.settled,loaded,networkIdle:false,images:readiness.images,pendingImages:readiness.pendingImages,blankImageRatio:readiness.images?readiness.brokenImages/readiness.images:0};
          const saved=await saveObservation(bytes,settlement,{position,readiness,capture});
          return {file:saved.file,url:saved.url,imagePath:saved.imagePath,role:saved.role,viewport:saved.viewport,position,readiness,settlement,capture};
        });
      }
      let settlement=await settlePage(page,navigated);
      // A reference capture can drive negative repair instructions, so it gets extra time before being labelled unsettled.
      for(let retry=0;input.role==='reference'&&!settlement.settled&&retry<2;retry++){await page.waitForTimeout(3000);settlement=await settlePage(page,false,true);}
      const pixels=await page.screenshot({fullPage:input.fullPage,timeout:20000});
      return await saveObservation(pixels,settlement);
      }finally{busy=false;}
  };
  const server=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    const finish=(status:number,body:unknown)=>{res.statusCode=status;res.end(JSON.stringify(body));};
    const auth=Buffer.from(req.headers.authorization||'');const expected=Buffer.from(`Bearer ${token}`);
    if(auth.length!==expected.length||!timingSafeEqual(auth,expected))return finish(401,{error:'Unauthorized'});
    try{let data='';for await(const chunk of req){data+=chunk;if(data.length>24000)throw new Error('请求过大');}
      finish(200,await capture(JSON.parse(data)));
    }catch(error){finish(400,{error:error instanceof Error?error.message:'浏览器操作失败'});}
  });
  try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();if(!address||typeof address==='string')throw new Error('证据采集服务启动失败');
  const helper=`const response=await fetch(process.env.EVALUATION_BROWSER_URL,{method:'POST',headers:{Authorization:'Bearer '+process.env.EVALUATION_BROWSER_TOKEN,'Content-Type':'application/json'},body:process.argv[2]||'{}'});console.log(await response.text());if(!response.ok)process.exitCode=1;`;
  writeFileSync(resolve(directory,'browser.mjs'),helper,{mode:0o600});
  let closing:Promise<void>|undefined;
  const close=()=>closing??=(async()=>{signal.removeEventListener('abort',abort);server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await browser.close();})();
  const abort=()=>{void close().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});if(signal.aborted){await close();signal.throwIfAborted();}
  return {artifacts,capture,env:{EVALUATION_BROWSER_URL:`http://127.0.0.1:${address.port}`,EVALUATION_BROWSER_TOKEN:token},close};
  }catch(error){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await browser.close();throw error;}
}
