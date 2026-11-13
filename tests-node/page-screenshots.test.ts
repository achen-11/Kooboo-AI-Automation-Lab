import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { chromium, type Page } from 'playwright';
import { browserAction, evaluationBrowser } from '../server/automation/browser.js';
import { pageScreenshotPolicy, screenshotPosition, scrollForScreenshot, waitForScreenshotContent, takePageScreenshots, screenshotRangeCovered, type PageScreenshotOptions, type ScreenshotPosition, type ScreenshotReadiness, type ScreenshotReceipt, type PageScreenshotsReceipt } from '../server/automation/page-screenshots.js';

const options=(overrides:Partial<PageScreenshotOptions>={}):PageScreenshotOptions=>({scope:'page',selectors:[],startY:0,startSelectorIndex:0,maxScreenshots:16,settleTimeoutMs:4000,...overrides});
const ready:ScreenshotReadiness={settled:true,images:1,pendingImages:0,brokenImages:0,runningAnimations:0,fontsReady:true,stableForMs:500};
class FakePage {
  y=0; width=1440; height=1000; documentHeight=3000; url='https://target.test/'; settled=true; stalled=false; screenshots=0;failAfter=Infinity;
  events:string[]=[]; regions=new Map<string,{top:number;bottom:number;matches?:number;nested?:boolean;visible?:boolean}>();
  async evaluate(fn:unknown,arg:any){
    if(fn===scrollForScreenshot){this.events.push('scroll');if(!this.stalled)this.y=Math.round(Math.max(0,Math.min(arg,this.documentHeight-this.height)));return;}
    if(fn===waitForScreenshotContent){this.events.push('settle');return {...ready,settled:this.settled};}
    assert.equal(fn,screenshotPosition);
    const region=this.regions.get(arg);
    return {url:this.url,scrollX:0,scrollY:this.y,documentHeight:this.documentHeight,viewportWidth:this.width,viewportHeight:this.height,horizontalOverflow:false,matches:region?.matches??(region?1:0),invalidSelector:false,nestedScroll:region?.nested??false,visible:region?.visible??true,regionTop:region?.top??0,regionBottom:region?.bottom??0} satisfies ScreenshotPosition;
  }
  async screenshot(input:{fullPage?:boolean}){assert.equal(input.fullPage,false,'no full-page capture or slicing');this.events.push('screenshot');if(this.screenshots++>=this.failAfter)throw new Error('capture interrupted');return Buffer.from('real viewport fixture bytes');}
}
async function collect(page:FakePage,input:Partial<PageScreenshotOptions>={}){
  const frames:ScreenshotReceipt[]=[];
  const result=await takePageScreenshots(page as unknown as Page,options(input),new AbortController().signal,async(_bytes,position,readiness,capture)=>{
    const frame={file:randomUUID()+'.png',url:position.url,position,readiness,settlement:{settled:readiness.settled},capture};frames.push(frame);return frame;
  });
  return {result,frames};
}

test('each viewport is scrolled and settled before capture; continuation follows the real cursor',async()=>{
  const page=new FakePage();
  const first=await collect(page,{maxScreenshots:2});
  assert.equal(first.result.status,'partial');assert.equal(first.result.coverageComplete,false);assert.equal(first.result.nextStartY,1700);
  assert.deepEqual(first.frames.map(f=>f.position.scrollY),[0,850]);assert.deepEqual(page.events,['scroll','settle','screenshot','scroll','settle','screenshot']);
  const next=await collect(page,{startY:first.result.nextStartY!});
  assert.deepEqual(next.frames.map(f=>f.position.scrollY),[1700,2000]);assert.equal(next.result.coverageComplete,true);
  assert.equal(screenshotRangeCovered([...first.frames,...next.frames].map(f=>f.position)),true);
  assert.equal(screenshotRangeCovered([next.frames[1].position]),false,'an isolated footer cannot prove page coverage');
});

test('mobile limit records viewport bottoms independently of the overlapping continuation cursor',async()=>{
  const page=new FakePage();page.width=390;page.height=844;page.documentHeight=12783;
  const {result,frames}=await collect(page,{maxScreenshots:8});
  assert.equal(result.nextStartY,5737);assert.equal(frames.length,8);assert.equal(frames.at(-1)!.position.scrollY,5019);
  assert.equal(frames.at(-1)!.position.scrollY+844,5863);assert.equal(result.coverageComplete,false);
});

test('tall unique regions split across real viewports while missing, ambiguous and nested regions are gaps',async()=>{
  const page=new FakePage();page.documentHeight=5000;page.regions.set('#faq',{top:1200,bottom:3700});
  const first=await collect(page,{scope:'regions',selectors:['#faq'],maxScreenshots:1});
  assert.equal(first.result.nextStartY,2050);assert.equal(first.result.nextSelectorIndex,0);
  const next=await collect(page,{scope:'regions',selectors:['#faq'],startY:2050});
  assert.equal(next.result.coverageComplete,true);assert.deepEqual(next.frames.map(f=>f.position.scrollY),[2050,2900]);
  page.regions.set('.card',{top:100,bottom:300,matches:2});page.regions.set('#nested',{top:100,bottom:300,nested:true});
  const gaps=await collect(page,{scope:'regions',selectors:['#missing','.card','#nested']});
  assert.equal(gaps.result.status,'failed');assert.equal(gaps.result.gaps.length,3);assert.equal(gaps.frames.length,0);
});

test('unsettled, interrupted and stalled captures retain saved frames without claiming completeness',async()=>{
  const unsettled=new FakePage();unsettled.settled=false;unsettled.documentHeight=800;
  const partial=await collect(unsettled);assert.equal(partial.frames.length,1);assert.equal(partial.result.status,'partial');assert.match(partial.result.gaps.join(),/did not settle/);
  const interrupted=new FakePage();interrupted.failAfter=1;
  const failure=await collect(interrupted);assert.equal(failure.frames.length,1);assert.equal(failure.result.nextStartY,850);assert.equal(failure.result.coverageComplete,false);
  const stalled=new FakePage();stalled.stalled=true;
  const stuck=await collect(stalled);assert.equal(stuck.frames.length,1);assert.match(stuck.result.gaps.join(),/did not advance/);
});

test('the production readiness script waits for visible nested counters, excludes offscreen text and bounds endless updates',async()=>{
  for(const [until,hidden,offscreen,settled,minTime] of [[1400,false,false,true,1900],[Infinity,false,false,false,4000],[Infinity,true,false,true,600],[Infinity,false,true,true,600],[0,false,false,true,600]] as const){
    let clock=0;const rect={x:0,y:0,top:0,bottom:100,left:0,right:100,width:100,height:100};
    const section={parentElement:null,getRootNode:()=>({}),getBoundingClientRect:()=>rect},counter={...section,parentElement:section};
    const node={textContent:'0',parentElement:counter};
    const context={document:{body:section,images:[],fonts:{status:'loaded'},getAnimations:()=>[],querySelectorAll:()=>[section],createTreeWalker:()=>{let read=false;return {nextNode:()=>{if(read)return null;read=true;return node;}};},createRange:()=>({selectNodeContents:()=>{},getClientRects:()=>[offscreen?{...rect,top:2000,bottom:2100}:rect]})},performance:{now:()=>clock},innerWidth:1440,innerHeight:1000,NodeFilter:{SHOW_TEXT:4},Element:class {},getComputedStyle:(element:unknown)=>({display:'block',visibility:'visible',opacity:hidden&&element===section?'0':'1'}),setTimeout:(done:()=>void,ms:number)=>{clock+=ms;node.textContent=String(Math.min(clock,until));done();},__name:(fn:unknown)=>fn};
    const result=await runInNewContext('('+waitForScreenshotContent.toString()+')(4000)',context) as ScreenshotReadiness;
    assert.equal(result.settled,settled);assert.ok(clock>=minTime);assert.ok(clock<=4000);
    if(settled)assert.ok(result.stableForMs>=500);else assert.equal(result.stableForMs,0);
  }
});

test('tool schema rejects fullPage and invalid region options',()=>{
  assert.throws(()=>browserAction.parse({action:'take_page_screenshots',fullPage:true}),/不支持 fullPage/);
  assert.throws(()=>browserAction.parse({action:'take_page_screenshots',scope:'regions'}),/需要 selectors/);
  assert.throws(()=>browserAction.parse({action:'take_page_screenshots',scope:'page',selectors:['#faq']}),/不能指定/);
});

test('evaluation browser registers every frame and observation and blocks template fullPage without opening Chromium',async()=>{
  const work=mkdtempSync(resolve(tmpdir(),'viewport-browser-'));mkdirSync(resolve(work,'evidence'));
  const page=new FakePage(),navigation:string[]=[];let closes=0,checkpoints=0;
  // Keep the page URL data separate from the Playwright url() method in this adapter.
  let currentUrl='https://target.test/';
  const adapter={evaluate:(fn:unknown,arg:any)=>{page.url=currentUrl;return page.evaluate(fn,arg);},screenshot:(input:any)=>page.screenshot(input),url:()=>currentUrl,goto:async(url:string)=>{navigation.push(url);currentUrl=url;page.y=0;return {status:()=>200};},waitForLoadState:async()=>{},locator:()=>({ariaSnapshot:async()=>'- heading Fixture',innerText:async()=>'Fixture'}),frames:()=>[],title:async()=>'Fixture'};
  const launch=mock.method(chromium,'launch',async()=>({newContext:async(input:any)=>{page.width=input.viewport.width;page.height=input.viewport.height;return {route:async()=>{},newPage:async()=>adapter};},close:async()=>{closes++;}}));
  let browser:Awaited<ReturnType<typeof evaluationBrowser>>|undefined;
  try{
    browser=await evaluationBrowser({target:currentUrl,reference:'',content:''},work,new AbortController().signal,[],()=>{checkpoints++;},{taskId:'task',siteRevision:'r1',viewportEvidence:true});
    const first=await browser.capture({action:'take_page_screenshots',role:'target',url:'/',maxScreenshots:2}) as PageScreenshotsReceipt;
    assert.equal(first.screenshots.length,2);assert.equal(first.nextStartY,1700);assert.equal(browser.artifacts.length,4);assert.equal(checkpoints,2);
    assert.ok(first.screenshots.every(s=>!('snapshot' in s)&&!('text' in s)),'receipt stays compact; no automatic image or full text attachment');
    const before=navigation.length;
    const next=await browser.capture({action:'take_page_screenshots',role:'target',url:'/',startY:1700}) as PageScreenshotsReceipt;
    assert.equal(next.coverageComplete,true);assert.equal(navigation.length,before,'same-URL continuation keeps the browser session');
    assert.equal(browser.artifacts.length,8);
    for(const frame of [...first.screenshots,...next.screenshots]){
      const observation=JSON.parse(readFileSync(resolve(work,'evidence',frame.file.replace('.png','.json')),'utf8'));
      assert.equal(observation.capture.policy,pageScreenshotPolicy);assert.equal(observation.binding.taskId,'task');assert.deepEqual(observation.position,frame.position);
      assert.ok(readFileSync(resolve(work,'evidence',frame.file)).length>0);
    }
    await assert.rejects(browser.capture({action:'screenshot',fullPage:true}),/模板只允许逐屏/);
    await assert.rejects(browser.capture({action:'take_page_screenshots',url:'https://foreign.test/'}),/只能访问/);
  }finally{await browser?.close();launch.mock.restore();rmSync(work,{recursive:true,force:true});}
  assert.equal(closes,1);
});

test('readiness script settles transform marquees, ignores 1x1 tracking pixels and promotes visible lazy images',async()=>{
  let clock=0,shiftX=0;
  const marqueeRect=()=>({x:shiftX,y:0,top:0,bottom:100,left:shiftX,right:shiftX+200,width:200,height:100});
  const section={parentElement:null,getRootNode:()=>({}),getBoundingClientRect:marqueeRect};
  const tracker={complete:false,naturalWidth:0,loading:'eager',parentElement:null,getRootNode:()=>({}),getBoundingClientRect:()=>({x:0,y:0,top:0,bottom:1,left:0,right:1,width:1,height:1})};
  const lazyImg={complete:false,naturalWidth:0,loading:'lazy',currentSrc:'https://example.test/a.jpg',parentElement:null,getRootNode:()=>({}),getBoundingClientRect:()=>({x:10,y:10,top:10,bottom:110,left:10,right:110,width:100,height:100})};
  const context={document:{body:section,images:[tracker,lazyImg],fonts:{status:'loaded'},getAnimations:()=>[],querySelectorAll:()=>[section],createTreeWalker:()=>({nextNode:()=>null}),createRange:()=>({selectNodeContents:()=>{},getClientRects:()=>[]})},performance:{now:()=>clock},innerWidth:1440,innerHeight:1000,NodeFilter:{SHOW_TEXT:4},Element:class {},getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1',transform:'matrix(1, 0, 0, 1, 10, 0)'}),setTimeout:(done:()=>void,ms:number)=>{clock+=ms;shiftX+=15;if(lazyImg.loading==='eager'){(lazyImg as any).naturalWidth=100;lazyImg.complete=true;}done();},__name:(fn:unknown)=>fn};
  const result=await runInNewContext('('+waitForScreenshotContent.toString()+')(4000)',context) as ScreenshotReadiness;
  assert.equal(result.settled,true);
  assert.equal(result.images,1);
  assert.equal(result.pendingImages,0);
  assert.equal(lazyImg.loading,'eager');
});
