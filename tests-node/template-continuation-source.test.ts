import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Database } from '../server/runtime.js';
import { AutomationStore } from '../server/automation/store.js';
import { TemplateWorkflowStore } from '../server/automation/template-workflow-store.js';
import { ManifestStore, compactSourceHtml, sourceReader } from '../server/automation/completeness.js';
import { Conflict } from '../server/lib/store.js';
import { defaultAutomationSettings, type AutomationTask } from '../shared/automation.js';

function createFixture(scope: AutomationTask['scope'] = 'site') {
  const directory = mkdtempSync(resolve(tmpdir(), 'template-cont-'));
  const db = new Database(':memory:');
  const store = new AutomationStore(db);
  const registry = new TemplateWorkflowStore(store);
  const manifests = new ManifestStore(store);
  const environmentId = randomUUID();
  const resource = store.saveResource({
    name: 'Stageo Template',
    scenario: 'site-template',
    description: 'Template resource',
    contentUrl: '',
    referenceUrl: 'https://reference.test/',
    files: [],
    externalId: '',
    externalSource: '',
  });
  const root = store.create(
    {
      resourceIds: [resource.id],
      kind: 'generation',
      scope,
      environmentId,
      requirements: '',
    },
    defaultAutomationSettings,
  )[0];
  return {
    directory,
    db,
    store,
    registry,
    manifests,
    environmentId,
    resource,
    root,
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('standalone continuation generation and evaluation inherit templateWorkflow and latest manifest on existing site', () => {
  const f = createFixture('site');
  try {
    f.registry.initialize(f.root);
    assert.ok(f.root.templateWorkflow);

    const manifestV1 = f.manifests.save(
      f.root,
      {
        sourceComplete: true,
        limitations: [],
        evidence: [],
        items: [
          {
            id: 'home',
            title: 'Home Page',
            kind: 'page',
            required: true,
            source: 'https://reference.test/',
            expectation: 'Match reference homepage',
            paths: ['/'],
            expectedCount: 1,
            viewports: ['desktop', 'mobile'],
          },
        ],
      },
      'ai',
    );

    const site = {
      id: randomUUID(),
      resourceId: f.resource.id,
      versionId: f.root.versionId,
      environmentId: f.environmentId,
      siteId: randomUUID(),
      name: 'Stageo Target',
      url: 'https://target.test/',
      createdAt: Date.now(),
    };
    f.store.saveSite(site);
    f.root.generatedSiteId = site.id;
    f.root.siteUrl = site.url;
    f.store.put(f.root);

    // Standalone evaluation (no parentId) on the templateWorkflow site.
    const standaloneEval = f.store.create(
      {
        resourceIds: [f.resource.id],
        kind: 'evaluation',
        scope: 'site',
        environmentId: f.environmentId,
        generatedSiteId: site.id,
        versionId: f.root.versionId,
        requirements: '',
      },
      defaultAutomationSettings,
    )[0];
    f.registry.initialize(standaloneEval);
    assert.deepEqual(standaloneEval.templateWorkflow, f.root.templateWorkflow);
    assert.equal(standaloneEval.requirementsId, manifestV1.id);

    // Independent evaluation extends the manifest to revision 2.
    const manifestV2 = f.manifests.save(
      standaloneEval,
      {
        sourceComplete: true,
        limitations: [],
        evidence: [],
        items: [
          ...manifestV1.items,
          {
            id: 'events',
            title: 'Events Page',
            kind: 'page',
            required: true,
            source: 'https://reference.test/events',
            expectation: 'Include events subpage',
            paths: ['/events'],
            expectedCount: 1,
            viewports: ['desktop', 'mobile'],
          },
        ],
      },
      'ai',
      manifestV1.id,
    );
    assert.equal(manifestV2.revision, 2);

    // Standalone continuation generation (no parentId) inherits templateWorkflow AND newest manifest.
    const continuation = f.store.create(
      {
        resourceIds: [f.resource.id],
        kind: 'generation',
        scope: 'site',
        environmentId: f.environmentId,
        generatedSiteId: site.id,
        versionId: f.root.versionId,
        requirements: 'Fix subpage navigation',
      },
      defaultAutomationSettings,
    )[0];
    f.registry.initialize(continuation);
    assert.deepEqual(continuation.templateWorkflow, f.root.templateWorkflow);
    assert.equal(continuation.requirementsId, manifestV2.id);
  } finally {
    f.close();
  }
});

test('standalone site-scope continuation rejects site created by homepage templateWorkflow to prevent silent downgrade', () => {
  const f = createFixture('homepage');
  try {
    f.registry.initialize(f.root);
    assert.ok(f.root.templateWorkflow);

    const site = {
      id: randomUUID(),
      resourceId: f.resource.id,
      versionId: f.root.versionId,
      environmentId: f.environmentId,
      siteId: randomUUID(),
      name: 'Homepage Target',
      url: 'https://target.test/',
      createdAt: Date.now(),
    };
    f.store.saveSite(site);
    f.root.generatedSiteId = site.id;
    f.store.put(f.root);

    assert.throws(
      () =>
        f.store.create(
          {
            resourceIds: [f.resource.id],
            kind: 'generation',
            scope: 'site',
            environmentId: f.environmentId,
            generatedSiteId: site.id,
            versionId: f.root.versionId,
            requirements: '',
          },
          defaultAutomationSettings,
        ),
      (err: unknown) => err instanceof Conflict && /冻结基线不含内页/.test(err.message),
    );
  } finally {
    f.close();
  }
});

test('legacy site without templateWorkflow history does not auto-upgrade on standalone continuation or evaluation', () => {
  const f = createFixture('site');
  try {
    // Notice f.registry.initialize(f.root) is NOT called (historical legacy root).
    const site = {
      id: randomUUID(),
      resourceId: f.resource.id,
      versionId: f.root.versionId,
      environmentId: f.environmentId,
      siteId: randomUUID(),
      name: 'Legacy Site',
      url: 'https://legacy.test/',
      createdAt: Date.now(),
    };
    f.store.saveSite(site);
    f.root.generatedSiteId = site.id;
    f.store.put(f.root);

    const continuation = f.store.create(
      {
        resourceIds: [f.resource.id],
        kind: 'generation',
        scope: 'site',
        environmentId: f.environmentId,
        generatedSiteId: site.id,
        versionId: f.root.versionId,
        requirements: '',
      },
      defaultAutomationSettings,
    )[0];
    f.registry.initialize(continuation);
    assert.equal(continuation.templateWorkflow, undefined);

    const standaloneEval = f.store.create(
      {
        resourceIds: [f.resource.id],
        kind: 'evaluation',
        scope: 'site',
        environmentId: f.environmentId,
        generatedSiteId: site.id,
        versionId: f.root.versionId,
        requirements: '',
      },
      defaultAutomationSettings,
    )[0];
    f.registry.initialize(standaloneEval);
    assert.equal(standaloneEval.templateWorkflow, undefined);
  } finally {
    f.close();
  }
});

test('sourceReader compacts oversized inline Framer-style styles and scripts while preserving DOM, links, and JSON-LD', async () => {
  const framerHtml = [
    '<!doctype html><html><head><title>Stageo Opera</title>',
    `<style>${'body{color:#111;margin:0}'.repeat(9000)}</style>`,
    `<script>window.__FRAMER__=${'1'.repeat(40000)}</script>`,
    '<script type="application/ld+json">{"@type":"Event","name":"Velvet Hunger"}</script>',
    '</head><body><main><h1>Stageo Opera House</h1>',
    '<a href="/events/velvet-hunger">Velvet Hunger</a>',
    `<img src="data:image/svg+xml;base64,${'A'.repeat(400)}" alt="Hero" />`,
    '</main></body></html>',
  ].join('\n');
  assert.ok(framerHtml.length > 180000);

  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(framerHtml);
  });
  const directory = mkdtempSync(resolve(tmpdir(), 'framer-source-'));
  const db = new Database(':memory:');
  const store = new AutomationStore(db);

  try {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const sourceUrl = `http://127.0.0.1:${address.port}/`;
    const resource = store.saveResource({
      name: 'Framer',
      scenario: 'site-template',
      description: '',
      contentUrl: sourceUrl,
      referenceUrl: sourceUrl,
      files: [],
      externalSource: '',
      externalId: '',
    });
    const task = store.create(
      {
        resourceIds: [resource.id],
        kind: 'generation',
        scope: 'site',
        environmentId: randomUUID(),
        requirements: '',
      },
      defaultAutomationSettings,
    )[0];

    const result = (await sourceReader(task, store, directory, (value) => value)(
      { kind: 'source', url: sourceUrl },
      new AbortController().signal,
    )) as {
      status: number;
      body: string;
      truncated: boolean;
      inlineAssetsStripped?: boolean;
    };

    assert.equal(result.status, 200);
    assert.equal(result.truncated, true);
    assert.equal(result.inlineAssetsStripped, true);
    assert.ok(result.body.length <= 100000);
    assert.ok(result.body.includes('<title>Stageo Opera</title>'));
    assert.ok(result.body.includes('Stageo Opera House'));
    assert.ok(result.body.includes('/events/velvet-hunger'));
    assert.ok(result.body.includes('Velvet Hunger'));
    assert.ok(result.body.includes('data:[omitted]'));
    assert.equal(result.body.includes('window.__FRAMER__'), false);

    // Plain large text without inline style/script keeps byte-exact slice semantics.
    const plain = '<html><body>' + 'abc1234567'.repeat(15000) + '</body></html>';
    const plainCompacted = compactSourceHtml(plain, 100000);
    assert.equal(plainCompacted.body, plain.slice(0, 100000));
    assert.equal(plainCompacted.truncated, true);
    assert.equal(plainCompacted.inlineAssetsStripped, undefined);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
