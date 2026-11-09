import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, cpSync, renameSync, realpathSync, symlinkSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { compareVersions, defaultUpdateRepository, stableVersion, updateProduct, type UpdateManifest, type UpdateRelease } from '../shared/update.js';
import { checkRelease, githubResponse, limitedBytes, sourceSchema } from '../server/updates/source.js';
import { sha256, unpackUpdate, verifyPayload } from '../server/updates/archive.js';
import { atomicJson, readJson } from '../server/updates/files.js';
import { registerUpdateApi } from '../server/updates/api.js';
import { maintenancePath } from '../server/updates/maintenance.js';
import { ManagedLauncher } from '../server/updates/launcher.js';
import { Vault } from '../server/lib/vault.js';
import { createApp } from '../server/app.js';
import { BackgroundWorkers } from '../server/background.js';
import { AutomationWorker } from '../server/automation/worker.js';
import { defaultAutomationSettings } from '../shared/automation.js';
import type { UpdateTransport } from '../server/updates/bridge.js';
import { prepareRelease } from '../server/updates/prepare.js';

const manifest: UpdateManifest = { schemaVersion: 1, product: updateProduct, version: '0.5.0', commit: 'a'.repeat(40), publishedAt: '2026-11-09T00:00:00Z', minLauncher: 1, dataVersion: 1, nodeMajor: 24, collectionLockSha256: sha256('lock'), platforms: ['darwin', 'win32', 'linux'], architectures: ['arm64', 'x64'], archive: { name: 'automation-0.5.0.zip', size: 123, sha256: 'b'.repeat(64) } };
const release: UpdateRelease = { id: 123, version: manifest.version, notes: '<script>never run</script>', publishedAt: manifest.publishedAt, pageUrl: `https://github.com/${defaultUpdateRepository}/releases/tag/v0.5.0`, manifest, repository: defaultUpdateRepository, assetUrl: `https://api.github.com/repos/${defaultUpdateRepository}/releases/assets/22` };
function temporary() { return realpathSync(mkdtempSync(resolve(tmpdir(), 'automation-updates-'))); }
function write(root: string, path: string, value: string | Buffer) { const target = resolve(root, path); mkdirSync(resolve(target, '..'), { recursive: true }); writeFileSync(target, value); }
const fakeFetch = ((input: string | URL | Request) => {
  const url = String(input);
  if (url.endsWith('/releases/latest')) return Promise.resolve(Response.json({ id: release.id, tag_name: 'v0.5.0', draft: false, prerelease: false, body: release.notes, published_at: release.publishedAt, html_url: release.pageUrl, assets: [{ id: 11, name: 'UPDATE_MANIFEST.json', size: 500 }, { id: 22, name: manifest.archive.name, size: manifest.archive.size }] }));
  if (url.endsWith('/assets/11')) return Promise.resolve(Response.json(manifest));
  throw new Error('Unexpected request');
}) as typeof fetch;

test('stable versions compare numerically and reject prereleases / unsafe values', () => {
  assert.equal(stableVersion('v0.4.10'), '0.4.10');
  assert.equal(compareVersions('0.4.10', '0.4.9'), 1); assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  for (const value of ['01.2.3', 'v1.2', '1.2.3-beta', '1.2.3+dirty', '9007199254740993.0.0']) assert.throws(() => stableVersion(value));
  assert.equal(sourceSchema.parse({ repository: `https://github.com/${defaultUpdateRepository}.git` }).repository, defaultUpdateRepository);
  assert.throws(() => sourceSchema.parse({ repository: 'https://evil.test/owner/repo', token: '' }));
  assert.throws(() => sourceSchema.parse({ repository: '../owner/repo', token: '' }));
});

test('GitHub resolves the packaged release and refuses missing or mismatched assets', async () => {
  const source = { repository: defaultUpdateRepository, token: '' };
  assert.deepEqual(await checkRelease(source, '0.4.0', fakeFetch), release);
  for (const patch of [{ assets: [] }, { tag_name: 'v0.6.0' }, { prerelease: true }, { html_url: 'https://evil.test/version' }]) {
    const fetcher = (async (url: Parameters<typeof fetch>[0], options: Parameters<typeof fetch>[1]) => {
      const response = await fakeFetch(url, options); return String(url).endsWith('/latest') ? Response.json({ ...await response.json(), ...patch }) : response;
    }) as typeof fetch;
    await assert.rejects(checkRelease(source, '0.4.0', fetcher));
  }
});

test('download redirects never forward credentials to asset storage or arbitrary hosts', async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const fetcher = (async (url: Parameters<typeof fetch>[0], options: Parameters<typeof fetch>[1]) => {
    seen.push({ url: String(url), auth: new Headers(options?.headers).get('authorization') });
    return seen.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/github-production-release-asset/test?signature=private' } }) : new Response('body');
  }) as typeof fetch;
  await githubResponse(release.assetUrl, { repository: defaultUpdateRepository, token: 'private-access-token' }, AbortSignal.timeout(1000), true, fetcher);
  assert.equal(seen[0].auth, 'Bearer private-access-token'); assert.equal(seen[1].auth, null);
  const bad = (async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/package' } })) as typeof fetch;
  await assert.rejects(githubResponse(release.assetUrl, { repository: defaultUpdateRepository, token: 'secret' }, AbortSignal.timeout(1000), true, bad), /不受信任/);
  await assert.rejects(githubResponse('https://api.github.com/repos/other/repo/releases/assets/1', { repository: defaultUpdateRepository, token: 'secret' }, AbortSignal.timeout(1000), true, fetcher), /不属于/);
  await assert.rejects(limitedBytes(new Response('too long'), 2, AbortSignal.timeout(1000)), /大小限制/);
});

// Independent ZIP fixture writer: exercise both stored files and DEFLATE, including real CRC checks.
function zip(entries: [string, string | Buffer][], compressed = true, unixType = 0x8000) {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [path, value] of entries) {
    const name = Buffer.from(`Kooboo-AI-Automation-Lab/${path}`), raw = Buffer.from(value), packed = compressed ? deflateRawSync(raw) : raw;
    let crc = 0xffffffff; for (const byte of raw) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; } crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(compressed ? 8 : 0, 8); header.writeUInt32LE(crc, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(0x314, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x800, 8); dir.writeUInt16LE(compressed ? 8 : 0, 10); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(raw.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(((unixType | 0o600) << 16) >>> 0, 38); dir.writeUInt32LE(offset, 42);
    local.push(header, name, packed); central.push(dir, name); offset += header.length + name.length + packed.length;
  }
  const centralBytes = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

test('ZIP rejects traversal, Windows aliases, secrets, symlinks, duplicate paths and corrupt content', () => {
  for (const compressed of [true, false]) assert.equal(unpackUpdate(zip([['docs/说明.md', 'hello']], compressed)).get('docs/说明.md')?.toString(), 'hello');
  for (const path of ['../outside', 'docs/../../outside', 'docs/a\\b', 'docs/NUL.txt', 'docs/name.', '.data/master.key', 'server/.env.production', 'docs/a:stream']) assert.throws(() => unpackUpdate(zip([[path, 'bad']])));
  assert.throws(() => unpackUpdate(zip([['docs/a', 'first'], ['docs/A', 'second']])));
  assert.throws(() => unpackUpdate(zip([['docs/link', '/private']], true, 0xa000)));
  const corrupt = zip([['docs/a', 'original']], false); corrupt[30 + Buffer.byteLength('Kooboo-AI-Automation-Lab/docs/a')] ^= 1; assert.throws(() => unpackUpdate(corrupt), /校验/);
  const bomb = zip([['docs/a', 'x']]); bomb.writeUInt32LE(65 * 1024 * 1024, bomb.length - 22 - (46 + Buffer.byteLength('Kooboo-AI-Automation-Lab/docs/a')) + 24); assert.throws(() => unpackUpdate(bomb), /体积/);
});

function payload() {
  const files = new Map<string, Buffer>([
    ['package.json', Buffer.from(JSON.stringify({ version: manifest.version }))], ['package-lock.json', Buffer.from(JSON.stringify({ version: manifest.version }))],
    ['engines/site-harvest/requirements.lock', Buffer.from('lock')],
    ['dist-server/build-info.json', Buffer.from(JSON.stringify({ product: updateProduct, version: manifest.version, commit: manifest.commit }))],
    ...['dist/index.html', 'dist-server/server/main.js', 'dist-server/server/updates/launcher.js', 'scripts/launch.mjs', 'sop/automation-collection-v1/README.md'].map(name => [name, Buffer.from('fixture')] as [string, Buffer]),
  ]);
  files.set('DELIVERY_MANIFEST.json', Buffer.from(JSON.stringify({ product: updateProduct, version: manifest.version, baseCommit: manifest.commit, sourceState: 'clean-commit', files: Object.fromEntries([...files].map(([name, bytes]) => [name, sha256(bytes)])) })));
  return files;
}
test('payload binds every file, version and source commit and rejects dirty snapshots', () => {
  const files = payload(); verifyPayload(files, manifest);
  const dirty = JSON.parse(files.get('DELIVERY_MANIFEST.json')!.toString()); dirty.sourceState = 'working-tree-test-snapshot'; files.set('DELIVERY_MANIFEST.json', Buffer.from(JSON.stringify(dirty)));
  assert.throws(() => verifyPayload(files, manifest), /测试快照/);
  const altered = payload(); altered.set('dist/index.html', Buffer.from('changed')); assert.throws(() => verifyPayload(altered, manifest), /逐文件/);
  assert.throws(() => verifyPayload(payload(), { ...manifest, version: '0.6.0' }));
});

for (const mode of ['success', 'corrupt', 'install-failure'] as const) test(`preparation ${mode} validates the real ZIP and leaves current code and data intact`, async () => {
  const root = temporary(), directory = resolve(root, 'data'); new Vault(directory);
  write(root, 'package.json', '{"version":"0.4.0"}'); write(root, 'engines/site-harvest/requirements.lock', 'lock');
  const key = readFileSync(resolve(directory, 'master.key')), bytes = zip([...payload()]);
  const targetManifest = { ...manifest, archive: { ...manifest.archive, size: bytes.length, sha256: mode === 'corrupt' ? '0'.repeat(64) : sha256(bytes) } };
  const targetRelease = { ...release, manifest: targetManifest };
  const fetcher = (async (url: Parameters<typeof fetch>[0], options: Parameters<typeof fetch>[1]) => {
    if (String(url).endsWith('/assets/22')) return new Response(bytes);
    if (String(url).endsWith('/assets/11')) return Response.json(targetManifest);
    const response = await fakeFetch(url, options), value = await response.json(); value.assets[1].size = bytes.length; return Response.json(value);
  }) as typeof fetch;
  const commands: string[][] = [];
  const run: typeof import('../server/updates/prepare.js').command = async (_executable, args, cwd) => {
    assert.notEqual(cwd, root); commands.push(args); if (mode === 'install-failure') throw new Error('synthetic component installation failure');
  };
  try {
    const operation = prepareRelease({ root, active: root, data: directory, id: randomUUID(), source: { repository: defaultUpdateRepository, token: '' }, expected: targetRelease, signal: AbortSignal.timeout(5000), progress() {} }, { fetcher, command: run, npmCli: resolve(root, 'package.json') });
    if (mode === 'success') {
      const prepared = await operation;
      assert.equal(readFileSync(resolve(prepared.candidate, 'package.json'), 'utf8'), payload().get('package.json')!.toString());
      assert.equal(commands.length, 2); assert.ok(commands[0].includes('ci')); assert.ok(commands[1].includes('chromium'));
    } else await assert.rejects(operation);
    assert.equal(readFileSync(resolve(root, 'package.json'), 'utf8'), '{"version":"0.4.0"}'); assert.deepEqual(readFileSync(resolve(directory, 'master.key')), key);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('update credentials stay encrypted, masked, and preserved when ordinary settings are saved', () => {
  const root = temporary();
  try {
    const vault = new Vault(root); vault.setUpdateSource({ repository: defaultUpdateRepository, token: 'secret-update-token', clearToken: false });
    assert.ok(!readFileSync(resolve(root, 'settings.enc')).includes(Buffer.from('secret-update-token')));
    assert.ok(!JSON.stringify(vault.public()).includes('secret-update-token'));
    vault.update(vault.get()); assert.equal(vault.updateSource().token, 'secret-update-token');
    vault.setUpdateSource({ repository: defaultUpdateRepository, token: '', clearToken: false }); assert.equal(vault.updateSource().token, 'secret-update-token');
    vault.setUpdateSource({ repository: 'other/repo', token: '', clearToken: false }); assert.equal(vault.updateSource().token, '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('update API persists successful checks and blocks writes or active claims before installation', async () => {
  const root = temporary(), directory = resolve(root, 'data'), vault = new Vault(directory), app = Fastify();
  let active = 1, applied = false, prepared: (() => void) | undefined;
  const id = randomUUID(), statePath = resolve(root, '.updates/state.json');
  const transport: UpdateTransport = { root, prepared: handler => { prepared = handler; }, close() {}, async request(method, data) {
    if (method === 'prepare') atomicJson(statePath, { id, phase: 'ready', message: '', version: release.version, updatedAt: Date.now() });
    if (method === 'blocked') atomicJson(statePath, { id, phase: 'blocked', message: data?.message, version: release.version, updatedAt: Date.now() });
    if (method === 'apply') { assert.ok(existsSync(maintenancePath(directory))); applied = true; }
  } };
  app.setErrorHandler((error, _request, reply) => reply.code(409).send({ error: error instanceof Error ? error.message : 'failed' }));
  registerUpdateApi(app, { directory, vault, transport, active: async () => active, fetcher: fakeFetch });
  app.post('/api/business-write', async () => ({ ok: true }));
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/updates/check' })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/updates' })).json().available, true);
    assert.equal((await app.inject({ method: 'POST', url: '/api/updates/install' })).statusCode, 202);
    prepared?.(); await delay(20);
    assert.equal(applied, false); assert.equal(readJson<{ phase: string }>(statePath)?.phase, 'blocked'); assert.equal(existsSync(maintenancePath(directory)), false);
    active = 0; assert.equal((await app.inject({ method: 'POST', url: '/api/updates/install' })).statusCode, 202); assert.equal(applied, true);
    assert.equal((await app.inject({ method: 'POST', url: '/api/business-write' })).statusCode, 503);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/updates/source', payload: { repository: 'other/repo' } })).statusCode, 503);
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});

test('real API retains local-session scope for update settings and defends development checkouts', async () => {
  const directory = temporary(), f = await createApp({ directory, serveWeb: false, startWorker: false });
  try {
    assert.equal((await f.app.inject('/api/updates')).statusCode, 401);
    const login = await f.app.inject({ method: 'POST', url: '/api/login' }), cookie = String(login.headers['set-cookie']).split(';')[0];
    const saved = await f.app.inject({ method: 'PUT', url: '/api/updates/source', headers: { cookie }, payload: { repository: defaultUpdateRepository, token: 'update-only-secret' } });
    assert.equal(saved.statusCode, 200); assert.equal(saved.json().source.hasToken, true); assert.ok(!saved.body.includes('update-only-secret'));
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/updates/install', headers: { cookie } })).statusCode, 409);
    assert.equal((await f.app.inject({ url: '/api/updates', headers: { authorization: `Bearer ${f.vault.credentials.readToken}` } })).statusCode, 401);
    assert.equal((await f.app.inject({ url: '/api/updates', headers: { cookie, origin: 'chrome-extension://fixture' } })).statusCode, 401);
  } finally { await f.app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('maintenance fences both queue engines without changing queue preferences or claiming tasks', async () => {
  const directory = temporary(); let executions = 0;
  const f = await createApp({ directory, serveWeb: false, startWorker: false, workerDependencies: { resolve: async () => { executions++; throw new Error('fixture should not execute'); } } });
  const worker = new AutomationWorker(f.automationStore, f.vault, directory, { generation: async () => { executions++; }, evaluation: async () => { executions++; } }, () => true);
  try {
    writeFileSync(maintenancePath(directory), JSON.stringify({ id: randomUUID() }));
    f.vault.updateAutomation({ ...defaultAutomationSettings, enabled: true });
    const resource = f.automationStore.saveResource({ name: 'maintenance fixture', scenario: 'materials', description: '', contentUrl: '', referenceUrl: '', externalSource: '', externalId: '', files: [] });
    const task = f.automationStore.create({ resourceIds: [resource.id], kind: 'generation', scope: 'homepage', environmentId: randomUUID(), requirements: '' }, f.vault.automation())[0];
    const id = randomUUID(); f.store.accept({ schemaVersion: 1, attemptId: id, requestId: id, jobId: id, trigger: 'manual', occurredAt: Date.now(), target: { koobooOrigin: 'https://fixture.test', siteId: 'fixture' }, inputs: {}, scope: 'homepage' }, 'https://fixture.test');
    worker.start(); await Promise.all([worker.tick(), f.worker.tick()]); await delay(20);
    assert.equal(executions, 0); assert.equal(f.automationStore.task(task.id)?.status, 'queued');
    assert.equal(f.vault.automation().enabled, true); assert.equal(f.vault.get().paused, false);
  } finally { await worker.stop(); await f.app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('production background process acknowledges the maintenance barrier', async () => {
  const directory = temporary(), f = await createApp({ directory, serveWeb: false });
  try {
    writeFileSync(maintenancePath(directory), JSON.stringify({ id: randomUUID() }));
    assert.ok(f.automationWorker instanceof BackgroundWorkers);
    assert.equal(await (f.automationWorker as BackgroundWorkers).quiesce(), 0);
  } finally { await f.app.close(); rmSync(directory, { recursive: true, force: true }); }
});

const fixtureEntry = `
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
const data = process.env.EVALUATOR_DATA_DIR;
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (existsSync('mutate')) writeFileSync(resolve(data, 'history.json'), 'new-schema');
process.send({type:'update:booted', version, healthy:!existsSync('fail')});
process.on('message', msg => {
  if (msg.type === 'update:shutdown') process.exit(0);
  if (msg.type === 'update:prepared') {
    const state = JSON.parse(readFileSync(resolve(process.env.EVALUATOR_INSTALL_ROOT, '.updates/state.json'), 'utf8'));
    writeFileSync(resolve(data, 'update-maintenance.json'), JSON.stringify({id:state.id}));
    process.send({type:'update:request',requestId:'apply',method:'apply'});
  }
});
process.on('disconnect',()=>process.exit(0));
const timer=setInterval(()=>{
 const trigger=resolve(data,'request-update.json');
 if(existsSync(trigger)){const input=JSON.parse(readFileSync(trigger,'utf8'));unlinkSync(trigger);process.send(input);}
},10);
`;
function fixtureRelease(root: string, version: string) { write(root, 'package.json', JSON.stringify({ type: 'module', version })); write(root, 'dist-server/server/main.js', fixtureEntry); }
async function until(check: () => boolean) { const end = Date.now() + 10000; while (!check()) { if (Date.now() > end) throw new Error('Timed out waiting for updater'); await delay(10); } }

for (const fail of [false, true]) test(`launcher switches real processes and ${fail ? 'restores old code and encrypted data on failed startup' : 'retains all user data on success'}`, async () => {
  const root = temporary(), directory = resolve(root, 'data'), candidate = resolve(root, 'releases/candidate');
  const vault = new Vault(directory); vault.setUpdateSource({ repository: defaultUpdateRepository, token: 'private-value', clearToken: false });
  const key = readFileSync(resolve(directory, 'master.key')), settings = readFileSync(resolve(directory, 'settings.enc'));
  write(directory, 'history.json', 'original-history'); fixtureRelease(root, '0.4.0'); fixtureRelease(candidate, '0.5.0');
  if (process.platform !== 'win32') { mkdirSync(resolve(directory, 'collection-runtime/bin'), { recursive: true }); symlinkSync(process.execPath, resolve(directory, 'collection-runtime/bin/python')); }
  if (fail) { write(candidate, 'fail', 'yes'); write(candidate, 'mutate', 'yes'); }
  const prepare: typeof prepareRelease = async () => ({ candidate, release });
  const launcher = new ManagedLauncher(root, directory, undefined, prepare);
  try {
    await launcher.start(); write(directory, 'request-update.json', JSON.stringify({ type: 'update:request', requestId: 'prepare', method: 'prepare', source: { repository: defaultUpdateRepository, token: '' }, release }));
    await until(() => ['completed', 'failed'].includes(readJson<{ phase: string }>(resolve(root, '.updates/state.json'))?.phase || ''));
    await until(() => !existsSync(maintenancePath(directory)));
    const state = readJson<{ phase: string; backup: string; rolledBack?: boolean }>(resolve(root, '.updates/state.json'))!;
    assert.equal(state.phase, fail ? 'failed' : 'completed'); assert.equal(Boolean(state.rolledBack), fail);
    assert.equal(readJson<{ path: string }>(resolve(root, '.updates/current.json'))?.path, fail ? root : candidate);
    assert.deepEqual(readFileSync(resolve(directory, 'master.key')), key); assert.deepEqual(readFileSync(resolve(directory, 'settings.enc')), settings);
    assert.equal(readFileSync(resolve(directory, 'history.json'), 'utf8'), 'original-history');
    assert.deepEqual(readFileSync(resolve(state.backup, 'master.key')), key);
    if (process.platform !== 'win32') assert.equal(readlinkSync(resolve(state.backup, 'collection-runtime/bin/python')), process.execPath);
  } finally { await launcher.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

for (const checkpoint of ['switching', 'restarting', 'after-rename', 'after-restore']) test(`launcher recovers interrupted transaction at ${checkpoint}`, async () => {
  const root = temporary(), directory = resolve(root, 'data'), backup = resolve(root, '.updates/backups/fixture/data'), candidate = resolve(root, 'releases/candidate'), id = randomUUID();
  new Vault(directory); fixtureRelease(root, '0.4.0'); fixtureRelease(candidate, '0.5.0'); write(directory, 'history.json', 'before'); write(directory, 'update-maintenance.json', JSON.stringify({ id }));
  cpSync(directory, backup, { recursive: true }); write(directory, 'history.json', 'after');
  const failedData = `${directory}.failed-${id}`, rollbackData = `${directory}.restore-${id}`;
  if (['after-rename', 'after-restore'].includes(checkpoint)) { cpSync(backup, rollbackData, { recursive: true }); renameSync(directory, failedData); }
  if (checkpoint === 'after-restore') renameSync(rollbackData, directory);
  atomicJson(resolve(root, '.updates/current.json'), { path: candidate });
  atomicJson(resolve(root, '.updates/state.json'), { id, phase: checkpoint === 'switching' ? 'switching' : checkpoint === 'restarting' ? 'restarting' : 'rolling-back', message: '', version: '0.5.0', previous: root, previousVersion: '0.4.0', data: directory, candidate, backup, backupReady: true, failedData, rollbackData, updatedAt: Date.now() });
  const launcher = new ManagedLauncher(root, directory);
  try { await launcher.start(); assert.equal(readFileSync(resolve(directory, 'history.json'), 'utf8'), 'before'); assert.equal(existsSync(maintenancePath(directory)), false); assert.equal(readJson<{ path: string }>(resolve(root, '.updates/current.json'))?.path, root); }
  finally { await launcher.shutdown(); rmSync(root, { recursive: true, force: true }); }
});
