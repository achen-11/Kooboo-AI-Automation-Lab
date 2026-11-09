import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import type { CollectionRun } from '../../../shared/collection.js';
import type { InputVersion } from '../../../shared/automation.js';
import { settlePage, type PageSettlement } from '../browser.js';
import { collectionHash, safeCollectionPath } from './runtime.js';
import type { CollectionStore } from './store.js';

export const sourceVisualIndexPath='site/visual/index.json' as const;
export const sourceVisualMaterial='collection/'+sourceVisualIndexPath;

export interface SourceVisualTemplate {
  id:string; urlTemplate:string; pages:number; samplePaths:string[]; html:string[];
  screens:({viewport:'desktop'|'mobile';path:string;foldPath?:string;url:string;width:number;height:number;clipped:boolean}&Pick<PageSettlement,'settled'|'pendingImages'|'blankImageRatio'>)[];
}
export interface SourceVisualIndex {
  version:1; collectionId:string; inputVersionId:string; sourceUrl:string; capturedAt:number;
  templates:SourceVisualTemplate[]; styles:{url:string;path?:string;size?:number;sha256?:string;error?:string}[]; limitations:string[];
}

/** A migration without a separate reference site keeps the source site's own appearance. */
export function sourceVisualRequired(input:Pick<InputVersion,'scenario'|'contentUrl'|'referenceUrl'>):boolean {
  if(input.scenario!=='migration'||!input.contentUrl)return false;
  if(!input.referenceUrl)return true;
  try{return new URL(input.referenceUrl).origin===new URL(input.contentUrl).origin;}catch{return false;}
}

const voidTags=new Set(['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr']);
/** Layout skeleton of the body: tags and first class names to a fixed depth, with repeated siblings collapsed. */
export function htmlSkeleton(html:string,maxDepth=4):string {
  const cleaned=html.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi,'');
  const start=cleaned.search(/<body\b/i),body=start>=0?cleaned.slice(start):cleaned,tokens:string[]=[];let depth=0;
  for(const match of body.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)){
    const closing=match[1]==='/',tag=match[2].toLowerCase(),attributes=match[3];
    if(tag==='body'){if(!closing)depth=0;continue;}
    if(closing){depth=Math.max(0,depth-1);continue;}
    if(depth<maxDepth){const name=/\bclass\s*=\s*["']?([^"'\s>]+)/i.exec(attributes)?.[1]?.replace(/\d+/g,'')||'',token='  '.repeat(depth)+tag+(name?'.'+name:'');if(tokens.at(-1)!==token)tokens.push(token);}
    if(!voidTags.has(tag)&&!attributes.trimEnd().endsWith('/'))depth++;
  }
  return tokens.join('\n');
}

interface PageRecord { id:string; url:string; path:string; rawFile:string; pageSlug?:string; depth?:number }
/** Pages sharing a skeleton form one template; the most common numeric-normalized path labels it. */
export function sourceTemplateClusters(pages:readonly (PageRecord&{html:string})[]){
  const clusters=new Map<string,(PageRecord&{html:string})[]>();
  for(const page of pages){const key=collectionHash(htmlSkeleton(page.html)).slice(0,12),members=clusters.get(key)||[];members.push(page);clusters.set(key,members);}
  return [...clusters].map(([key,members])=>{
    const ordered=[...members].sort((a,b)=>(a.depth??0)-(b.depth??0)||a.path.length-b.path.length||a.path.localeCompare(b.path));
    const counts=new Map<string,number>();for(const page of members){const template=page.path.replace(/\d+/g,'{n}');counts.set(template,(counts.get(template)||0)+1);}
    const urlTemplate=[...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0][0];
    return {id:key,urlTemplate,members:ordered};
  }).sort((a,b)=>b.members.length-a.members.length||a.urlTemplate.localeCompare(b.urlTemplate));
}

const safeName=(value:string)=>value.replace(/[^a-zA-Z0-9_.-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60)||'file';

/** Host-owned capture of the source appearance before freezing; failures are recorded, never invented. */
export async function captureSourceVisualBaseline(collections:CollectionStore,run:CollectionRun,options:{signal:AbortSignal;launch?:()=>Promise<Browser>;request?:typeof fetch;maxScreens?:number;maxTemplates?:number}):Promise<SourceVisualIndex> {
  if(run.status==='ready')throw new Error('已冻结来源不能新增视觉基线，应创建来源修订');
  const root=collections.workspace(run),state=collections.json(run,'.work/state.json') as {urls?:Record<string,PageRecord&{action?:string}>;stylesheets?:{url?:string;status?:string}[]};
  const source=new URL(run.sourceUrl),limitations:string[]=[];
  const pages=Object.values(state.urls||{}).filter(record=>record.action==='keep'&&typeof record.rawFile==='string'&&typeof record.url==='string').flatMap(record=>{try{return [{...record,html:collections.read(run,record.rawFile).toString('utf8')}];}catch{limitations.push('原始 HTML 缺失：'+record.url);return [];}});
  const folder='site/visual';rmSync(safeCollectionPath(root,folder),{recursive:true,force:true});
  for(const name of ['templates','screens','styles'])mkdirSync(safeCollectionPath(root,folder+'/'+name),{recursive:true,mode:0o700});
  const write=(path:string,bytes:Buffer|string)=>writeFileSync(safeCollectionPath(root,path),bytes,{mode:0o600});
  const clusters=sourceTemplateClusters(pages),maxTemplates=options.maxTemplates??30;
  if(clusters.length>maxTemplates)limitations.push(`共 ${clusters.length} 种页面骨架，只导出页数最多的 ${maxTemplates} 种；其余见各页原始资料。`);
  const templates:SourceVisualTemplate[]=clusters.slice(0,maxTemplates).map(cluster=>{
    const html=cluster.members.slice(0,2).map(page=>{const path=`${folder}/templates/${cluster.id}/${safeName(page.pageSlug||page.id)}.html`;mkdirSync(safeCollectionPath(root,`${folder}/templates/${cluster.id}`),{recursive:true,mode:0o700});write(path,page.html);return path;});
    return {id:cluster.id,urlTemplate:cluster.urlTemplate,pages:cluster.members.length,samplePaths:cluster.members.slice(0,5).map(page=>page.path),html,screens:[]};
  });
  const styles:SourceVisualIndex['styles']=[];
  for(const [index,row] of (state.stylesheets||[]).filter(row=>row?.status==='read'&&typeof row.url==='string').entries()){
    options.signal.throwIfAborted();
    try{
      const response=await (options.request||fetch)(row.url!,{signal:AbortSignal.any([options.signal,AbortSignal.timeout(30000)]),redirect:'follow'});
      const bytes=Buffer.from(await response.arrayBuffer());
      if(!response.ok||bytes.length>4*1024*1024||/^\s*<(!doctype|html)/i.test(bytes.subarray(0,64).toString()))throw new Error(response.ok?'不是有效 CSS 或超过 4 MiB':'HTTP '+response.status);
      const path=`${folder}/styles/${String(index+1).padStart(3,'0')}-${safeName(new URL(row.url!).pathname.split('/').pop()||'style.css')}`;
      write(path,bytes);styles.push({url:row.url!,path,size:bytes.length,sha256:collectionHash(bytes)});
    }catch(error){options.signal.throwIfAborted();styles.push({url:row.url!,error:error instanceof Error?error.message.slice(0,200):'读取失败'});}
  }
  if(styles.some(row=>row.error))limitations.push(`${styles.filter(row=>row.error).length} 个样式表未能取得原文，见 styles[].error。`);
  // The home page always gets screens; remaining budget goes to the largest templates.
  const maxScreens=options.maxScreens??12,home=templates.find(template=>template.samplePaths.includes('/'));
  const screened=[...new Set([...(home?[home]:[]),...templates])].slice(0,maxScreens);
  if(templates.length>screened.length)limitations.push(`只为 ${screened.length} 种模板截取代表页整页图；其余模板只有原始 HTML。`);
  let browser:Browser|undefined;
  try{
    browser=await (options.launch||(()=>chromium.launch({headless:true})))();
    for(const viewport of ['desktop','mobile'] as const){
      const mobile=viewport==='mobile',context=await browser.newContext({viewport:{width:mobile?390:1440,height:mobile?844:1000},isMobile:mobile,hasTouch:mobile});
      await context.route('**/*',route=>{const request=route.request();if(request.isNavigationRequest()&&request.frame().parentFrame()===null&&new URL(request.url()).origin!==source.origin)return route.abort();return route.continue();});
      try{
        for(const template of screened){
          options.signal.throwIfAborted();
          const url=new URL(template.samplePaths[0],source).href,page=await context.newPage();
          try{
            await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
            const settlement=await settlePage(page,true),height=await page.evaluate(()=>document.documentElement.scrollHeight).catch(()=>0),width=mobile?390:1440,clipped=height>12000;
            const bytes=await page.screenshot(clipped?{clip:{x:0,y:0,width,height:12000},fullPage:true,timeout:30000}:{fullPage:true,timeout:30000});
            const path=`${folder}/screens/${template.id}-${viewport}.png`;write(path,bytes);
            let foldPath:string|undefined;
            if(!mobile){await page.evaluate(()=>window.scrollTo(0,0)).catch(()=>{});foldPath=`${folder}/screens/${template.id}-desktop-fold.png`;write(foldPath,await page.screenshot({fullPage:false,timeout:30000}));}
            template.screens.push({viewport,path,...(foldPath?{foldPath}:{}),url,width,height:Math.min(height,12000),clipped,settled:settlement.settled,pendingImages:settlement.pendingImages,blankImageRatio:settlement.blankImageRatio});
            if(!settlement.settled)limitations.push(`${template.urlTemplate} ${viewport} 截图时仍有 ${settlement.pendingImages} 张可见图片未加载，不能据此判断原站缺少该图片或区段。`);
          }catch(error){options.signal.throwIfAborted();limitations.push(`${template.urlTemplate} ${viewport} 截图失败：${error instanceof Error?error.message.slice(0,160):'未知错误'}`);}
          finally{await page.close().catch(()=>{});}
        }
      }finally{await context.close().catch(()=>{});}
    }
  }catch(error){options.signal.throwIfAborted();limitations.push('来源视觉截图未完成：'+(error instanceof Error?error.message.slice(0,200):'浏览器不可用'));}
  finally{await browser?.close().catch(()=>{});}
  const index:SourceVisualIndex={version:1,collectionId:run.id,inputVersionId:run.inputVersionId,sourceUrl:run.sourceUrl,capturedAt:Date.now(),templates,styles,limitations};
  write(sourceVisualIndexPath,JSON.stringify(index,null,2));
  return index;
}

export function sourceVisualEvaluationContract(files:readonly {name:string}[]):string {
  if(!files.some(file=>file.name===sourceVisualMaterial))return '';
  return `\n冻结来源含原站视觉基线 materials/${sourceVisualMaterial}：按页面模板列出代表页的桌面/移动整页截图、原始 HTML 和 CSS 原文（文件映射见 materials-manifest.json）。本场景的参考外观就是原站，冻结基线是判断版式、配色、字体和组件还原度的权威依据；现场参考截图未稳定、原站已改版或与基线冲突时，以基线为准，settled=false 的基线截图同样不能证明原站缺少某区段或图片。基线文件不作为 evidence 文件名填写，evidence 仍引用本轮实际截取的 target/reference PNG；基线也不能代替目标站的真实截图。\n`;
}

/** First-screen desktop images for the initial generation delegate, home page first. */
export function sourceVisualFoldImages(index:Pick<SourceVisualIndex,'templates'>,limit=6){
  const ordered=[...index.templates].sort((a,b)=>Number(b.samplePaths.includes('/'))-Number(a.samplePaths.includes('/')));
  return ordered.flatMap(template=>template.screens.filter(screen=>screen.viewport==='desktop'&&screen.foldPath).map(screen=>({urlTemplate:template.urlTemplate,url:screen.url,path:screen.foldPath!,settled:screen.settled}))).slice(0,limit);
}

export function sourceVisualGuidance(index:Pick<SourceVisualIndex,'templates'|'styles'>):string {
  return `\n\n视觉基线：collection/${sourceVisualIndexPath} 列出原站 ${index.templates.length} 种页面模板（代表页原始 HTML、桌面/移动整页截图）和 ${index.styles.filter(row=>row.path).length} 个 CSS 原文。本次迁移以原站外观为准：版式、配色、字体、间距和组件按这些依据还原，同一模板的页面共用同一实现；不要另起设计系统，也不要因为资料包其他说明“不含版式”而自行设计。截图与 CSS 只作视觉依据，不作为站点素材上传；内容仍以逐页资料为准。`;
}
