import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page } from 'playwright';
import { z } from 'zod';
import type { MaterialFile } from '../../shared/automation.js';

const action=z.object({action:z.enum(['snapshot','screenshot','navigate','click','fill','select','press']),role:z.enum(['target','reference','content']).default('target'),viewport:z.enum(['desktop','mobile']).default('desktop'),url:z.string().optional(),name:z.string().max(1000).optional(),element:z.string().max(100).optional(),value:z.string().max(10000).optional(),fullPage:z.boolean().default(false)});
/** A per-run browser session, kept outside the management UI and closed with the worker. */
export async function evaluationBrowser(urls:{target:string;reference:string;content:string},directory:string,signal:AbortSignal,initial:MaterialFile[]=[],checkpoint:(files:MaterialFile[])=>void=()=>{}){
  const allowed=new Set(Object.values(urls).filter(Boolean).map(u=>new URL(u).origin));
  signal.throwIfAborted();
  const browser=await chromium.launch({headless:true});
  const pages=new Map<string,Page>();
  const artifacts:MaterialFile[]=structuredClone(initial);
  let busy=false;
  const token=randomUUID()+randomUUID();
  const server=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    const finish=(status:number,body:unknown)=>{res.statusCode=status;res.end(JSON.stringify(body));};
    const auth=Buffer.from(req.headers.authorization||'');const expected=Buffer.from(`Bearer ${token}`);
    if(auth.length!==expected.length||!timingSafeEqual(auth,expected))return finish(401,{error:'Unauthorized'});
    if(busy)return finish(409,{error:'上一浏览器操作仍在执行，请顺序调用'});busy=true;
    try{
      let data='';for await(const chunk of req){data+=chunk;if(data.length>24000)throw new Error('请求过大');}
      const input=action.parse(JSON.parse(data));signal.throwIfAborted();
      if(!urls[input.role])throw new Error('没有提供此角色的站点');
      const key=input.role+'-'+input.viewport;let page=pages.get(key);
      if(!page){const mobile=input.viewport==='mobile';const context=await browser.newContext({viewport:{width:mobile?390:1440,height:mobile?844:1000},isMobile:mobile,hasTouch:mobile});
        await context.route('**/*',route=>{
          const request=route.request();
          if(request.isNavigationRequest()&&request.frame()===page?.mainFrame()&&new URL(request.url()).origin!==new URL(urls[input.role]).origin)return route.abort();
          return route.continue();
        });
        page=await context.newPage();pages.set(key,page);await page.goto(urls[input.role],{waitUntil:'domcontentloaded',timeout:45000});}
      if(input.action==='navigate'){if(!input.url||new URL(input.url).origin!==new URL(urls[input.role]).origin)throw new Error('只能访问当前任务的站点');await page.goto(input.url,{waitUntil:'domcontentloaded',timeout:45000});}
      else if(['click','fill','select','press'].includes(input.action)){
        if(!input.element||!input.name)throw new Error('请提供可访问角色 element 和名称 name');
        const locator=page.getByRole(input.element as Parameters<Page['getByRole']>[0],{name:input.name,exact:true});
        if(input.action==='click')await locator.click({timeout:15000});
        if(input.action==='fill')await locator.fill(input.value||'',{timeout:15000});
        if(input.action==='select')await locator.selectOption(input.value||'',{timeout:15000});
        if(input.action==='press')await locator.press(input.value||'Enter',{timeout:15000});
      }
      const file=randomUUID()+'.png';const pixels=await page.screenshot({path:resolve(directory,'evidence',file),fullPage:input.fullPage,timeout:20000});
      const snapshot=await page.locator('body').ariaSnapshot({timeout:15000});
      const text=await page.locator('body').innerText({timeout:15000});
      const observation={action:input.action,role:input.role,viewport:input.viewport,url:page.url(),title:await page.title(),file,capturedAt:Date.now(),snapshot:snapshot.slice(0,30000),text:text.slice(0,30000)};
      const textEvidence=Buffer.from(JSON.stringify(observation));const jsonFile=file.replace('.png','.json');
      writeFileSync(resolve(directory,'evidence',jsonFile),textEvidence,{mode:0o600});
      artifacts.push(...[{name:file,type:'image/png',bytes:pixels},{name:jsonFile,type:'application/json',bytes:textEvidence}].map(f=>({id:randomUUID(),name:f.name,type:f.type,size:f.bytes.length,sha256:createHash('sha256').update(f.bytes).digest('hex'),role:input.role,viewport:input.viewport})));
      checkpoint(structuredClone(artifacts));
      finish(200,{...observation,imagePath:resolve(directory,'evidence',file)});
    }catch(error){finish(400,{error:error instanceof Error?error.message:'浏览器操作失败'});}finally{busy=false;}
  });
  try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();if(!address||typeof address==='string')throw new Error('证据采集服务启动失败');
  const helper=`const response=await fetch(process.env.EVALUATION_BROWSER_URL,{method:'POST',headers:{Authorization:'Bearer '+process.env.EVALUATION_BROWSER_TOKEN,'Content-Type':'application/json'},body:process.argv[2]||'{}'});console.log(await response.text());if(!response.ok)process.exitCode=1;`;
  writeFileSync(resolve(directory,'browser.mjs'),helper,{mode:0o600});
  let closing:Promise<void>|undefined;
  const close=()=>closing??=(async()=>{signal.removeEventListener('abort',abort);server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await browser.close();})();
  const abort=()=>{void close().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});if(signal.aborted){await close();signal.throwIfAborted();}
  return {artifacts,env:{EVALUATION_BROWSER_URL:`http://127.0.0.1:${address.port}`,EVALUATION_BROWSER_TOKEN:token},close};
  }catch(error){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await browser.close();throw error;}
}
