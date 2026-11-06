#!/usr/bin/env node
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname, join, relative } from 'node:path';
import { chromium } from 'playwright';
import { VERSION, sha256, configHash, positions, validateConfig, verifyArtifacts, validateAssessment, reportMarkdown } from './agent-eval-core.mjs';

const [command, ...args] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i].startsWith('--') || !args[i + 1]) throw Error('Use --name value options');
  flags[args[i].slice(2)] = args[i + 1];
}
const directory = resolve(flags.out || '.agent-eval');
const manifestPath = join(directory, 'manifest.json');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
  await rename(file + '.tmp', file);
}
function summary(m) {
  return { version: m.version, runId: m.runId, captures: Object.fromEntries(Object.entries(m.captures).map(([key, c]) => [key,
    { status: c.status, title: c.metadata?.title, pageHeight: c.metadata?.height, screenshotCount: c.artifacts?.length, coverage: c.coverage,
      ...(flags.detail === 'true' ? { headings: c.metadata?.headings?.map(h => ({ text: h.text, y: h.y })).slice(0, 16) } : {}), warnings: c.warnings, error: c.error }])) };
}
async function archiveReport() {
  const folder = join(directory, 'history', 'reports', new Date().toISOString().replaceAll(':', '-'));
  for (const file of ['result.json', 'report.md']) {
    try {
      await readFile(join(directory, file));
      await mkdir(folder, { recursive: true });
      await rename(join(directory, file), join(folder, file));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
async function metadata(page) {
  return page.evaluate(() => {
    const rect = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), width: Math.round(r.width), height: Math.round(r.height) }; };
    const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
    const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
    return { title: document.title, url: location.href, height, width: document.documentElement.scrollWidth,
      text: (document.body?.innerText || '').slice(0, 30000),
      headings: [...document.querySelectorAll('h1,h2,h3')].filter(visible).slice(0, 100).map(el => ({ tag: el.tagName, text: el.textContent.trim().slice(0, 180), ...rect(el), font: getComputedStyle(el).fontFamily, fontSize: getComputedStyle(el).fontSize })),
      images: [...document.images].filter(visible).map(el => ({ loaded: el.complete && el.naturalWidth > 0, ...rect(el) })),
      footer: [...document.querySelectorAll('footer,[role="contentinfo"],.footer')].filter(visible).slice(0, 5).map(rect),
      bodyBackground: getComputedStyle(document.body).backgroundColor };
  });
}
async function settle(page) {
  await page.evaluate(() => Promise.race([Promise.allSettled([document.fonts?.ready, ...[...document.images].filter(i => !i.complete).map(i => new Promise(resolve => { i.addEventListener('load', resolve, {once:true}); i.addEventListener('error', resolve, {once:true}); }))]), new Promise(resolve => setTimeout(resolve, 5000))]));
}
async function capture(m, role, viewport, browser) {
  const key = `${role}-${viewport.id}`;
  const previous = m.captures[key];
  if (previous?.status === 'captured' && flags.recapture !== key) {
    await verifyArtifacts({ captures: { [key]: previous } }, directory);
    console.log(JSON.stringify({ event: 'reused', capture: key }));
    return;
  }
  const attempt = (previous?.attempt || 0) + 1;
  const folder = join(role, viewport.id, `attempt-${attempt}`);
  const c = { role, viewport, attempt, status: 'capturing', startedAt: new Date().toISOString(), artifacts: [], warnings: [], history: previous ? [...(previous.history || []), { ...previous, history: undefined }] : [] };
  m.captures[key] = c;
  await writeJson(manifestPath, m);
  console.log(JSON.stringify({ event: 'started', capture: key, attempt }));
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1,
    isMobile: viewport.id === 'mobile', hasTouch: viewport.id === 'mobile', locale: 'en-US', timezoneId: 'Asia/Shanghai', reducedMotion: 'no-preference' });
  const page = await context.newPage();
  const errors = [], failedRequests = [];
  page.on('pageerror', error => errors.push(error.message.slice(0, 300)));
  page.on('requestfailed', request => { const u = new URL(request.url()); failedRequests.push({ host: u.host, path: u.pathname, error: request.failure()?.errorText }); });
  page.setDefaultTimeout(20000);
  const budget = setTimeout(() => void context.close(), 240000);
  async function saveShot(kind, options, y) {
    const pixels = await page.screenshot({ type: 'png', timeout: 30000, ...options });
    const file = join(folder, `${kind}.png`);
    await mkdir(join(directory, folder), { recursive: true });
    await writeFile(join(directory, file), pixels);
    c.artifacts.push({ id: `${key}-a${attempt}-${kind}`, file, kind, role, viewport: viewport.id, capturedAt: new Date().toISOString(),
      pageY: y, visualUse: kind === 'full' || kind === 'diagnostic' ? 'diagnostic-only' : 'primary-evidence',
      sha256: sha256(pixels), bytes: pixels.length, width: pixels.readUInt32BE(16), height: pixels.readUInt32BE(20) });
    await writeJson(manifestPath, m);
  }
  try {
    const response = await page.goto(m.config[role], { waitUntil: 'domcontentloaded', timeout: 60000 });
    c.httpStatus = response?.status();
    if (c.httpStatus >= 400) throw Error(`Navigation HTTP ${c.httpStatus}`);
    await page.waitForTimeout(2500);
    await settle(page);
    const initial = await metadata(page);
    let y = 0, reachedEnd = false, scrolls = 0;
    const maxHeight = m.config.maxHeight || 30000;
    // Refresh the page height each iteration: lazy content can grow after scrolling.
    while (scrolls++ < 100) {
      const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0));
      const bottom = Math.max(0, Math.min(height, maxHeight) - viewport.height);
      y = Math.min(y, bottom);
      await page.evaluate(y => window.scrollTo({ top: y, left: 0, behavior: 'instant' }), y);
      await page.waitForTimeout(500);
      if (y >= bottom) {
        await settle(page);
        const grown = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0));
        if (Math.min(grown, maxHeight) <= y + viewport.height + 1) { reachedEnd = grown <= maxHeight; break; }
      }
      y += Math.round(viewport.height * .75);
    }
    await settle(page);
    c.metadata = await metadata(page);
    if (c.metadata.width > viewport.width + 4) c.warnings.push(`Horizontal overflow: ${c.metadata.width}px > ${viewport.width}px`);
    const badImages = c.metadata.images.filter(i => !i.loaded);
    if (badImages.length) c.warnings.push(`${badImages.length} visible images not loaded`);
    if (c.metadata.height > maxHeight) c.warnings.push(`Page exceeds ${maxHeight}px limit`);
    for (const [index, plannedY] of positions(c.metadata.height, viewport.height, maxHeight).entries()) {
      await page.evaluate(y => window.scrollTo({ top: y, left: 0, behavior: 'instant' }), plannedY);
      await page.waitForTimeout(650);
      const pageY = await page.evaluate(() => scrollY);
      if (Math.abs(pageY - plannedY) > 1) c.warnings.push(`Scroll mismatch ${plannedY} -> ${pageY}`);
      await saveShot(`tile-${String(index + 1).padStart(2, '0')}`, { fullPage: false }, pageY);
    }
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
    await page.waitForTimeout(700);
    await saveShot('full', { fullPage: true, clip: { x: 0, y: 0, width: viewport.width, height: Math.min(c.metadata.height, maxHeight) } }, 0);
    const after = await metadata(page);
    if (after.height !== c.metadata.height) c.warnings.push(`Height changed while capturing: ${c.metadata.height} -> ${after.height}`);
    c.coverage = { complete: reachedEnd && after.height === c.metadata.height && c.metadata.height <= maxHeight,
      actualHeight: c.metadata.height, capturedHeight: Math.min(c.metadata.height, maxHeight), initialHeight: initial.height, scrolls };
    c.status = 'captured';
    c.visualReview = 'pending-agent-review';
  } catch (error) {
    c.status = 'failed'; c.error = String(error.message || error).slice(0, 1000);
    try { await saveShot('diagnostic', { fullPage: false }, await page.evaluate(() => scrollY)); } catch {}
    console.error(JSON.stringify({ event: 'failed', capture: key, error: c.error }));
  } finally {
    clearTimeout(budget);
    c.pageErrors = errors.slice(0, 20); c.failedRequests = failedRequests.slice(0, 40);
    c.completedAt = new Date().toISOString();
    await context.close().catch(() => {});
    await writeJson(manifestPath, m);
    console.log(JSON.stringify({ event: 'checkpoint', capture: key, status: c.status, artifacts: c.artifacts.length, warnings: c.warnings }));
  }
}
if (command === 'capture') {
  if (!flags.config) throw Error('--config required');
  const config = validateConfig(await readJson(resolve(flags.config)));
  let m;
  try { m = await readJson(manifestPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (m && m.configHash !== configHash(config)) throw Error('Configuration changed; use a new output directory');
  m ||= { schemaVersion: 1, version: VERSION, runId: new Date().toISOString().replaceAll(':', '-'), startedAt: new Date().toISOString(), config, configHash: configHash(config), captures: {} };
  await writeJson(manifestPath, m);
  const allowed = ['target', 'reference'].flatMap(role => config.viewports.map(v => `${role}-${v.id}`));
  if (flags.only && !allowed.includes(flags.only)) throw Error('Unknown --only capture');
  if (flags.recapture && !allowed.includes(flags.recapture)) throw Error('Unknown --recapture capture');
  const plan = ['target', 'reference'].flatMap(role => config.viewports.map(viewport => ({ role, viewport, key: `${role}-${viewport.id}` })))
    .filter(item => !flags.only || flags.only === item.key);
  const pending = [];
  for (const item of plan) {
    if (m.captures[item.key]?.status === 'captured' && flags.recapture !== item.key) {
      await verifyArtifacts({ captures: { [item.key]: m.captures[item.key] } }, directory);
      console.log(JSON.stringify({ event: 'reused', capture: item.key }));
    } else pending.push(item);
  }
  if (pending.length) {
    await archiveReport();
    const browser = await chromium.launch({ headless: true, timeout: 30000 });
    m.browser = { engine: 'chromium', version: browser.version(), deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'Asia/Shanghai' };
    try {
      for (const {role, viewport} of pending) await capture(m, role, viewport, browser);
    } finally { await browser.close(); }
  }
  console.log(JSON.stringify(summary(m), null, 2));
  if (Object.values(m.captures).some(c => c.status === 'failed')) process.exitCode = 1;
} else if (command === 'inspect') {
  const m = await readJson(manifestPath);
  const verified = await verifyArtifacts(m, directory);
  let reportState = 'not-scored';
  try { const r = await readJson(join(directory, 'result.json')); reportState = r.sourceManifestHash === sha256(await readFile(manifestPath)) ? 'current' : 'stale'; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  console.log(JSON.stringify({ ...summary(m), verifiedArtifacts: verified.length, reportState }, null, 2));
} else if (command === 'report') {
  if (!flags.assessment) throw Error('--assessment required');
  const m = await readJson(manifestPath);
  await verifyArtifacts(m, directory);
  const result = validateAssessment(await readJson(resolve(flags.assessment)), m);
  result.sourceManifestHash = sha256(await readFile(manifestPath));
  await writeJson(join(directory, 'result.json'), result);
  await writeFile(join(directory, 'report.md'), reportMarkdown(result, m));
  console.log(JSON.stringify({ totalScore: result.totalScore, status: result.scoringStatus, report: join(directory, 'report.md'), dimensions: result.dimensions.map(d => ({ id: d.id, score: d.score, weight: d.weight })) }, null, 2));
} else {
  console.log('node scripts/agent-eval.mjs capture --config input.json --out run-dir [--only target-desktop] [--recapture target-desktop]\nnode scripts/agent-eval.mjs inspect --out run-dir\nnode scripts/agent-eval.mjs report --out run-dir --assessment assessment.json');
  if (command) process.exitCode = 1;
}
