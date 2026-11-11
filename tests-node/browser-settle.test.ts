import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Frame, type Route } from 'playwright';
import { settlePage, settleVisibleImages, shouldAbortNavigation, browserAction } from '../server/automation/browser.js';
import { runInNewContext } from 'node:vm';

test('pending hidden or horizontally offscreen images never block visible settlement; visible pending and broken images stay distinct',async()=>{
  const img=(options:{complete?:boolean;left?:number;hidden?:boolean;ancestorHidden?:boolean;broken?:boolean}={})=>({complete:options.complete??false,naturalWidth:options.broken?0:100,decode:async()=>{},getBoundingClientRect:()=>({width:100,height:100,top:0,bottom:100,left:options.left??0,right:(options.left??0)+100}),parentElement:options.ancestorHidden?{hidden:true,parentElement:null,getRootNode:()=>({})}:null,hidden:options.hidden,getRootNode:()=>({})});
  const images=[img({complete:true}),img({hidden:true}),img({left:1600}),img({left:-200}),img({ancestorHidden:true})];
  const run=()=>runInNewContext('('+settleVisibleImages.toString()+')(0)',{document:{images,fonts:{ready:Promise.resolve()}},window:{innerWidth:1440,innerHeight:1000},getComputedStyle:(el:{hidden?:boolean})=>({display:'block',visibility:'visible',opacity:el.hidden?'0':'1'}),setTimeout:(fn:()=>void)=>{fn();return 0;}});
  assert.deepEqual(JSON.parse(JSON.stringify(await run())),{images:1,pending:0,blank:0});
  images.push(img(),img({complete:true,broken:true}));assert.deepEqual(JSON.parse(JSON.stringify(await run())),{images:3,pending:1,blank:1});
});

test('press accepts the documented value and common key alias, rejects missing or contradictory keys',()=>{
  assert.equal(browserAction.parse({action:'press',key:'Escape'}).key,'Escape');assert.equal(browserAction.parse({action:'press',value:'Escape'}).value,'Escape');
  assert.throws(()=>browserAction.parse({action:'press'}),/press 需要/);assert.throws(()=>browserAction.parse({action:'press',key:'Escape',value:'Enter'}),/不同按键/);
});

test('shouldAbortNavigation handles frameless popup navigations without throwing and preserves main-frame vs iframe rules',()=>{
  const main={parentFrame:()=>null} as unknown as Frame;
  const child={parentFrame:()=>main} as unknown as Frame;
  const framelessError=()=>new Error('Frame for this navigation request is not available, because the request\nwas issued before the frame is created.');
  const req=(url:string,isNav:boolean,frameImpl:()=>Frame)=>({url:()=>url,isNavigationRequest:()=>isNav,frame:frameImpl});

  // Subresources never abort even across origins or frameless service-worker requests
  assert.equal(shouldAbortNavigation(req('https://cdn.other.test/app.js',false,()=>{throw framelessError();}),'https://target.test',main),false);
  // Embedded iframe navigations across origins remain allowed
  assert.equal(shouldAbortNavigation(req('https://maps.other.test/embed',true,()=>child),'https://target.test',main),false);
  assert.equal(shouldAbortNavigation(req('https://maps.other.test/embed',true,()=>child),'https://target.test'),false);
  // Main-frame navigation: same-origin allowed, cross-origin aborted
  assert.equal(shouldAbortNavigation(req('https://target.test/gallery',true,()=>main),'https://target.test',main),false);
  assert.equal(shouldAbortNavigation(req('https://external.test/gallery',true,()=>main),'https://target.test',main),true);
  // Frameless popup / target="_blank" navigation (Moxom gallery zoom crash reproducer): never throws; same-origin allowed, cross-origin aborted
  assert.equal(shouldAbortNavigation(req('https://target.test/zoom.png',true,()=>{throw framelessError();}),'https://target.test',main),false);
  assert.equal(shouldAbortNavigation(req('https://external.test/zoom.png',true,()=>{throw framelessError();}),'https://target.test',main),true);
  // Non-HTTP(S) or invalid navigation URLs are blocked safely
  assert.equal(shouldAbortNavigation(req('mailto:info@target.test',true,()=>{throw framelessError();}),'https://target.test',main),true);
});

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const page=(hero:string)=>`<!doctype html><style>body{margin:0}img{display:block;width:600px;height:400px}.gap{height:3000px}</style><img id="hero" src="${hero}"><div class="gap"></div><img id="lazy" loading="lazy" src="https://fixture.test/lazy.png">`;

// Explicit opt-in: the normal regression suite never launches a browser.
test('real Chromium waits for slow hero and lazy images, and labels a never-loading image unsettled',{skip:process.env.EVALUATOR_BROWSER_TEST!=='1',timeout:60000},async()=>{
  const browser=await chromium.launch({headless:true}),hanging:Route[]=[];
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.route('https://fixture.test/**',async route=>{
      const path=new URL(route.request().url()).pathname;
      if(path==='/slow')return route.fulfill({contentType:'text/html',body:page('https://fixture.test/slow.png')});
      if(path==='/stuck')return route.fulfill({contentType:'text/html',body:page('https://fixture.test/stuck.png')});
      if(path==='/slow.png'){await new Promise(resolve=>setTimeout(resolve,1500));return route.fulfill({contentType:'image/png',body:png});}
      if(path==='/stuck.png'){hanging.push(route);return;}
      return route.fulfill({contentType:'image/png',body:png});
    });
    const tab=await context.newPage();
    await tab.goto('https://fixture.test/slow',{waitUntil:'domcontentloaded'});
    const slow=await settlePage(tab,true);
    assert.equal(slow.settled,true);assert.equal(slow.pendingImages,0);assert.equal(await tab.evaluate(()=>window.scrollY),0);
    assert.equal(await tab.evaluate(()=>(document.getElementById('lazy') as HTMLImageElement).complete&&(document.getElementById('lazy') as HTMLImageElement).naturalWidth>0),true,'scrolling triggers lazy images');
    await tab.goto('https://fixture.test/stuck',{waitUntil:'domcontentloaded'});
    const stuck=await settlePage(tab,false);
    assert.equal(stuck.settled,false);assert.equal(stuck.pendingImages,1);

    // Real Chromium popup navigation (target="_blank") with shouldAbortNavigation guard:
    const guarded=await browser.newContext({viewport:{width:1440,height:1000}});
    let crossOriginPopupAborted=false,sameOriginPopupAllowed=false;
    await guarded.route('**/*',async route=>{
      if(shouldAbortNavigation(route.request(),'https://fixture.test',popupTab?.mainFrame())){
        crossOriginPopupAborted=true;
        return route.abort().catch(()=>{});
      }
      const u=new URL(route.request().url());
      if(u.pathname==='/zoom')sameOriginPopupAllowed=true;
      return route.fulfill({contentType:'text/html',body:'<!doctype html><a id="same" href="https://fixture.test/zoom" target="_blank">Zoom</a><a id="ext" href="https://external.test/out" target="_blank">External</a>'});
    });
    var popupTab=await guarded.newPage();
    await popupTab.goto('https://fixture.test/',{waitUntil:'domcontentloaded'});
    await popupTab.click('#same');
    await popupTab.click('#ext');
    await popupTab.waitForTimeout(300);
    assert.equal(sameOriginPopupAllowed,true);
    assert.equal(crossOriginPopupAborted,true);
    await guarded.close();
  }finally{for(const route of hanging)await route.abort().catch(()=>{});await browser.close();}
});
