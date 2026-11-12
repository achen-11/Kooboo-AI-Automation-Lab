import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { Vault } from '../server/lib/vault.js';
import { executeGeneration } from '../server/automation/generator.js';
import type { AutomationTask, Scenario } from '../shared/automation.js';
import { bindingDomain, findRootDomain, parseRootDomains, rootDomainLabel, splitBindingDomain } from '../shared/kooboo-domains.js';
import { availableSiteNames } from '../server/automation/site-naming.js';
import { AutomationStore } from '../server/automation/store.js';

test('Hong Kong suffixes retain the server root and separator exactly once', () => {
  for (const raw of ['-shawnchen-hk.kooboo.io', { domainName: '-shawnchen-hk.kooboo.io', sudDomainUseDash: true }, { DomainName: '-shawnchen-hk.kooboo.io', SudDomainUseDash: false }, 'shawnchen-hk.kooboo.io']) {
    const domains = parseRootDomains([raw]);
    const root = findRootDomain(domains, 'shawnchen-hk.kooboo.io')!;
    assert.equal(rootDomainLabel(root), '-shawnchen-hk.kooboo.io');
    assert.equal(bindingDomain('salon_demo', root), 'salon_demo-shawnchen-hk.kooboo.io');
    assert.deepEqual(splitBindingDomain('salon_demo-shawnchen-hk.kooboo.io', [...domains, { domainName: 'kooboo.io', sudDomainUseDash: false }]), { root, subDomain: 'salon_demo' });
    assert.equal(splitBindingDomain('salon_demoxshawnchen-hk.kooboo.io', domains), undefined);
  }
  assert.deepEqual(parseRootDomains([{ domainName: 'shawnchen-hk.kooboo.io', sudDomainUseDash: false }]), [{ domainName: 'shawnchen-hk.kooboo.io', sudDomainUseDash: false }]);
});

test('conflict suffixes fit both the Kooboo name and the complete Hong Kong hostname label', async () => {
  const root = { domainName: '-shawnchen-hk.kooboo.io', sudDomainUseDash: true };
  const name = 'a'.repeat(63), domain = 'b'.repeat(63 - '-shawnchen-hk'.length);
  const chosen = await availableSiteNames(name, domain, root, async path => {
    const url = new URL(path, 'https://test.local');
    return ![name, domain].includes([...url.searchParams.values()].at(-1)!);
  });
  assert.equal(chosen.siteName, 'a'.repeat(61) + '_1');
  assert.equal(chosen.subDomain, domain.slice(0, -2) + '_1');
  assert.equal(bindingDomain(chosen.subDomain, root).split('.')[0].length, 63);
});

async function fixture() {
  const state = { domains: [{ domainName: 'first.test', sudDomainUseDash: false }, { domainName: 'chosen.test', sudDomainUseDash: true }],
    domainStatus: 200, invalidJson: false, createStatus: 200, nameFree: true as unknown, domainFree: true as unknown,
    occupiedNames: [] as string[], occupiedDomains: [] as string[], siteId: randomUUID(), reportedSiteName: 'unrelated', requests: [] as string[], creates: [] as { path: string; body: Record<string, unknown> }[] };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost'), path = url.pathname;
    state.requests.push(path);
    res.setHeader('Content-Type', 'application/json');
    if (path === '/home') { assert.equal(req.headers.authorization, undefined); res.end('homepage'); return; }
    assert.equal(req.headers.authorization, 'Bearer private-test-token');
    if (path.endsWith('/Domain/Available')) {
      res.statusCode = state.domainStatus;
      res.end(state.invalidJson ? 'private-test-token' : JSON.stringify(state.domains)); return;
    }
    if (path.endsWith('/Site/IsUniqueName')) { res.end(JSON.stringify(state.occupiedNames.includes(url.searchParams.get('SiteName')!) ? false : state.nameFree)); return; }
    if (path.endsWith('/Site/IsSubdomainAvailable')) { res.end(JSON.stringify(state.occupiedDomains.includes(url.searchParams.get('SubDomain')!) ? false : state.domainFree)); return; }
    if (path.endsWith('/Site/Create') || path.endsWith('/Transfer/ByLevel')) {
      let text = ''; for await (const chunk of req) text += chunk;
      state.creates.push({ path, body: JSON.parse(text) }); res.statusCode = state.createStatus;
      res.end(JSON.stringify({ siteId: state.siteId, taskId: 'transfer-task' })); return;
    }
    if (path.endsWith('/Site/List')) {
      res.end(JSON.stringify([{ siteId: state.siteId, siteName: state.reportedSiteName, homePageLink: origin + '/home' }])); return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const directory = mkdtempSync(join(tmpdir(), 'root-domains-'));
  const services = await createApp({ directory, serveWeb: false, startWorker: false });
  const login = await services.app.inject({ method: 'POST', url: '/api/login' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };
  const environmentId = randomUUID();
  services.vault.update({ ...services.vault.get(), environments: [{ id: environmentId, name: 'Test', origin, apiOrigin: origin, token: 'private-test-token', defaultRootDomain: 'chosen.test' }] });
  const save = async (scenario: Scenario = 'materials', patch: Record<string, unknown> = {}) => {
    const result = await services.app.inject({ method: 'POST', url: '/api/automation/resources', headers,
      payload: { name: 'Example', scenario, description: '', contentUrl: scenario === 'upgrade' ? 'https://content.test' : '', referenceUrl: scenario === 'upgrade' ? 'https://reference.test' : '', externalSource: '', externalId: '', files: [], ...patch } });
    assert.equal(result.statusCode, 201, result.body); return result.json();
  };
  const create = async (patch: Record<string, unknown> = {}, key = randomUUID()) => {
    const resource = await save();
    return services.app.inject({ method: 'POST', url: '/api/automation/tasks', headers: { ...headers, 'idempotency-key': key },
      payload: { resourceIds: [resource.id], kind: 'generation', scope: 'homepage', environmentId, ...patch } });
  };
  return { ...services, state, directory, headers, environmentId, origin, save, create,
    async close() { await services.app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); } };
}

test('environment default roots survive encrypted save, restart, import and credential reconnect', async () => {
  const f = await fixture();
  const importedDirectory = mkdtempSync(join(tmpdir(), 'root-domain-import-'));
  try {
    const settings = f.vault.get(); settings.environments[0].defaultRootDomain = ' .CHOSEN.test ';
    const saved = await f.app.inject({ method: 'PUT', url: '/api/settings', headers: f.headers, payload: settings });
    assert.equal(saved.statusCode, 200); assert.equal(saved.json().environments[0].defaultRootDomain, 'chosen.test');
    assert.ok(!saved.body.includes('private-test-token'));
    assert.equal(new Vault(f.directory).get().environments[0].defaultRootDomain, 'chosen.test');
    const copy = new Vault(importedDirectory); copy.importInitial(f.vault.get(), f.vault.credentials);
    assert.equal(copy.public().environments[0].defaultRootDomain, 'chosen.test');
    const expected = f.vault.get().environments[0];
    f.vault.connectEnvironment({ id: expected.id, name: expected.name, origin: expected.origin, apiOrigin: expected.apiOrigin }, expected.token, expected);
    assert.equal(f.vault.get().environments[0].defaultRootDomain, 'chosen.test');
    const oldClient = f.vault.get(); delete oldClient.environments[0].defaultRootDomain;
    f.vault.update(oldClient); assert.equal(f.vault.get().environments[0].defaultRootDomain, 'chosen.test');
    oldClient.environments[0].defaultRootDomain = '';
    f.vault.update(oldClient); assert.equal(f.vault.get().environments[0].defaultRootDomain, '');
  } finally { await f.close(); rmSync(importedDirectory, { recursive: true, force: true }); }
});

test('available roots use saved environment credentials, preserve separators and reject unauthorized access', async () => {
  const f = await fixture(); try {
    const path = `/api/environments/${f.environmentId}/domains`;
    assert.equal((await f.app.inject({ url: path })).statusCode, 401);
    assert.equal((await f.app.inject({ url: path, headers: { authorization: `Bearer ${f.vault.credentials.readToken}` } })).statusCode, 401);
    assert.equal(f.state.requests.length, 0);
    const result = await f.app.inject({ url: path, headers: f.headers });
    assert.equal(result.statusCode, 200); assert.deepEqual(result.json().items, f.state.domains);
    assert.equal((await f.app.inject({ url: `/api/environments/${randomUUID()}/domains`, headers: f.headers })).statusCode, 404);
    f.state.invalidJson = true;
    const invalid = await f.app.inject({ url: path, headers: f.headers });
    assert.equal(invalid.statusCode, 422); assert.ok(!invalid.body.includes('private-test-token'));
    f.state.domainStatus = 401;
    const denied = await f.app.inject({ url: path, headers: f.headers });
    assert.equal(denied.statusCode, 422); assert.match(denied.json().error, /登录/);
  } finally { await f.close(); }
});

test('batch enqueue freezes the default or explicit root, and idempotent retries ignore later default changes', async () => {
  const f = await fixture(); try {
    const resources = [await f.save(), await f.save()];
    const headers = { ...f.headers, 'idempotency-key': randomUUID() };
    const payload = { resourceIds: resources.map(r => r.id), kind: 'generation', scope: 'homepage', environmentId: f.environmentId };
    const result = await f.app.inject({ method: 'POST', url: '/api/automation/tasks', headers, payload });
    assert.equal(result.statusCode, 201); const tasks = result.json().items as AutomationTask[];
    assert.deepEqual(tasks.map(t => t.generation?.rootDomain), ['chosen.test', 'chosen.test']);
    const settings = f.vault.get(); settings.environments[0].defaultRootDomain = 'first.test'; f.vault.update(settings);
    const repeated = await f.app.inject({ method: 'POST', url: '/api/automation/tasks', headers, payload });
    assert.deepEqual(repeated.json(), result.json());
    const override = await f.create({ rootDomain: ' .CHOSEN.test ' });
    assert.equal(override.json().items[0].generation.rootDomain, 'chosen.test');
    const stored = f.automationStore.task(tasks[0].id)!; assert.equal(stored.generation?.rootDomain, 'chosen.test');
    const section = await f.app.inject({ url: `/api/automation/tasks/${stored.id}/sections/input`, headers: f.headers });
    assert.equal(section.json().rootDomain, 'chosen.test');
    assert.equal(f.state.requests.length, 0, 'queue submission does not contact or create a Kooboo site');
    const conflicting = await f.app.inject({ method: 'POST', url: '/api/automation/tasks', headers, payload: { ...payload, rootDomain: 'first.test' } });
    assert.equal(conflicting.statusCode, 409);
  } finally { await f.close(); }
});

test('root selection rejects URLs and cannot change an existing site during continuation or evaluation', async () => {
  const f = await fixture(); try {
    for (const rootDomain of ['https://chosen.test', 'chosen.test/path', 'chosen.test:80', 'bad domain', '']) {
      const result = await f.create({ rootDomain }); assert.equal(result.statusCode, 400, rootDomain);
    }
    const resource = await f.save();
    const site = { id: randomUUID(), resourceId: resource.id, versionId: f.automationStore.versions(resource.id)[0].id, environmentId: f.environmentId, siteId: randomUUID(), name: 'Existing', url: f.origin + '/home', createdAt: Date.now() };
    f.automationStore.saveSite(site);
    for (const kind of ['generation', 'evaluation']) {
      const payload = { resourceIds: [resource.id], environmentId: f.environmentId, generatedSiteId: site.id, kind, scope: 'homepage' };
      const rejected = await f.app.inject({ method: 'POST', url: '/api/automation/tasks', headers: { ...f.headers, 'idempotency-key': randomUUID() }, payload: { ...payload, rootDomain: 'chosen.test' } });
      assert.equal(rejected.statusCode, 400);
      const accepted = await f.app.inject({ method: 'POST', url: '/api/automation/tasks', headers: { ...f.headers, 'idempotency-key': randomUUID() }, payload });
      assert.equal(accepted.statusCode, 201); assert.equal(accepted.json().items[0].generation?.rootDomain, undefined);
    }
  } finally { await f.close(); }
});

test('external imports preserve per-resource naming and freeze it in each queued task', async () => {
  const f = await fixture(); try {
    const values = ['salon_one', 'salon_two'].map((name, i) => ({ name, scenario: 'materials', description: '', contentUrl: '', referenceUrl: '', files: [], externalSource: 'admin', externalId: name, siteName: name, subDomain: `${name}_public`, rootDomain: i ? 'first.test' : '-shawnchen-hk.kooboo.io' }));
    const imported = await f.app.inject({ method: 'POST', url: '/api/v1/resources/import', headers: { authorization: `Bearer ${f.vault.credentials.ingestToken}` }, payload: values });
    assert.equal(imported.statusCode, 200, imported.body);
    const resources = imported.json().items;
    const payload = { resourceIds: resources.map((r: { id: string }) => r.id), kind: 'generation', scope: 'homepage', environmentId: f.environmentId };
    const headers = { ...f.headers, 'idempotency-key': randomUUID() };
    const queued = await f.app.inject({ method: 'POST', url: '/api/automation/tasks', headers, payload });
    assert.equal(queued.statusCode, 201, queued.body);
    const tasks = queued.json().items as AutomationTask[];
    assert.deepEqual(tasks.map(t => t.generation), values.map(v => ({ siteName: v.siteName, subDomain: v.subDomain, rootDomain: v.rootDomain })));
    const updated = await f.app.inject({ method: 'POST', url: '/api/v1/resources/import', headers: f.headers, payload: [{ ...values[0], subDomain: 'changed' }] });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(f.automationStore.task(tasks[0].id)!.generation?.subDomain, 'salon_one_public');
    assert.equal(f.automationStore.version(tasks[0].versionId)!.subDomain, 'salon_one_public');
    const section = await f.app.inject({ url: `/api/automation/tasks/${tasks[0].id}/sections/input`, headers: f.headers });
    assert.equal(section.json().version.siteName, 'salon_one');
    assert.equal(section.json().version.subDomain, 'salon_one_public');
    assert.equal(section.json().version.rootDomain, '-shawnchen-hk.kooboo.io');
    const repeated = await f.app.inject({ method: 'POST', url: '/api/automation/tasks', headers, payload });
    assert.deepEqual(repeated.json(), queued.json());
    const override = await f.app.inject({ method: 'POST', url: '/api/automation/tasks', headers: { ...f.headers, 'idempotency-key': randomUUID() }, payload: { ...payload, resourceIds: [resources[0].id], siteName: ' Salon_New ', subDomain: ' Salon_Public ', rootDomain: 'chosen.test' } });
    assert.equal(override.statusCode, 201, override.body);
    assert.deepEqual(override.json().items[0].generation, { siteName: 'salon_new', subDomain: 'salon_public', rootDomain: 'chosen.test' });
    const partial = await f.app.inject({ method: 'POST', url: '/api/automation/tasks', headers: { ...f.headers, 'idempotency-key': randomUUID() }, payload: { ...payload, resourceIds: [resources[1].id], subDomain: 'public_override' } });
    assert.equal(partial.statusCode, 201, partial.body);
    assert.deepEqual(partial.json().items[0].generation, { siteName: 'salon_two', subDomain: 'public_override', rootDomain: 'first.test' });
    assert.equal(f.state.creates.length, 0);
  } finally { await f.close(); }
});

test('a supplied name alone supplies the missing counterpart, while unnamed requests retain automatic naming', async () => {
  const f = await fixture(); try {
    for (const field of ['siteName', 'subDomain']) {
      const created = await f.create({ [field]: 'salon_custom' });
      assert.equal(created.statusCode, 201, created.body);
      assert.deepEqual(created.json().items[0].generation, { siteName: 'salon_custom', subDomain: 'salon_custom', rootDomain: 'chosen.test' });
    }
    const auto = await f.create();
    assert.deepEqual(auto.json().items[0].generation, { rootDomain: 'chosen.test' });
  } finally { await f.close(); }
});

test('custom task names reject invalid input, batches and attempts to rename an existing site', async () => {
  const f = await fixture(); try {
    for (const field of ['siteName', 'subDomain']) {
      for (const value of ['', 'bad-name', 'https://demo.test', 'bad.name', '../bad', 'a'.repeat(64)]) assert.equal((await f.create({ [field]: value })).statusCode, 400);
      const resource = await f.save();
      const site = { id: randomUUID(), resourceId: resource.id, versionId: f.automationStore.versions(resource.id)[0].id, environmentId: f.environmentId, siteId: randomUUID(), name: 'Existing', url: f.origin + '/home', createdAt: Date.now() };
      f.automationStore.saveSite(site);
      for (const kind of ['generation', 'evaluation']) {
        const result = await f.app.inject({ method: 'POST', url: '/api/automation/tasks', headers: { ...f.headers, 'idempotency-key': randomUUID() }, payload: { resourceIds: [resource.id], kind, scope: 'homepage', environmentId: f.environmentId, generatedSiteId: site.id, [field]: 'custom' } });
        assert.equal(result.statusCode, 400);
      }
    }
    const resources = [await f.save(), await f.save()];
    const batch = await f.app.inject({ method: 'POST', url: '/api/automation/tasks', headers: { ...f.headers, 'idempotency-key': randomUUID() }, payload: { resourceIds: resources.map(r => r.id), kind: 'generation', scope: 'homepage', environmentId: f.environmentId, subDomain: 'shared' } });
    assert.equal(batch.statusCode, 400);
  } finally { await f.close(); }
});

for (const scenario of ['materials', 'upgrade'] as const) test(`${scenario} creation sends the supplied names and literal Hong Kong root to Kooboo`, async () => {
  const f = await fixture(); try {
    f.state.domains = [{ domainName: '-shawnchen-hk.kooboo.io', sudDomainUseDash: true }];
    const resource = await f.save(scenario);
    const task = f.automationStore.create({ resourceIds: [resource.id], kind: 'generation', scope: 'homepage', environmentId: f.environmentId, siteName: 'salon_internal', subDomain: 'salon_public', rootDomain: 'shawnchen-hk.kooboo.io', requirements: '' }, f.vault.automation())[0];
    task.generation = { ...task.generation, deliveryState: 'completed', transferComplete: true };
    await executeGeneration(task, f.automationStore, f.vault, f.directory, AbortSignal.timeout(5000));
    const body = f.state.creates[0].body;
    assert.equal(body.SiteName || body.siteName, 'salon_internal');
    assert.equal(body.SubDomain || body.subDomain, 'salon_public');
    assert.equal(body.RootDomain || body.rootDomain, '-shawnchen-hk.kooboo.io');
    assert.equal(task.generation.rootDomain, '-shawnchen-hk.kooboo.io');
  } finally { await f.close(); }
});

test('imported names use _1, _2 suffixes when occupied and preserve the original input snapshot', async () => {
  const f = await fixture(); try {
    const resource = await f.save('materials', { siteName: 'salon', subDomain: 'salon_public', rootDomain: '-shawnchen-hk.kooboo.io' });
    f.state.domains = [{ domainName: '-shawnchen-hk.kooboo.io', sudDomainUseDash: true }];
    f.state.occupiedNames = ['salon', 'salon_1']; f.state.occupiedDomains = ['salon_public', 'salon_public_1'];
    const task = f.automationStore.create({ resourceIds: [resource.id], kind: 'generation', scope: 'homepage', environmentId: f.environmentId, requirements: '' }, f.vault.automation())[0];
    task.generation!.deliveryState = 'completed';
    await executeGeneration(task, f.automationStore, f.vault, f.directory, AbortSignal.timeout(5000));
    assert.equal(f.state.creates.length, 1);
    assert.deepEqual(f.state.creates[0].body, { SiteName: 'salon_2', SubDomain: 'salon_public_2', RootDomain: '-shawnchen-hk.kooboo.io', SiteType: 'p' });
    const restored = f.automationStore.task(task.id)!;
    assert.equal(restored.generation?.siteName, 'salon_2'); assert.equal(restored.generation?.subDomain, 'salon_public_2');
    const section = await f.app.inject({ url: `/api/automation/tasks/${task.id}/sections/input`, headers: f.headers });
    assert.equal(section.json().version.subDomain, 'salon_public'); assert.equal(section.json().subDomain, 'salon_public_2');
  } finally { await f.close(); }
});

for (const field of ['siteName', 'subDomain'] as const) test(`only the occupied ${field} receives a suffix`, async () => {
  const f = await fixture(); try {
    const task = (await f.create({ siteName: 'salon_internal', subDomain: 'salon_public' })).json().items[0] as AutomationTask;
    if (field === 'siteName') f.state.occupiedNames = ['salon_internal'];
    else f.state.occupiedDomains = ['salon_public'];
    task.generation!.deliveryState = 'completed';
    await executeGeneration(task, f.automationStore, f.vault, f.directory, AbortSignal.timeout(5000));
    assert.equal(f.state.creates[0].body.SiteName, field === 'siteName' ? 'salon_internal_1' : 'salon_internal');
    assert.equal(f.state.creates[0].body.SubDomain, field === 'subDomain' ? 'salon_public_1' : 'salon_public');
  } finally { await f.close(); }
});

test('unknown availability or exhausted suffixes never submits a create', async () => {
  const f = await fixture(); try {
    const task = (await f.create({ subDomain: 'salon' })).json().items[0] as AutomationTask;
    f.state.nameFree = null;
    await assert.rejects(executeGeneration(task, f.automationStore, f.vault, f.directory, AbortSignal.timeout(5000)), /无法确认/);
    f.state.nameFree = true; f.state.domainFree = { available: true };
    await assert.rejects(executeGeneration(task, f.automationStore, f.vault, f.directory, AbortSignal.timeout(5000)), /无法确认/);
    f.state.domainFree = false;
    await assert.rejects(executeGeneration(task, f.automationStore, f.vault, f.directory, AbortSignal.timeout(5000)), /连续 100 次/);
    assert.equal(task.generation?.createAttempted, undefined); assert.equal(f.state.creates.length, 0);
  } finally { await f.close(); }
});

test('invalid inherited subdomains reject the entire batch before enqueueing; dash roots remain valid', async () => {
  const f = await fixture(); try {
    const good = await f.save('materials', { siteName: 'good', subDomain: 'good', rootDomain: '-shawnchen-hk.kooboo.io' });
    const bad = await f.save();
    // Simulate previously stored data that bypassed the current import schema.
    f.automationStore.saveResource({ ...bad, subDomain: 'old-name' }, bad.id, bad.revision);
    const create = (ids: string[], patch = {}) => f.app.inject({ method: 'POST', url: '/api/automation/tasks', headers: { ...f.headers, 'idempotency-key': randomUUID() }, payload: { resourceIds: ids, kind: 'generation', scope: 'homepage', environmentId: f.environmentId, ...patch } });
    const rejected = await create([good.id, bad.id]);
    assert.equal(rejected.statusCode, 409); assert.match(rejected.json().error, /子域名不能包含连字符/);
    assert.equal(f.automationStore.tasks().length, 0); assert.equal(f.state.requests.length, 0);
    assert.equal((await create([good.id])).statusCode, 201);
    assert.equal((await create([bad.id], { siteName: 'fixed', subDomain: 'fixed' })).statusCode, 201);
  } finally { await f.close(); }
});

test('legacy queued hyphenated subdomains stop before any create', async () => {
  const f = await fixture(); try {
    const task = (await f.create()).json().items[0] as AutomationTask;
    task.generation = { ...task.generation, siteName: 'valid', subDomain: 'old-name' };
    await assert.rejects(executeGeneration(task, f.automationStore, f.vault, f.directory, AbortSignal.timeout(5000)), /子域名不能包含连字符/);
    assert.equal(f.state.creates.length, 0); assert.equal(task.generation.createAttempted, undefined);
  } finally { await f.close(); }
});

test('input resolves automatic names before execution and saved identity for historical tasks with only a root checkpoint', async () => {
  const f = await fixture(); try {
    const task = (await f.create()).json().items[0] as AutomationTask;
    const path = `/api/automation/tasks/${task.id}/sections/input`;
    const planned = (await f.app.inject({ url: path, headers: f.headers })).json();
    assert.equal(planned.siteName, `auto_${task.id.slice(0, 12).replace(/-/g, '_')}`);
    assert.equal(planned.subDomain, planned.siteName);
    const site = { id: randomUUID(), resourceId: task.resourceId, versionId: task.versionId, environmentId: task.environmentId, siteId: randomUUID(), name: 'saved_internal', url: 'https://saved_public-shawnchen-hk.kooboo.io/', createdAt: Date.now() };
    f.automationStore.saveSite(site);
    task.generatedSiteId = site.id; task.generation = { rootDomain: '-shawnchen-hk.kooboo.io' }; f.automationStore.put(task);
    const historical = (await f.app.inject({ url: path, headers: f.headers })).json();
    assert.equal(historical.siteName, 'saved_internal'); assert.equal(historical.subDomain, 'saved_public');
    assert.equal(historical.rootDomain, '-shawnchen-hk.kooboo.io'); assert.equal(f.state.requests.length, 0);
    const review = f.automationStore.create({ resourceIds: [task.resourceId], kind: 'evaluation', scope: 'homepage', environmentId: f.environmentId, generatedSiteId: site.id, requirements: '' }, f.vault.automation())[0];
    const reviewInput = (await f.app.inject({ url: `/api/automation/tasks/${review.id}/sections/input`, headers: f.headers })).json();
    assert.equal(reviewInput.siteName, 'saved_internal'); assert.equal(reviewInput.subDomain, 'saved_public');
    assert.equal(reviewInput.rootDomain, '-shawnchen-hk.kooboo.io');
  } finally { await f.close(); }
});

async function oldNamingConflict(f: Awaited<ReturnType<typeof fixture>>) {
  const task = (await f.create({ siteName: 'salon_internal', subDomain: 'salon_public' })).json().items[0] as AutomationTask;
  f.automationStore.interrupt(task, { reason: '自定义站点名或子域名已被占用或无法确认可用，请修改名称后新建任务', nextSteps: ['原有的通用恢复提示'], evidence: [], attempted: [], resumeFrom: '准备' });
  return task;
}

test('a legacy naming conflict exposes an action, persists available suffixes and queues the same task without creating a site', async () => {
  const f = await fixture(); try {
    const task = await oldNamingConflict(f), version = f.automationStore.version(task.versionId)!;
    f.automationStore.db.prepare("UPDATE auto_task_index SET json=json_remove(json,'$.summary.canAdjustSiteNames','$.canAdjustSiteNames') WHERE id=?").run(task.id);
    const upgraded = new AutomationStore(f.automationStore.db);
    assert.equal(upgraded.header(task.id)!.summary.canAdjustSiteNames, true, 'upgrade backfills the action for historical conflicts');
    f.state.occupiedNames = ['salon_internal']; f.state.occupiedDomains = ['salon_public', 'salon_public_1'];
    const summary = (await f.app.inject({ url: `/api/automation/tasks/${task.id}/summary`, headers: f.headers })).json();
    assert.equal(summary.task.canAdjustSiteNames, true);
    const execution = (await f.app.inject({ url: `/api/automation/tasks/${task.id}/sections/execution`, headers: f.headers })).json();
    assert.equal(execution.task.canAdjustSiteNames, true); assert.match(execution.interruption.nextSteps[0], /自动调整名称并继续/);
    const path = `/api/automation/tasks/${task.id}/adjust-site-names`;
    const result = await f.app.inject({ method: 'POST', url: path, headers: f.headers });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().id, task.id); assert.equal(result.json().status, 'queued');
    assert.deepEqual(result.json().generation, { siteName: 'salon_internal_1', subDomain: 'salon_public_2', rootDomain: 'chosen.test' });
    assert.equal(result.json().followup, undefined); assert.equal(result.json().interruption, undefined);
    assert.deepEqual(f.automationStore.version(task.versionId), version); assert.equal(f.automationStore.tasks().length, 1);
    assert.equal(f.state.creates.length, 0);
    const duplicate = await f.app.inject({ method: 'POST', url: path, headers: f.headers });
    assert.equal(duplicate.statusCode, 409);
  } finally { await f.close(); }
});

test('naming recovery rejects unsafe states before contacting Kooboo and keeps failures unchanged', async () => {
  const f = await fixture(); try {
    const task = await oldNamingConflict(f), path = `/api/automation/tasks/${task.id}/adjust-site-names`;
    assert.equal((await f.app.inject({ method: 'POST', url: path })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url: path, headers: { authorization: `Bearer ${f.vault.credentials.readToken}` } })).statusCode, 401);
    for (const patch of [ { generation: { ...task.generation, createAttempted: true } }, { stopped: false }, { threadId: 'sent-conversation' }, { generatedSiteId: randomUUID() }, { generation: { ...task.generation, deliveryId: 'accepted-delivery' } } ]) {
      f.automationStore.put({ ...task, ...patch });
      const rejected = await f.app.inject({ method: 'POST', url: path, headers: f.headers });
      assert.equal(rejected.statusCode, 409, rejected.body);
    }
    assert.equal(f.state.requests.length, 0);
    f.automationStore.put(task); f.state.domainFree = null;
    const unknown = await f.app.inject({ method: 'POST', url: path, headers: f.headers });
    assert.equal(unknown.statusCode, 409); assert.match(unknown.json().error, /无法确认/); assert.equal(f.automationStore.task(task.id)!.status, 'interrupted');
    assert.deepEqual(f.automationStore.task(task.id)!.generation, task.generation); assert.equal(f.state.creates.length, 0);
  } finally { await f.close(); }
});

test('an uncertain custom-name creation reconciles the frozen name without a second create', async () => {
  const f = await fixture(); try {
    const task = (await f.create({ siteName: 'salon_internal', subDomain: 'salon_public' })).json().items[0] as AutomationTask;
    f.state.occupiedNames = ['salon_internal']; f.state.occupiedDomains = ['salon_public'];
    f.state.createStatus = 503;
    await assert.rejects(executeGeneration(task, f.automationStore, f.vault, f.directory, AbortSignal.timeout(5000)), /禁止自动重复建站/);
    const restored = f.automationStore.task(task.id)!;
    f.state.reportedSiteName = 'salon_internal_1';
    await assert.rejects(executeGeneration(restored, f.automationStore, f.vault, f.directory, AbortSignal.timeout(5000)), /已找到并绑定/);
    assert.equal(f.state.creates.length, 1); assert.equal(restored.generation?.subDomain, 'salon_public_1');
  } finally { await f.close(); }
});

for (const scenario of ['materials', 'upgrade'] as const) test(`${scenario} creation passes the frozen root to Kooboo, independent of list order and current default`, async () => {
  const f = await fixture(); try {
    const resource = await f.save(scenario);
    const task = f.automationStore.create({ resourceIds: [resource.id], kind: 'generation', scope: 'homepage', environmentId: f.environmentId, rootDomain: 'chosen.test', requirements: '' }, f.vault.automation())[0];
    task.generation = { ...task.generation, deliveryState: 'completed', transferComplete: true };
    const settings = f.vault.get(); settings.environments[0].defaultRootDomain = 'first.test'; f.vault.update(settings);
    await executeGeneration(task, f.automationStore, f.vault, f.directory, AbortSignal.timeout(5000));
    assert.equal(f.state.creates.length, 1);
    const { path, body } = f.state.creates[0];
    assert.equal(path, scenario === 'upgrade' ? '/_api/v2/Transfer/ByLevel' : '/_api/v2/Site/Create');
    assert.equal(body.RootDomain || body.rootDomain, 'chosen.test');
    assert.equal(body.SubDomain || body.subDomain, `auto_${task.id.slice(0, 12).replace(/-/g, '_')}`);
    assert.equal(task.siteUrl, f.origin + '/home');
  } finally { await f.close(); }
});

test('an unavailable frozen root stops before creation and cannot silently switch to an available default', async () => {
  const f = await fixture(); try {
    const created = await f.create(); const task = created.json().items[0] as AutomationTask;
    f.state.domains = [f.state.domains[0]];
    await assert.rejects(executeGeneration(task, f.automationStore, f.vault, f.directory, AbortSignal.timeout(5000)), /chosen\.test.*已不可用/);
    assert.equal(task.generation?.createAttempted, undefined); assert.equal(f.state.creates.length, 0);
    const settings = f.vault.get(); settings.environments[0].defaultRootDomain = 'first.test'; f.vault.update(settings);
    const restored = f.automationStore.task(task.id)!;
    await assert.rejects(executeGeneration(restored, f.automationStore, f.vault, f.directory, AbortSignal.timeout(5000)), /chosen\.test.*已不可用/);
    assert.equal(f.state.creates.length, 0);
  } finally { await f.close(); }
});

test('legacy tasks pin their first root before an uncertain creation, and retries do not create a second site', async () => {
  const f = await fixture(); try {
    const settings = f.vault.get(); settings.environments[0].defaultRootDomain = ''; f.vault.update(settings);
    const created = await f.create(); const task = created.json().items[0] as AutomationTask;
    assert.equal(task.generation?.rootDomain, undefined);
    f.state.createStatus = 503;
    await assert.rejects(executeGeneration(task, f.automationStore, f.vault, f.directory, AbortSignal.timeout(5000)), /禁止自动重复建站/);
    const restored = f.automationStore.task(task.id)!;
    assert.equal(restored.generation?.rootDomain, 'first.test'); assert.equal(restored.generation?.createAttempted, true);
    assert.equal(restored.generation?.siteName, `auto_${task.id.slice(0, 12).replace(/-/g, '_')}`);
    f.state.domains.reverse();
    await assert.rejects(executeGeneration(restored, f.automationStore, f.vault, f.directory, AbortSignal.timeout(5000)), /禁止重复创建/);
    assert.equal(f.state.creates.length, 1);
  } finally { await f.close(); }
});

for (const legacy of [false, true]) test(`uncertain ${legacy ? 'pre-upgrade' : 'new'} creation reconciles its original name without another create`, async () => {
  const f = await fixture(); try {
    const task = (await f.create()).json().items[0] as AutomationTask;
    const name = legacy ? `auto-${task.id.slice(0, 12)}` : `auto_${task.id.slice(0, 12).replace(/-/g, '_')}`;
    task.generation = { createAttempted: true, ...(legacy ? {} : { siteName: name }) }; f.automationStore.put(task);
    f.state.reportedSiteName = name;
    await assert.rejects(executeGeneration(task, f.automationStore, f.vault, f.directory, AbortSignal.timeout(5000)), /已找到并绑定先前创建的站点/);
    assert.equal(f.state.creates.length, 0); assert.ok(task.generatedSiteId);
    assert.equal(f.automationStore.site(task.generatedSiteId!)!.siteId, f.state.siteId);
    assert.equal(f.automationStore.site(task.generatedSiteId!)!.name, name);
  } finally { await f.close(); }
});
