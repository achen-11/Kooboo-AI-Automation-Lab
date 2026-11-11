import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';

export const pageScreenshotPolicy='viewport-evidence-pc1440-mobile390-v3';
export interface PageScreenshotOptions {
  scope:'page'|'regions'; selectors:string[]; startY:number; startSelectorIndex:number;
  maxScreenshots:number; settleTimeoutMs:number;
}
export interface ScreenshotPosition {
  url:string; scrollX:number; scrollY:number; documentHeight:number; viewportWidth:number; viewportHeight:number;
  matches:number; invalidSelector:boolean; visible:boolean; nestedScroll:boolean; horizontalOverflow:boolean; regionTop:number; regionBottom:number;
}
export interface ScreenshotReadiness { settled:boolean; images:number; pendingImages:number; brokenImages:number; runningAnimations:number; fontsReady:boolean; stableForMs:number }
export interface ScreenshotReceipt {
  file:string; url:string; position:ScreenshotPosition; readiness:ScreenshotReadiness;
  settlement:{settled:boolean}; capture:{id:string;index:number;scope:'page'|'regions';policy:string;selector?:string;selectorIndex?:number};
}
export interface PageScreenshotsReceipt {
  action:'take_page_screenshots'; status:'complete'|'partial'|'failed'; coverageComplete:boolean;
  screenshots:ScreenshotReceipt[]; gaps:string[]; nextStartY:number|null; nextSelectorIndex:number|null;
}

export function screenshotRangeCovered(positions:ScreenshotPosition[],startY=0){
  if(!positions.length)return false;
  let bottom=startY;
  for(const p of positions){
    if(!Number.isFinite(p.scrollY)||p.scrollY<0||p.viewportHeight<=0||p.viewportWidth<=0||p.documentHeight<p.viewportHeight||p.scrollY>bottom+1)return false;
    bottom=Math.max(bottom,p.scrollY+p.viewportHeight);
  }
  return bottom>=positions.at(-1)!.documentHeight-1;
}

/** Runs in the page. JS text counters reset the quiet window even with unchanged geometry. */
export async function waitForScreenshotContent(timeout:number):Promise<ScreenshotReadiness> {
  const start=performance.now();
  const intersects=(r:DOMRect)=>r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth;
  const inViewport=(element:Element)=>intersects(element.getBoundingClientRect());
  const visible=(element:Element)=>{
    if(!inViewport(element))return false;
    for(let current:Element|null=element;current;current=current.parentElement||(current.getRootNode() as ShadowRoot).host||null){
      const style=getComputedStyle(current);
      if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return false;
    }
    return true;
  };
  let previous='',lastChange=start,result:ScreenshotReadiness;
  do {
    await new Promise(resolve=>setTimeout(resolve,100));
    const images=Array.from(document.images).filter(visible);
    const animations=document.getAnimations().filter(animation=>{
      const effect=animation.effect as KeyframeEffect|null,target=effect?.target;
      return animation.playState==='running'&&target instanceof Element&&inViewport(target)&&Number.isFinite(effect!.getComputedTiming().endTime);
    });
    const text:string[]=[],walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),range=document.createRange();
    let node:Node|null;
    while((node=walker.nextNode())){
      if(!node.textContent?.trim()||!node.parentElement||!visible(node.parentElement))continue;
      range.selectNodeContents(node);
      if(Array.from(range.getClientRects()).some(intersects))text.push(node.textContent);
    }
    const layout=Array.from(document.querySelectorAll('body > *, section, h1, h2, h3, img')).filter(inViewport).slice(0,200).map(element=>{
      const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
      return [Math.round(rect.x),Math.round(rect.y),Math.round(rect.width),Math.round(rect.height),style.opacity,style.visibility,(element as HTMLImageElement).currentSrc];
    });
    const signature=JSON.stringify([layout,text]),now=performance.now();
    if(signature!==previous)lastChange=now;previous=signature;
    result={settled:false,images:images.length,pendingImages:images.filter(i=>!i.complete).length,brokenImages:images.filter(i=>i.complete&&i.naturalWidth===0).length,runningAnimations:animations.length,fontsReady:!document.fonts||document.fonts.status==='loaded',stableForMs:Math.floor(now-lastChange)};
    result.settled=now-start>=600&&result.stableForMs>=500&&!result.pendingImages&&!result.brokenImages&&!result.runningAnimations&&result.fontsReady;
    if(result.settled)break;
  }while(performance.now()-start<timeout);
  return result;
}

/** Main-document coordinates are recorded after settlement, including browser clamping. */
export function screenshotPosition(selector:string|null):ScreenshotPosition {
  const root=document.documentElement,body=document.body;
  const result:ScreenshotPosition={url:location.href,scrollX,scrollY,documentHeight:Math.max(root.scrollHeight,body?.scrollHeight||0,innerHeight),viewportWidth:innerWidth,viewportHeight:innerHeight,horizontalOverflow:root.scrollWidth>innerWidth+1,matches:0,invalidSelector:false,visible:false,nestedScroll:false,regionTop:0,regionBottom:0};
  if(selector){
    let matches:NodeListOf<Element>;
    try{matches=document.querySelectorAll(selector);}catch{return {...result,invalidSelector:true};}
    result.matches=matches.length;
    if(matches.length===1){
      const element=matches[0],rect=element.getBoundingClientRect();
      result.regionTop=rect.top+scrollY;result.regionBottom=rect.bottom+scrollY;
      result.visible=rect.width>0&&rect.height>0&&rect.bottom>0&&rect.top<innerHeight&&rect.right>0&&rect.left<innerWidth;
      for(let parent:Element|null=element;parent;parent=parent.parentElement){
        const style=getComputedStyle(parent);
        if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0)result.visible=false;
        if(parent!==element&&parent!==root&&parent!==body&&/auto|scroll/.test(style.overflowY)&&parent.scrollHeight>parent.clientHeight+1)result.nestedScroll=true;
      }
    }
  }
  return result;
}

export async function scrollForScreenshot(target:number){
  const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
  let last=-1;
  for(let i=0;i<100&&Math.abs(window.scrollY-target)>innerHeight;i++){
    if(Math.abs(window.scrollY-last)<1)break;last=window.scrollY;
    window.scrollTo({top:window.scrollY+Math.sign(target-window.scrollY)*innerHeight*.85,behavior:'instant'});await pause(100);
  }
  window.scrollTo({top:target,behavior:'instant'});await pause(100);
}

/** Save every scrolled viewport immediately; a limit or interruption never becomes complete coverage. */
export async function takePageScreenshots(page:Pick<Page,'evaluate'|'screenshot'>,options:PageScreenshotOptions,signal:AbortSignal,save:(bytes:Buffer,position:ScreenshotPosition,readiness:ScreenshotReadiness,capture:ScreenshotReceipt['capture'])=>Promise<ScreenshotReceipt>,now=Date.now):Promise<PageScreenshotsReceipt> {
  const result:PageScreenshotsReceipt={action:'take_page_screenshots',status:'failed',coverageComplete:false,screenshots:[],gaps:[],nextStartY:null,nextSelectorIndex:null};
  const id=randomUUID(),started=now();let nextY=options.startY,selectorIndex=options.startSelectorIndex;
  const gap=(text:string)=>{if(!result.gaps.includes(text))result.gaps.push(text);};
  const regionValid=(s:ScreenshotPosition,selector:string)=>{
    const reason=s.invalidSelector?'invalid selector':s.matches!==1?`matched ${s.matches} elements`:s.nestedScroll?'nested scrolling is unsupported':s.regionBottom<=s.regionTop?'no rendered height':'';
    if(reason)gap(`Region ${selector}: ${reason}`);return !reason;
  };
  try{
    if(options.scope==='regions')await page.evaluate(waitForScreenshotContent,options.settleTimeoutMs);
    const count=options.scope==='regions'?options.selectors.length:1;
    for(;selectorIndex<count;selectorIndex++){
      signal.throwIfAborted();const selector=options.scope==='regions'?options.selectors[selectorIndex]:null;
      const initial=await page.evaluate(screenshotPosition,selector);
      if(selector&&!regionValid(initial,selector))continue;
      nextY=selector?Math.max(initial.regionTop,selectorIndex===options.startSelectorIndex?options.startY:0):options.startY;
      let previousY=-1;
      while(true){
        signal.throwIfAborted();
        if(result.screenshots.length>=options.maxScreenshots||now()-started>=120000){result.nextStartY=Math.ceil(nextY);result.nextSelectorIndex=selector?selectorIndex:null;return {...result,status:result.screenshots.length?'partial':'failed'};}
        await page.evaluate(scrollForScreenshot,nextY);
        const readiness=await page.evaluate(waitForScreenshotContent,options.settleTimeoutMs),position=await page.evaluate(screenshotPosition,selector);
        if(selector&&!regionValid(position,selector))break;
        if(previousY>=0&&position.scrollY<=previousY+1){gap('Scrolling did not advance; remaining coverage is unverified.');break;}
        if(selector&&!position.visible){gap(`Region ${selector} remained hidden after waiting.`);break;}
        const bytes=await page.screenshot({type:'png',fullPage:false,timeout:20000});
        if(!bytes.length)throw new Error('No screenshot bytes');
        result.screenshots.push(await save(bytes,position,readiness,{id,index:result.screenshots.length+1,scope:options.scope,policy:pageScreenshotPolicy,...(selector?{selector,selectorIndex}:{})}));
        previousY=position.scrollY;
        if(!readiness.settled)gap(`Screenshot ${result.screenshots.length} did not settle: ${readiness.pendingImages} pending images, ${readiness.brokenImages} broken images, ${readiness.runningAnimations} running finite animations, fontsReady=${readiness.fontsReady}, stableForMs=${readiness.stableForMs}.`);
        if(position.horizontalOverflow)gap('Horizontal overflow was not captured.');
        if(position.scrollY+position.viewportHeight>=(selector?position.regionBottom:position.documentHeight)-1)break;
        nextY=Math.min(Math.max(0,position.documentHeight-position.viewportHeight),position.scrollY+position.viewportHeight*.85);
        if(nextY<=position.scrollY+1){gap('Document stopped before the requested range was covered.');break;}
      }
    }
    if(options.scope==='page'&&!screenshotRangeCovered(result.screenshots.map(s=>s.position),options.startY))gap('Actual viewport intervals did not cover the requested remaining page range.');
    result.coverageComplete=result.gaps.length===0;
  }catch{
    signal.throwIfAborted();gap('Collection interrupted; saved viewports remain available.');result.nextStartY=Math.ceil(nextY);result.nextSelectorIndex=options.scope==='regions'?selectorIndex:null;
  }
  result.status=result.coverageComplete?'complete':result.screenshots.length?'partial':'failed';return result;
}
