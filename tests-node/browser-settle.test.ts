import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Route } from 'playwright';
import { settlePage } from '../server/automation/browser.js';

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
