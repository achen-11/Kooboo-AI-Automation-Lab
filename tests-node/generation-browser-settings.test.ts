import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';
import { Vault } from '../server/lib/vault.js';
import { defaultAutomationSettings } from '../shared/automation.js';
import { generationSession } from '../server/automation/generation-session.js';
import { UnconfirmedStop } from '../server/automation/errors.js';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'generation-browser-settings-'));
  const services = await createApp({ directory, startWorker: false, serveWeb: false });
  const login = await services.app.inject({ method: 'POST', url: '/api/login' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };
  const environmentId = randomUUID();
  services.vault.update({ ...services.vault.get(), environments: [{ id: environmentId, name: 'Test', origin: 'https://kooboo.test', apiOrigin: 'https://kooboo.test', token: 'test-environment-token' }] });
  const store = services.automationStore;
  const resource = store.saveResource({ name: 'Test', scenario: 'materials', description: '', contentUrl: '', referenceUrl: '', files: [], externalSource: '', externalId: '' });
  const site = { id: randomUUID(), siteId: randomUUID(), resourceId: resource.id, versionId: store.versions(resource.id)[0].id, environmentId, name: 'Test', url: 'https://site.test', createdAt: Date.now() };
  store.saveSite(site);
  const task = store.create({ resourceIds: [resource.id], kind: 'generation', scope: 'homepage', environmentId, generatedSiteId: site.id, requirements: '' }, structuredClone(defaultAutomationSettings))[0];
  task.generation = { conversationId: randomUUID() }; store.put(task);
  return { ...services, directory, headers, task, site, async close() { await services.app.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('browser visibility defaults off for old settings, persists, validates booleans and survives older-client saves', async () => {
  const f = await fixture();
  try {
    const old = structuredClone(defaultAutomationSettings); delete old.showExecutionBrowser;
    f.vault.updateAutomation(old);
    const read = () => f.app.inject({ url: '/api/automation/settings', headers: f.headers });
    const save = (payload: object) => f.app.inject({ method: 'PUT', url: '/api/automation/settings', headers: f.headers, payload });
    assert.equal((await read()).json().showExecutionBrowser, false);
    const key = readFileSync(join(f.directory, 'master.key'));
    assert.equal((await save({ ...old, showExecutionBrowser: true })).json().showExecutionBrowser, true);
    assert.equal(new Vault(f.directory).automation().showExecutionBrowser, true);
    assert.equal((await save({ ...old, timeoutMinutes: 90 })).json().showExecutionBrowser, true);
    const invalid = await save({ ...old, showExecutionBrowser: 'false' });
    assert.equal(invalid.statusCode, 400);
    assert.equal((await read()).json().showExecutionBrowser, true);
    assert.equal((await save({ ...old, showExecutionBrowser: false })).json().showExecutionBrowser, false);
    assert.equal(new Vault(f.directory).automation().showExecutionBrowser, false);
    assert.equal(f.vault.get().environments[0].token, 'test-environment-token');
    assert.deepEqual(readFileSync(join(f.directory, 'master.key')), key);
  } finally { await f.close(); }
});

test('generation and recovery sessions use current visibility without replacing active execution or changing its profile and identity', async t => {
  const f = await fixture();
  const launches: { profile: string; options: any; closes: number; cookies: any[]; url: string; deliveries: unknown[] }[] = [];
  t.mock.method(chromium, 'launchPersistentContext', async (profile: string, options: unknown) => {
    const launch = { profile, options, closes: 0, cookies: [] as any[], url: '', deliveries: [] as unknown[] }; launches.push(launch);
    let conversationId = 'previously-selected-chat';
    const bridge = {
      snapshot: () => ({ version: 1, taskId: f.task.id, siteId: f.site.siteId, conversationId, runId: 'run', ready: true, running: false, state: 'waiting', pending: { callId: 'pending-call', name: 'ask_user', args: {} }, observedAt: Date.now(), context: [], usage: [] }),
      selectConversation: (id: string) => { conversationId = id; },
      deliver: (input: any) => { launch.deliveries.push(input); return { id: input.id, state: 'accepted', conversationId }; },
    };
    const evaluate = (fn: Function, arg?: unknown) => runInNewContext(`(${fn.toString()})(arg)`, { window: { __koobooAutomation: bridge }, arg });
    const page = { goto: async (url: string) => { launch.url = url; }, waitForFunction: async (fn: Function) => assert.equal(evaluate(fn), true), evaluate };
    return { pages: () => [page], addCookies: async (cookies: any[]) => { launch.cookies = cookies; }, close: async () => { launch.closes++; } };
  });
  try {
    const conversationId = f.task.generation!.conversationId;
    const first = await generationSession(f.task, f.automationStore, f.vault, f.directory, new AbortController().signal);
    assert.equal(launches[0].options.headless, true);
    assert.equal(launches[0].options.channel, 'chromium');
    assert.equal(launches[0].cookies[0].name, 'jwt_token');
    assert.equal(new URL(launches[0].url).searchParams.get('SiteId'), f.site.siteId);
    f.vault.updateAutomation({ ...f.vault.automation(), showExecutionBrowser: true });
    assert.equal((await first.snapshot()).conversationId, conversationId);
    assert.equal(launches.length, 1); assert.equal(launches[0].closes, 0);
    const receipt = await first.deliver({ id: randomUUID(), conversationId: conversationId!, callId: 'pending-call', answer: { answer: 'continue' } });
    assert.equal(receipt?.state, 'accepted'); assert.equal(launches[0].deliveries.length, 1);
    await first.close(); await first.close(); assert.equal(launches[0].closes, 1);
    const controller = new AbortController();
    const recovered = await generationSession(f.task, f.automationStore, f.vault, f.directory, controller.signal);
    assert.equal(launches[1].options.headless, false);
    assert.equal(launches[1].options.channel, 'chromium');
    assert.equal(launches[0].profile, launches[1].profile);
    assert.equal((await recovered.snapshot()).conversationId, conversationId);
    controller.abort(); await recovered.close(); assert.equal(launches[1].closes, 1);
  } finally { t.mock.restoreAll(); await f.close(); }
});

test('occupied generation profile never falls back to another browser or silently relaunches', async t => {
  const f = await fixture(); let attempts = 0;
  t.mock.method(chromium, 'launchPersistentContext', async () => { attempts++; throw new Error('ProcessSingleton profile in use'); });
  try {
    const before = JSON.stringify(f.automationStore.task(f.task.id));
    await assert.rejects(generationSession(f.task, f.automationStore, f.vault, f.directory, new AbortController().signal), UnconfirmedStop);
    assert.equal(attempts, 1); assert.equal(JSON.stringify(f.automationStore.task(f.task.id)), before);
  } finally { t.mock.restoreAll(); await f.close(); }
});
