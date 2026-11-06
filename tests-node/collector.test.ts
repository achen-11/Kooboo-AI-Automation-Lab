import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../server/runtime.js';
import { Artifacts } from '../server/lib/artifacts.js';
import { createCollector, screenshotRegions, continuousRegions, type CollectionInput } from '../server/lib/collector.js';
import { LostLease } from '../server/lib/store.js';
import { listRules } from '../server/lib/rules.js';
import type { Browser } from 'playwright';

function fixture() {
  const database = new Database(':memory:'), artifacts = new Artifacts(database);
  const events: { action: string; value?: unknown }[] = [];
  const metadata = { title: 'Example', text: 'This is a full rendered example page.', height: 2600, width: 390, images: 1, unloaded: 0, broken: 0 };
  let closeCount = 0, reads = 0, contexts = 0;
  let viewport = { width: 1440, height: 900 }, scrollY = 0;
  const page: any = {
    setDefaultTimeout() {},
    async goto(url: string) { events.push({ action: 'goto', value: url }); return { status: () => 200 }; },
    async waitForTimeout(value: number) { events.push({ action: 'wait', value }); },
    async evaluate(expression: string | Function, value?: unknown) {
      // Playwright treats strings as expressions; a string containing an arrow function is not invoked.
      if (typeof expression === 'string' && expression.includes('=>') && (expression.includes('window.scrollTo') || expression.includes('window.scrollY'))) return undefined;
      const code=String(expression);
      if (code.includes('document.title')) { reads++; return { ...metadata }; }
      if (code.includes('window.scrollTo')) scrollY = Math.max(0, Math.min(Number(value), metadata.height - viewport.height));
      if (code === 'window.scrollY') return scrollY;
      events.push({ action: 'evaluate', value });
    },
    async screenshot(options: any) {
      assert.notEqual(options.fullPage, true, 'capture each scrolled viewport without resizing the page');
      const clip = options.clip, imageHeight = options.fullPage ? metadata.height : viewport.height;
      // Playwright trims clip to the viewport unless fullPage is requested.
      if (clip.y >= imageHeight || clip.x >= viewport.width || clip.y + clip.height <= 0)
        throw new Error('page.screenshot: Clipped area is either empty or outside the resulting image');
      events.push({ action: 'screenshot', value: { ...clip, pageY: scrollY } });
      return Buffer.from('original pixels');
    },
  };
  const browser: any = {
    async newContext(options: any) { viewport = options.viewport; scrollY = 0; contexts++; events.push({ action: 'context', value: options }); return { newPage: async () => page, close: async () => { events.push({ action: 'context-close' }); } }; },
    async close() { closeCount++; },
  };
  const input: CollectionInput = { targetUrl: 'https://target.test', referenceUrl: 'https://reference.test', readme: null, warnings: [],
    scope: 'homepage', rule: listRules()[0].rule, evaluationId: 'evaluation', runId: 'run', deadline: Date.now() + 60000,
    roles: ['target'], signal: new AbortController().signal, artifacts, directory: '/unused' };
  return { database, artifacts, input, events, page, metadata, browser, collect: createCollector(async () => browser as Browser),
    closes: () => closeCount, reads: () => reads, contexts: () => contexts };
}

test('continuous capture follows lazy-loaded height growth and covers every viewport without gaps',async()=>{
  const f=fixture();
  try{
    f.input.continuous=true;f.input.attemptTag='a123';f.input.rule={...f.input.rule,viewports:[f.input.rule.viewports[0]]};
    const evaluate=f.page.evaluate;let grew=false;
    f.page.evaluate=async(code:any,value?:unknown)=>{
      if(String(code).includes('window.scrollTo')&&Number(value)>=1000&&!grew){f.metadata.height=4700;grew=true;}
      return evaluate(code,value);
    };
    const result=await f.collect(f.input),expected=continuousRegions(4700,900,f.input.rule.capture.maxHeight);
    assert.equal(grew,true);assert.equal(result.coverage.complete,true);
    assert.deepEqual(result.screenshots.map(s=>s.pageY),expected.map(s=>s.y));
    assert.equal(result.screenshots.at(-1)!.pageY!+result.screenshots.at(-1)!.height,4700);
    assert.ok(result.screenshots.every(s=>s.id.includes('-a123-tile-')&&s.sha256?.length===64));
  }finally{f.database.close();}
});

test('height growth during screenshot pass invalidates continuous full-page coverage',async()=>{
  const f=fixture();
  try{
    f.input.continuous=true;f.input.rule={...f.input.rule,viewports:[f.input.rule.viewports[0]]};
    const screenshot=f.page.screenshot;let grew=false;
    f.page.screenshot=async(options:any)=>{const result=await screenshot(options);if(!grew){f.metadata.height+=1000;grew=true;}return result;};
    const result=await f.collect(f.input);assert.equal(result.coverage.complete,false);
    assert.ok(result.issues.some(i=>i.title==='截图期间页面继续增长'));assert.equal(result.stable,false);
  }finally{f.database.close();}
});

test('site request distinguishes completed homepage pixels from unfulfilled full-site coverage', async () => {
  const f = fixture();
  try {
    f.input.scope = 'site';
    f.input.continuous = true;
    const result = await f.collect(f.input);
    assert.equal(result.coverage.captureComplete, true);
    assert.equal(result.coverage.complete, false);
    assert.equal(result.coverage.actual, 'homepage');
    assert.equal(result.coverage.requested, 'site');
    assert.ok(result.screenshots.length > 0);
    assert.ok(result.issues.every(issue => issue.dimension !== 'coverage'));
  } finally { f.database.close(); }
});

test('site request still rejects incomplete actual homepage geometry', async () => {
  const f = fixture();
  try {
    f.input.scope = 'site';
    f.input.continuous = true;
    f.metadata.height = f.input.rule.capture.maxHeight + 1000;
    const result = await f.collect(f.input);
    assert.equal(result.coverage.captureComplete, false);
    assert.equal(result.coverage.complete, false);
    assert.ok(result.issues.some(issue => issue.title === '页面超出采集高度预算'));
  } finally { f.database.close(); }
});

test('local collector owns navigation, scroll, metadata and real region clips in each same page', async () => {
  const f = fixture();
  try {
    const partials: number[] = []; f.input.onProgress = (_message, evidence) => partials.push(evidence.screenshots.length);
    f.input.review = async () => ({ usable: true, reason: 'Screenshots show expected content' });
    const result = await f.collect(f.input);
    assert.equal(f.contexts(), 2); assert.equal(f.events.filter(event => event.action === 'goto').length, 2);
    assert.equal(f.reads(), 6); assert.equal(f.closes(), 1);
    assert.equal(result.screenshots.length, 6); assert.equal(result.health, 'ok'); assert.equal(result.coverage.complete, true);
    assert.ok(partials.includes(1)); assert.ok(partials.includes(6));
    const desktop = f.events.filter(event => event.action === 'screenshot').slice(0, 3).map(event => event.value as any);
    assert.deepEqual(desktop.map(clip => clip.y), [0, 0, 0]);
    assert.deepEqual(desktop.map(clip => clip.pageY), [0, 850, 1700]);
    assert.deepEqual(desktop.map(clip => clip.height), [900, 900, 900]);
    assert.deepEqual(result.screenshots.filter(shot => shot.viewport === 'desktop').map(shot => shot.pageY), [0, 850, 1700]);
    assert.deepEqual(result.screenshots.filter(shot => shot.viewport === 'mobile').map(shot => shot.pageY), [0, 878, 1756]);
    assert.ok(f.events.filter(event => event.action === 'screenshot').every(event => (event.value as any).y === 0));
    assert.equal(f.artifacts.get('evaluation', 'run', 'target-desktop-middle.png'), Buffer.from('original pixels').toString('base64'));
    assert.ok(result.screenshots.every(shot => shot.captureMethod === 'playwright'));
  } finally { f.database.close(); }
});

test('bounded AI review retries only the selected capture and keeps failed visual evidence diagnostic', async () => {
  const f = fixture();
  try {
    f.input.rule = { ...f.input.rule, viewports: [f.input.rule.viewports[0]] };
    let reviewCalls = 0;
    f.input.review = async () => { reviewCalls++; return { usable: false, reason: 'Main content remains blank', retry: { waitMs: 60000, scrollWaitMs: 60000 } }; };
    f.input.maxAttempts = 9;
    const result = await f.collect(f.input);
    assert.equal(reviewCalls, 3); assert.equal(f.contexts(), 3);
    assert.equal(result.screenshots.length, 3); assert.equal(result.coverage.complete, false);
    assert.ok(result.issues.some(issue => issue.dimension === 'target' && issue.capture?.stage === '视觉检查'));
    const waits = f.events.filter(event => event.action === 'wait').map(event => event.value as number);
    assert.ok(waits.includes(15000)); assert.ok(waits.every(wait => wait <= 15000));
  } finally { f.database.close(); }
});

test('one viewport failure does not discard another successful capture', async () => {
  const f = fixture();
  try {
    const screenshot = f.page.screenshot;
    f.page.screenshot = async (options: any) => { if (options.clip.width === 390) throw new Error('render failed'); return screenshot(options); };
    const result = await f.collect(f.input);
    assert.equal(result.screenshots.length, 3); assert.equal(result.health, 'unknown');
    assert.ok(result.issues.some(issue => issue.capture?.viewport === 'mobile' && issue.dimension === 'target'));
    assert.equal(f.closes(), 1);
  } finally { f.database.close(); }
});

test('partial PNG artifacts remain visible if final metadata validation fails', async () => {
  const f = fixture();
  try {
    f.input.rule = { ...f.input.rule, viewports: [f.input.rule.viewports[0]] };
    const evaluate = f.page.evaluate; let metadataReads = 0;
    f.page.evaluate = async (code: string, arg?: unknown) => {
      if (String(code).includes('document.title') && ++metadataReads === 3) throw new Error('metadata validation failed');
      return evaluate(code, arg);
    };
    const result = await f.collect(f.input);
    assert.equal(result.screenshots.length, 3); assert.equal(result.coverage.complete, false);
    assert.ok(result.issues.some(issue => issue.dimension === 'target' && issue.detail.includes('metadata validation failed')));
  } finally { f.database.close(); }
});

test('aborted browser collection closes the browser and does not fabricate a terminal capture', async () => {
  const f = fixture();
  try {
    const controller = new AbortController(); f.input.signal = controller.signal;
    f.page.goto = async () => { controller.abort(new Error('stopped')); throw new Error('browser closed'); };
    await assert.rejects(f.collect(f.input));
    assert.ok(f.closes() >= 1); assert.equal(f.artifacts.get('evaluation', 'run', 'target-desktop-top.png'), null);
  } finally { f.database.close(); }
});

test('lost execution lease propagates without being downgraded into a capture issue', async () => {
  const f = fixture();
  try {
    let checks = 0;
    f.input.onCheckpoint = () => { if (++checks > 3) throw new LostLease('stale worker'); };
    await assert.rejects(f.collect(f.input), LostLease);
    assert.equal(f.closes(), 1);
  } finally { f.database.close(); }
});

test('short pages deduplicate coordinates and oversize pages mark a real coverage boundary', () => {
  assert.deepEqual(screenshotRegions(700, 900, 12000, 3), [{ region: 'top', y: 0, height: 700 }]);
  assert.deepEqual(screenshotRegions(30000, 900, 12000, 3).map(region => region.y), [0, 5550, 11100]);
});

test('tall pages capture all bounded regions using viewport clips and retain height coverage limits', async () => {
  const f = fixture();
  try {
    f.metadata.height = 30000;
    f.input.rule = { ...f.input.rule, viewports: [f.input.rule.viewports[0]] };
    const result = await f.collect(f.input);
    assert.equal(result.screenshots.length, 3);
    assert.deepEqual(result.screenshots.map(shot => shot.pageY), [0, 5550, 11100]);
    assert.ok(!result.issues.some(issue => issue.dimension === 'target'));
    assert.equal(result.coverage.complete, false);
    assert.ok(result.issues.some(issue => issue.title === '页面超出采集高度预算'));
  } finally { f.database.close(); }
});

test('short pages produce one correctly sized viewport clip rather than invented middle and bottom regions', async () => {
  const f = fixture();
  try {
    f.metadata.height = 700;
    f.input.rule = { ...f.input.rule, viewports: [f.input.rule.viewports[0]] };
    const result = await f.collect(f.input);
    assert.equal(result.screenshots.length, 1);
    assert.equal(result.screenshots[0].pageY, 0);
    assert.equal(result.screenshots[0].height, 700);
    assert.equal(result.coverage.complete, true);
    const clip = f.events.find(event => event.action === 'screenshot')!.value as any;
    assert.deepEqual(clip, { x: 0, y: 0, width: 1440, height: 700, pageY: 0 });
  } finally { f.database.close(); }
});


for (const role of ['target', 'reference'] as const) {
  test(`${role} image counts stay in diagnostics without creating visible issues or health warnings`, async () => {
    const f = fixture();
    try {
      f.metadata.images = 6; f.metadata.unloaded = 3; f.metadata.broken = 1;
      f.input.roles = [role]; f.input.continuous = true; f.input.attemptTag = 'attempt1';
      f.input.rule = { ...f.input.rule, viewports: [f.input.rule.viewports[0]] };
      const result = await f.collect(f.input);
      assert.equal(result.coverage.complete, true);
      assert.equal(result.health, role === 'target' ? 'ok' : 'unknown');
      assert.deepEqual(result.issues, []);
      const diagnostic = JSON.parse(f.artifacts.get('evaluation', 'run', `${role}-desktop-attempt1-image-load-diagnostics.json`)!);
      assert.equal(diagnostic.role, role); assert.equal(diagnostic.viewport, 'desktop');
      assert.equal(diagnostic.images, 6); assert.equal(diagnostic.unloaded, 3); assert.equal(diagnostic.broken, 1);
      assert.ok(diagnostic.capturedAt > 0);
    } finally { f.database.close(); }
  });
}
