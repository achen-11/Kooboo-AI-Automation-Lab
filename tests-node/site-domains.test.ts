import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { AutomationStore } from '../server/automation/store.js';
import { Database } from '../server/runtime.js';
import { refreshSite } from '../server/automation/kooboo.js';
import { bindingDomain, generatedSiteName } from '../shared/kooboo-domains.js';
import type { GeneratedSite } from '../shared/automation.js';

async function fixture() {
  const nativeId = randomUUID(), oldUrl = 'https://auto-ab123456-abc.first.test/landing';
  const state = { domains: [{ domainName: 'first.test', sudDomainUseDash: false }, { domainName: 'ce2.local.test', sudDomainUseDash: true }],
    bindings: [{ fullName: 'auto-ab123456-abc.first.test', subDomain: 'auto-ab123456-abc', port: 0, enableSsl: true }],
    available: true, commit: true, dropResponse: false, invalidBindings: false, missingSite: false, posts: 0, creates: 0, requests: 0,
    beforePost: undefined as (() => Promise<void>) | undefined };
  const server = createServer(async (req, res) => {
    state.requests++;
    assert.equal(req.headers.authorization, 'Bearer test-only-token');
    const url = new URL(req.url!, 'http://localhost');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname.endsWith('/Domain/Available')) { res.end(JSON.stringify(state.domains)); return; }
    if (url.pathname.endsWith('/Site/List')) { res.end(JSON.stringify(state.missingSite ? [] : [{ siteId: nativeId, homePageLink: oldUrl }])); return; }
    assert.equal(url.searchParams.get('SiteId'), nativeId);
    if (url.pathname.endsWith('/Binding/ListBySite')) { res.end(JSON.stringify(state.invalidBindings ? {} : state.bindings)); return; }
    if (url.pathname.endsWith('/Binding/IsUniqueName')) { res.end(JSON.stringify(state.available)); return; }
    if (url.pathname.endsWith('/Binding/Post')) {
      state.posts++; let body = ''; for await (const chunk of req) body += chunk;
      const value = JSON.parse(body), root = state.domains.find(item => item.domainName === value.rootDomain)!;
      await state.beforePost?.();
      if (state.commit) state.bindings.push({ fullName: bindingDomain(value.subDomain, root), subDomain: value.subDomain, port: 0, enableSsl: true });
      if (state.dropResponse) { req.socket.destroy(); return; }
      res.end('null'); return;
    }
    if (url.pathname.endsWith('/Site/Create')) state.creates++;
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const directory = mkdtempSync(join(tmpdir(), 'site-domains-'));
  const services = await createApp({ directory, startWorker: false, serveWeb: false });
  const login = await services.app.inject({ method: 'POST', url: '/api/login' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] }, environmentId = randomUUID();
  services.vault.update({ ...services.vault.get(), environments: [{ id: environmentId, name: 'Test', origin, apiOrigin: origin, token: 'test-only-token' }] });
  const store = services.automationStore;
  const resource = store.saveResource({ name: 'Example', scenario: 'materials', description: '', contentUrl: '', referenceUrl: '', externalSource: '', externalId: '', files: [] });
  const site: GeneratedSite = { id: randomUUID(), siteId: nativeId, resourceId: resource.id, versionId: store.versions(resource.id)[0].id, environmentId, name: 'auto-ab123456-abc', url: oldUrl, createdAt: Date.now() };
  store.saveSite(site);
  const task = store.create({ resourceIds: [resource.id], kind: 'generation', scope: 'homepage', environmentId, generatedSiteId: site.id, requirements: '' }, services.vault.automation())[0];
  task.status = 'completed'; task.context = `Historical observation at ${oldUrl}`; store.put(task);
  const path = `/api/automation/sites/${site.id}/domains`;
  const change = (patch: Record<string, unknown> = {}) => services.app.inject({ method: 'POST', url: path, headers, payload: { rootDomain: 'first.test', subDomain: 'auto_ab123456_abc', ...patch } });
  return { ...services, state, store, directory, site, task, path, headers, change,
    async close() { await services.app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); } };
}

test('new generated names replace both prefix and UUID hyphens', () => {
  assert.equal(generatedSiteName('ab123456-abcd-4321-9876-123456789abc'), 'auto_ab123456_abc');
  assert.doesNotMatch(generatedSiteName(randomUUID()), /-/);
});

test('domain options suggest the corrected current name; API requires a local authorized session', async () => {
  const f = await fixture(); try {
    assert.equal((await f.app.inject({ url: f.path })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url: f.path, payload: {}, headers: { authorization: `Bearer ${f.vault.credentials.readToken}` } })).statusCode, 401);
    assert.equal(f.state.requests, 0);
    const result = await f.app.inject({ url: f.path, headers: f.headers });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().subDomain, 'auto_ab123456_abc'); assert.equal(result.json().rootDomain, 'first.test');
    assert.equal(f.state.posts, 0); assert.ok(!result.body.includes('test-only-token'));
  } finally { await f.close(); }
});

test('rebinding retains site identity and history, updates every task and survives a later refresh and restart', async () => {
  const f = await fixture(); try {
    const queued = f.store.create({ resourceIds: [f.site.resourceId], kind: 'evaluation', scope: 'homepage', environmentId: f.site.environmentId, generatedSiteId: f.site.id, requirements: '' }, f.vault.automation())[0];
    f.store.db.prepare('INSERT INTO auto_site_state VALUES(?,?,?)').run(f.site.id, 'old-revision', 'old-report');
    const result = await f.change(); assert.equal(result.statusCode, 200, result.body);
    const site = result.json() as GeneratedSite;
    assert.equal(site.siteId, f.site.siteId); assert.equal(site.id, f.site.id); assert.equal(site.name, f.site.name);
    assert.equal(site.url, 'https://auto_ab123456_abc.first.test/landing');
    assert.equal(f.state.bindings.length, 2); assert.equal(f.state.creates, 0);
    assert.equal(f.store.task(f.task.id)!.siteUrl, site.url); assert.equal(f.store.header(queued.id)!.siteUrl, site.url);
    assert.equal(f.store.task(f.task.id)!.context, f.task.context); assert.equal(f.store.task(f.task.id)!.status, 'completed');
    assert.notEqual(f.store.siteState(site.id)!.revision, 'old-revision'); assert.equal(f.store.siteState(site.id)!.reportId, null);
    assert.equal(f.store.task(queued.id)!.siteRevision, f.store.siteState(site.id)!.revision);
    await refreshSite(f.store.task(f.task.id)!, f.store, f.vault, AbortSignal.timeout(5000));
    assert.equal(f.store.site(site.id)!.url, site.url);
    const db = new Database(join(f.directory, 'database.sqlite'));
    try { assert.equal(new AutomationStore(db).site(site.id)!.preferredDomain, site.preferredDomain); } finally { db.close(); }
    assert.equal((await f.change()).statusCode, 200); assert.equal(f.state.posts, 1);
  } finally { await f.close(); }
});

test('root separator metadata remains authoritative while custom subdomains reject hyphens and punctuation', async () => {
  const f = await fixture(); try {
    for (const subDomain of ['old-name', 'a.b', 'bad/name', '', '_'.repeat(64)]) assert.equal((await f.change({ subDomain })).statusCode, 400);
    assert.equal(f.state.requests, 0);
    assert.equal((await f.change({ rootDomain: 'missing.test' })).statusCode, 409);
    const result = await f.change({ rootDomain: 'ce2.local.test', subDomain: 'fixed_name' });
    assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().url, 'https://fixed_name-ce2.local.test/landing');
    assert.equal(f.state.posts, 1);
  } finally { await f.close(); }
});

test('Hong Kong roots round-trip through suggestions, rebinding and refresh without duplicate separators', async () => {
  const f = await fixture(); try {
    f.state.domains.push({ domainName: '-shawnchen-hk.kooboo.io', sudDomainUseDash: true });
    f.site.url = 'https://salon_demo-shawnchen-hk.kooboo.io/landing'; f.store.saveSite(f.site);
    const options = await f.app.inject({ url: f.path, headers: f.headers });
    assert.equal(options.statusCode, 200, options.body);
    assert.equal(options.json().rootDomain, '-shawnchen-hk.kooboo.io');
    assert.equal(options.json().subDomain, 'salon_demo');
    // Old saved roots may omit the separator; the Post must still use the available root's literal value.
    const changed = await f.change({ rootDomain: 'shawnchen-hk.kooboo.io', subDomain: 'salon_updated' });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(changed.json().url, 'https://salon_updated-shawnchen-hk.kooboo.io/landing');
    assert.equal(f.state.posts, 1);
    await refreshSite(f.store.task(f.task.id)!, f.store, f.vault, AbortSignal.timeout(5000));
    assert.equal(f.store.site(f.site.id)!.url, changed.json().url);
    const refreshed = await f.app.inject({ url: f.path, headers: f.headers });
    assert.equal(refreshed.json().subDomain, 'salon_updated');
  } finally { await f.close(); }
});

test('occupied domains, missing sites and invalid receipts never replace the local address', async () => {
  const f = await fixture(); try {
    f.state.available = false;
    const occupied = await f.change(); assert.equal(occupied.statusCode, 409); assert.match(occupied.json().error, /占用/); assert.equal(f.state.posts, 0);
    f.state.available = true; f.state.missingSite = true;
    assert.equal((await f.change()).statusCode, 409); assert.equal(f.state.posts, 0);
    f.state.missingSite = false; f.state.invalidBindings = true;
    assert.equal((await f.change()).statusCode, 500); assert.equal(f.state.posts, 0);
    f.state.invalidBindings = false; f.state.commit = false;
    const unconfirmed = await f.change(); assert.equal(unconfirmed.statusCode, 409); assert.match(unconfirmed.json().error, /尚未确认/);
    assert.equal(f.store.site(f.site.id)!.url, f.site.url); assert.equal(f.store.task(f.task.id)!.siteUrl, f.site.url);
    assert.equal(f.store.domainReserved(f.site.id), false);
  } finally { await f.close(); }
});

test('a lost Post response is reconciled against actual bindings without a second Post', async () => {
  const f = await fixture(); try {
    f.state.dropResponse = true;
    assert.equal((await f.change()).statusCode, 200);
    assert.equal((await f.change()).statusCode, 200); assert.equal(f.state.posts, 1);
    f.state.bindings.splice(1);
    await assert.rejects(refreshSite(f.store.task(f.task.id)!, f.store, f.vault, AbortSignal.timeout(5000)), /绑定不存在/);
    assert.equal(f.store.site(f.site.id)!.preferredDomain, 'auto_ab123456_abc.first.test');
  } finally { await f.close(); }
});

test('active site work blocks rebind before remote access', async () => {
  const f = await fixture(); try {
    for (const status of ['running', 'following-up', 'cancelling'] as const) {
      f.task.status = status; f.task.stopped = status !== 'running'; f.store.put(f.task);
      assert.equal((await f.change()).statusCode, 409);
    }
    assert.equal(f.state.requests, 0); assert.equal(f.store.domainReserved(f.site.id), false);
  } finally { await f.close(); }
});

test('a queued review with a previous execution must retain its old evidence and cannot cross a rebind', async () => {
  const f = await fixture(); try {
    const review = f.store.create({ resourceIds: [f.site.resourceId], kind: 'evaluation', scope: 'homepage', environmentId: f.site.environmentId, generatedSiteId: f.site.id, requirements: '' }, f.vault.automation())[0];
    const token = f.store.evaluations.begin(review.id); f.store.evaluations.finish(review.id, token, true);
    const result = await f.change(); assert.equal(result.statusCode, 409); assert.match(result.json().error, /旧地址证据/);
    assert.equal(f.state.requests, 0); assert.equal(f.store.task(review.id)!.siteUrl, f.site.url);
    assert.equal(f.store.evaluations.get(review.id)!.state, 'stopped');
  } finally { await f.close(); }
});

test('the SQLite rebind reservation excludes parallel requests and worker claims on a separate connection', async () => {
  const f = await fixture(); let release!: () => void;
  const db = new Database(join(f.directory, 'database.sqlite'));
  try {
    const worker = new AutomationStore(db);
    const queued = f.store.create({ resourceIds: [f.site.resourceId], kind: 'evaluation', scope: 'homepage', environmentId: f.site.environmentId, generatedSiteId: f.site.id, requirements: '' }, f.vault.automation())[0];
    let entered!: () => void; const start = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
    f.state.beforePost = async () => { entered(); await gate; };
    const pending = f.change(); void pending.then(); await start;
    assert.equal(worker.domainReserved(f.site.id), true); assert.equal(worker.claim('evaluation', 1), undefined);
    assert.equal((await f.change()).statusCode, 409);
    release(); assert.equal((await pending).statusCode, 200);
    const claimed = worker.claim('evaluation', 1)!;
    assert.equal(claimed.id, queued.id); assert.equal(claimed.siteUrl, 'https://auto_ab123456_abc.first.test/landing');
    f.store.db.prepare('INSERT INTO auto_site_domain_locks VALUES(?,?,?)').run(f.site.id, randomUUID(), 0);
    assert.equal(worker.domainReserved(f.site.id), false);
  } finally { release?.(); db.close(); await f.close(); }
});
