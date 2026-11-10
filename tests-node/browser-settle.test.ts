import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Route } from 'playwright';
import { settlePage, settleVisibleImages, browserAction } from '../server/automation/browser.js';
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
  }finally{for(const route of hanging)await route.abort().catch(()=>{});await browser.close();}
});
