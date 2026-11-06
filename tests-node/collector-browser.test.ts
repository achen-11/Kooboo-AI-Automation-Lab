import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { Database } from '../server/runtime.js';
import { Artifacts } from '../server/lib/artifacts.js';
import { createCollector } from '../server/lib/collector.js';
import { listRules } from '../server/lib/rules.js';

// Explicit opt-in: the normal regression suite never launches a browser.
test('real Chromium executes scrolling and captures actual document positions', {
  skip: process.env.EVALUATOR_BROWSER_TEST !== '1', timeout: 30000,
}, async()=>{
  const db=new Database(':memory:'),artifacts=new Artifacts(db);
  const collect=createCollector(async()=>{
    const browser=await chromium.launch({headless:true});
    const newContext=browser.newContext.bind(browser);
    browser.newContext=async options=>{
      const context=await newContext(options);
      await context.route('https://fixture.test/**',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><style>body{margin:0}section{height:1000px;background:#123;color:white}section:nth-child(2){background:#a32}section:nth-child(3){background:#3a2}</style><section>Top content</section><section>Middle content</section><section>Bottom content</section>'}));
      return context;
    };
    return browser;
  });
  try{
    const rule={...listRules()[1].rule,viewports:[listRules()[1].rule.viewports[0]]};
    const evidence=await collect({targetUrl:'https://fixture.test/',readme:null,warnings:[],scope:'homepage',rule,
      evaluationId:'fixture',runId:'run',roles:['target'],signal:AbortSignal.timeout(25000),deadline:Date.now()+25000,
      artifacts,directory:'/unused',continuous:true,maxAttempts:1,waitStrategy:{waitMs:0,scrollWaitMs:100}});
    assert.equal(evidence.coverage.complete,true,JSON.stringify(evidence.issues));
    assert.deepEqual(evidence.screenshots.map(s=>s.pageY),[0,810,1620,2100]);
    assert.equal(evidence.screenshots.at(-1)!.pageY!+evidence.screenshots.at(-1)!.height,3000);
    assert.ok(new Set(evidence.screenshots.map(s=>s.sha256)).size>=3,'different document sections must contain different pixels');
    assert.ok(evidence.screenshots.every(s=>!!artifacts.get('fixture','run',s.file)));
  }finally{db.close();}
});
