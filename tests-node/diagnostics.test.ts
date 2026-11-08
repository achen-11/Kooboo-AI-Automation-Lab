import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';
import { defaultAutomationSettings } from '../shared/automation.js';
import { diagnosticActive } from '../shared/diagnostics.js';
import { writeZip, archivePath } from '../server/diagnostics/zip.js';
import { exportRedactor } from '../server/diagnostics/redact.js';
import { DiagnosticCollector } from '../server/diagnostics/collector.js';
import { diagnosticSnapshot } from '../server/diagnostics/snapshot.js';
import { DiagnosticExports } from '../server/diagnostics/service.js';
import { exportKoobooSite } from '../server/diagnostics/kooboo-export.js';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const signal = () => new AbortController().signal;
function directory() { return mkdtempSync(resolve(tmpdir(), 'diagnostics-')); }
function put(path: string, value: string | Buffer) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); return path; }
function unpack(path: string): Record<string, string> {
  const result = spawnSync('python3', ['-c', 'import zipfile,json,sys,base64\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert z.testzip() is None\n print(json.dumps({n:base64.b64encode(z.read(n)).decode() for n in z.namelist()}))', path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return Object.fromEntries(Object.entries(JSON.parse(result.stdout) as Record<string, string>).map(([name, value]) => [name, Buffer.from(value, 'base64').toString('utf8')]));
}
async function fixture() {
  const dir = directory(), f = await createApp({ directory: dir, startWorker: false, serveWeb: false });
  const store = f.automationStore;
  const resource = store.saveResource({ name: '资料包', scenario: 'migration', description: '', contentUrl: 'https://source.test', referenceUrl: '', files: [], externalSource: '', externalId: '' });
  const envId = randomUUID(), site = { id: randomUUID(), resourceId: resource.id, versionId: store.versions(resource.id)[0].id, environmentId: envId, siteId: randomUUID(), name: 'Target', url: 'https://target.test', createdAt: Date.now() };
  store.saveSite(site);
  const create = (siteId: string | undefined = site.id) => store.create({ resourceIds: [resource.id], ...(siteId ? { generatedSiteId: siteId } : {}), kind: 'generation', scope: 'homepage', environmentId: envId, requirements: '' }, structuredClone(defaultAutomationSettings))[0];
  return { ...f, store, dir, site, envId, resource, create, async close() { await f.app.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function finish(exports: DiagnosticExports, id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = exports.get(id)!; if (!diagnosticActive(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('排障包未在测试期限内结束');
}

test('ZIP64 is readable by a standard reader with Unicode, binary and empty files; rejects changed bytes and unsafe paths', async () => {
  const dir = directory(); try {
    const files = [ ['目录/说明.md', Buffer.from('完整记录\n')], ['empty.txt', Buffer.alloc(0)], ['image.png', Buffer.from([0, 255, 42])] ] as const;
    const inputs = files.map(([name, value], i) => ({ name, file: put(resolve(dir, String(i)), value), size: value.length, sha256: sha(value) }));
    const zip = resolve(dir, 'valid.zip'); await writeZip(zip, inputs, signal());
    const content = unpack(zip); assert.equal(content['目录/说明.md'], '完整记录\n'); assert.equal(content['empty.txt'], '');
    for (const name of ['../x', '/x', 'a/../x', 'C:/x', 'a\\b', 'a//b', 'a\n.txt']) assert.throws(() => archivePath(name));
    await assert.rejects(writeZip(resolve(dir, 'changed.zip'), [{ ...inputs[0], sha256: 'bad' }], signal()), /发生变化/);
    const controller = new AbortController(); controller.abort(); await assert.rejects(writeZip(resolve(dir, 'cancelled.zip'), inputs, controller.signal), /abort/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('redacts structured and nested serialized credentials while retaining usage and valid JSONL', () => {
  const redact = exportRedactor(['official-key']);
  const input = { apiKey: 'official-key', tokens: { input: 123 }, tool: JSON.stringify({ token: 'unknown-token', result: JSON.stringify({ password: 'nested-password' }) }), event: 'Authorization: Bearer other-secret', url: 'https://u:p@host.test?access_token=url-secret' };
  const output = redact.json(input), parsed = JSON.parse(output);
  for (const secret of ['official-key', 'unknown-token', 'nested-password', 'other-secret', 'url-secret', 'u:p@']) assert.ok(!output.includes(secret), secret);
  assert.equal(parsed.tokens.input, 123);
  assert.equal(JSON.parse(parsed.tool).token, '[已隐藏]');
  const line = redact.text(JSON.stringify({ token: 'unlisted', message: 'ordinary' })); assert.equal(JSON.parse(line).token, '[已隐藏]');
});

test('collector discloses symlinks, missing/changed evidence and checks hashes even after directory discovery', async () => {
  const dir = directory(); try {
    const issues: any[] = [], collector = new DiagnosticCollector(resolve(dir, 'out'), exportRedactor([]), signal(), issues);
    const source = put(resolve(dir, 'evidence', 'shot.png'), 'image');
    await collector.tree(dir, resolve(dir, 'evidence'), 'evidence');
    await collector.source(dir, source, 'evidence/shot.png', 'wrong-sha');
    symlinkSync(source, resolve(dir, 'linked.png'));
    await collector.source(dir, resolve(dir, 'linked.png'), 'linked.png');
    await collector.source(dir, resolve(dir, 'missing.png'), 'missing.png');
    assert.equal(collector.files.length, 1); assert.equal(collector.files[0].expectedSha256, 'wrong-sha');
    assert.ok(issues.some(issue => issue.section === 'integrity')); assert.equal(issues.length, 3);
    await collector.data('events.jsonl', [{ message: 'request {"password":"unknown"} and Authorization: Bearer unlisted-secret', seq: 1 }], 'jsonl');
    const event = JSON.parse(readFileSync(resolve(dir, 'out/events.jsonl'), 'utf8'));
    assert.equal(event.seq, 1); assert.ok(!event.message.includes('unlisted-secret')); assert.ok(!event.message.includes('unknown'));
    const limited = new DiagnosticCollector(resolve(dir, 'limited'), exportRedactor([]), signal(), [], 1);
    await limited.source(dir, source, 'large.png'); assert.equal(limited.files.length, 0); assert.equal(limited.issues.length, 1);
    const material = put(resolve(dir, randomUUID()), '{"apiKey":"embedded-secret","company":"Example"}');
    await collector.source(dir, material, 'materials/config.json');
    const document = JSON.parse(readFileSync(resolve(dir, 'out/materials/config.json'), 'utf8')); assert.equal(document.company, 'Example'); assert.equal(document.apiKey, '[已隐藏]');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('snapshot groups same-site generation/continuations/reviews, freezes inputs and never infers identity from URLs', async () => {
  const f = await fixture(); try {
    const first = f.create(); first.status = 'completed'; first.stopped = true; f.store.put(first);
    const review = f.store.ensureEvaluation(first, structuredClone(defaultAutomationSettings)), next = f.create();
    const other = { ...f.site, id: randomUUID(), siteId: randomUUID() }; f.store.saveSite(other); const unrelated = f.create(other.id), noSite = f.create('');
    f.store.event(first.id, 'first'); f.store.event(review.id, 'review'); f.store.event(next.id, 'next'); f.store.event(unrelated.id, 'unrelated');
    const snapshot = diagnosticSnapshot(f.store, first.id);
    assert.deepEqual(new Set(snapshot.tasks.map(task => task.id)), new Set([first.id, review.id, next.id]));
    assert.equal(snapshot.records.events.filter(event => ['first', 'review', 'next'].includes(event.message)).length, 3); assert.ok(snapshot.records.events.every(event => event.task_id !== unrelated.id)); assert.equal(snapshot.versions.length, 1);
    assert.deepEqual(diagnosticSnapshot(f.store, noSite.id).tasks.map(task => task.id), [noSite.id]);
  } finally { await f.close(); }
});

test('native Kooboo full-mode export streams the exact ZIP and rejects redirects or non-ZIP downloads', async () => {
  const dir = directory(), bytes = Buffer.from('PK\x05\x06' + '\0'.repeat(18)); let mode = 'ok';
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost'); assert.equal(req.headers.authorization, 'Bearer local-test'); assert.equal(url.searchParams.get('copyMode'), 'fast'); assert.equal(url.searchParams.get('SiteId'), 'native-site');
    if (url.pathname.endsWith('ExportGenerate')) return void res.end(JSON.stringify('native-site.zip'));
    if (mode === 'redirect') return void res.writeHead(302, { location: 'http://untrusted.test' }).end();
    res.end(mode === 'html' ? '<html>error</html>' : bytes);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number }, request = { origin: `http://127.0.0.1:${address.port}`, token: 'local-test', siteId: 'native-site', target: resolve(dir, 'native.zip'), signal: signal(), maxBytes: 1024 };
    assert.equal(await exportKoobooSite(request), bytes.length); assert.deepEqual(readFileSync(request.target), bytes);
    await assert.rejects(exportKoobooSite({ ...request, maxBytes: 1, target: resolve(dir, 'too-large.zip') }), /空间限制/);
    mode = 'redirect'; await assert.rejects(exportKoobooSite({ ...request, target: resolve(dir, 'redirect.zip') }), /302/);
    mode = 'html'; await assert.rejects(exportKoobooSite({ ...request, target: resolve(dir, 'html.zip') }), /不是 ZIP/);
    assert.equal(existsSync(resolve(dir, 'html.zip.part')), false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test('unfinished export is marked failed after restart and expired packages cannot be downloaded', async () => {
  const f = await fixture(); let exports: DiagnosticExports | undefined;
  try {
    const task = f.create(''), before = JSON.stringify(f.store.task(task.id));
    exports = new DiagnosticExports(f.store, f.vault, f.dir);
    const created = await exports.create(task.id), job = await finish(exports, created.id); await exports.close();
    const path = resolve(f.dir, 'diagnostic-exports', job.id, 'state.json');
    writeFileSync(path, JSON.stringify({ ...job, status: 'packing' }));
    exports = new DiagnosticExports(f.store, f.vault, f.dir);
    assert.equal(exports.get(job.id)!.status, 'failed'); assert.match(exports.get(job.id)!.error!, /重启/); assert.throws(() => exports!.download(job.id), /未就绪/); await exports.close();
    writeFileSync(path, JSON.stringify({ ...job, expiresAt: Date.now() - 1 }));
    exports = new DiagnosticExports(f.store, f.vault, f.dir); assert.equal(exports.get(job.id), undefined); assert.equal(exports.latest(task.id), undefined);
    assert.equal(JSON.stringify(f.store.task(task.id)), before);
  } finally { await exports?.close(); await f.close(); }
});

test('full export includes scoped conversations, frozen files, failed-review evidence, usage and delivery; original tasks stay untouched', async () => {
  const f = await fixture(); let exports: DiagnosticExports | undefined;
  const server = createServer((_req, res) => res.end(JSON.stringify([{ role: 'assistant', content: 'tool output', apiKey: 'historical-secret' }])));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    f.vault.update({ ...f.vault.get(), model: { endpoint: 'https://model.test/v1', name: 'model', apiKey: 'official-key' }, environments: [{ id: f.envId, name: 'test', origin, apiOrigin: origin, token: 'environment-secret' }] });
    const materialId = randomUUID(), material = { id: materialId, name: 'images/logo.png', size: 4, type: 'image/png', sha256: sha('logo') };
    put(resolve(f.dir, 'materials', materialId), 'logo');
    f.store.saveResource({ ...f.resource, files: [material] }, f.resource.id, f.resource.revision);
    const task = f.create(), threadId = randomUUID(), conversationId = randomUUID(), deliveryId = randomUUID();
    task.status = 'interrupted'; task.error = 'test failure'; task.threadId = conversationId; task.generation = { conversationId };
    task.artifacts = [{ id: randomUUID(), name: 'failed.png', size: 4, type: 'image/png', sha256: sha('shot') }];
    task.delivery = { id: deliveryId, policy: { enabled: true, endpoint: origin, targetEnvironmentId: randomUUID(), auto: false, requirePassed: true, timeoutSeconds: 30 }, status: 'failed', targetOrigin: origin, verificationThreadId: threadId, sourceEnvironmentId: f.envId, sourceSiteId: f.site.siteId, sourceUrl: f.site.url, evaluationTaskId: task.id, updatedAt: Date.now(), error: '', checks: [] };
    f.store.put(task); f.store.event(task.id, 'Authorization: Bearer hidden-event-secret');
    f.store.usage.record(task.id, { id: randomUUID(), source: 'kooboo', stage: 'generation', model: 'deepseek-flash-1017', endpoint: 'https://api.deepseek.com/v1', startedAt: Date.now(), endedAt: Date.now(), status: 'completed', basis: 'request', raw: { input_tokens: 123, output_tokens: 10 } });
    put(resolve(f.dir, 'automation-runs', task.id, 'evidence', 'failed.png'), 'shot');
    put(resolve(f.dir, 'automation-runs', task.id, 'delivery', deliveryId, 'evidence', 'delivery.txt'), 'delivery evidence');
    const home = resolve(f.dir, 'codex-runtime'); mkdirSync(home, { recursive: true });
    const rollout = put(resolve(home, 'sessions', 'scoped.jsonl'), JSON.stringify({ type: 'tool_result', token: 'scoped-secret', usage: { tokens: 42 } }) + '\n');
    const db = new DatabaseSync(resolve(home, 'state_5.sqlite')); db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT)'); db.prepare('INSERT INTO threads VALUES(?,?)').run(threadId, rollout); db.close();
    const before = JSON.stringify(f.store.db.prepare('SELECT * FROM auto_tasks ORDER BY id').all()), usageBefore = f.store.usage.entries(task.id).length;
    exports = new DiagnosticExports(f.store, f.vault, f.dir, { siteExport: async request => { writeFileSync(request.target, Buffer.from('PK\x05\x06' + '\0'.repeat(18))); return 22; } });
    const created = await exports.create(task.id), job = await finish(exports, created.id); assert.equal(job.status, 'ready', JSON.stringify(job));
    const files = unpack(exports.download(job.id).path), manifest = JSON.parse(files['manifest.json']);
    assert.equal(manifest.site, 'included'); assert.equal(manifest.complete, true); assert.ok(files['site/kooboo-site.zip']);
    assert.equal(files[`platform/inputs/materials/${materialId}/images/logo.png`], 'logo');
    assert.equal(files[`platform/artifacts/automation-runs/${task.id}/evidence/failed.png`], 'shot');
    assert.ok(files[`platform/artifacts/automation-runs/${task.id}/delivery/${deliveryId}/evidence/delivery.txt`]);
    assert.equal(JSON.parse(files[`platform/conversations/codex/${threadId}.jsonl`]).usage.tokens, 42);
    for (const secret of ['official-key', 'environment-secret', 'historical-secret', 'scoped-secret', 'hidden-event-secret']) assert.ok(!Object.values(files).join('\n').includes(secret), secret);
    for (const line of files.SHA256SUMS.trim().split('\n')) { const [digest, name] = line.split('  '); assert.equal(sha(files[name]), digest, name); }
    assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM auto_tasks ORDER BY id').all()), before); assert.equal(f.store.usage.entries(task.id).length, usageBefore);
    assert.equal(JSON.parse(files['platform/environment.json']).software.codexSdk, '0.167.0');
  } finally { await exports?.close(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});

test('offline/no-site exports remain downloadable; cancelling an export preserves the generation and queued exports', async () => {
  const f = await fixture(); let exports: DiagnosticExports | undefined;
  try {
    exports = new DiagnosticExports(f.store, f.vault, f.dir);
    const task = f.create(''), created = await exports.create(task.id), job = await finish(exports, created.id);
    assert.equal(job.status, 'partial'); assert.equal(job.site, 'unavailable'); assert.ok(unpack(exports.download(job.id).path)['platform/tasks/tasks.json']);
    await exports.close();
    let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
    f.vault.update({ ...f.vault.get(), environments: [{ id: f.envId, name: 'offline', origin: 'http://127.0.0.1:1', apiOrigin: 'http://127.0.0.1:1', token: 'test-key' }] });
    exports = new DiagnosticExports(f.store, f.vault, f.dir, { siteExport: async request => { entered(); await new Promise<void>((_resolve, reject) => { request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }); }); return 0; } });
    const activeTask = f.create(), before = JSON.stringify(f.store.task(activeTask.id)), active = await exports.create(activeTask.id); await waiting;
    const queuedTask = f.create(''), queued = await exports.create(queuedTask.id); assert.equal(queued.status, 'queued'); exports.cancel(queued.id); exports.cancel(active.id);
    assert.equal((await finish(exports, active.id)).status, 'cancelled'); assert.equal(exports.get(queued.id)!.status, 'cancelled'); assert.equal(JSON.stringify(f.store.task(activeTask.id)), before);
    assert.throws(() => exports!.download(active.id), /未就绪/);
    await exports.close(); exports = new DiagnosticExports(f.store, f.vault, f.dir); assert.equal(exports.get(job.id)!.status, 'partial');
  } finally { await exports?.close(); await f.close(); }
});

test('diagnostic routes require local session and stream an authenticated no-site archive', async () => {
  const f = await fixture(); try {
    const task = f.create(''), path = `/api/automation/tasks/${task.id}/diagnostic-exports`;
    assert.equal((await f.app.inject({ method: 'POST', url: path })).statusCode, 401);
    const login = await f.app.inject({ method: 'POST', url: '/api/login' }), headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };
    const response = await f.app.inject({ method: 'POST', url: path, headers }); assert.equal(response.statusCode, 202); const created = response.json();
    let state = created;
    for (let i = 0; i < 200 && diagnosticActive(state.status); i++) { await new Promise(resolve => setTimeout(resolve, 15)); state = (await f.app.inject({ url: `/api/automation/diagnostic-exports/${created.id}`, headers })).json(); }
    assert.equal(state.status, 'partial');
    const download = `/api/automation/diagnostic-exports/${created.id}/download`;
    assert.equal((await f.app.inject({ url: download })).statusCode, 401);
    const result = await f.app.inject({ url: download, headers }); assert.equal(result.statusCode, 200); assert.equal(result.headers['content-type'], 'application/zip'); assert.match(result.headers['content-disposition'] as string, /attachment/);
    assert.equal(result.rawPayload.readUInt32LE(0), 0x04034b50);
  } finally { await f.close(); }
});
