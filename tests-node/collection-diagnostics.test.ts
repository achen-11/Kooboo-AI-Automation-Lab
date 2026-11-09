import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { CollectionRun } from '../shared/collection.js';
import type { CollectionStore } from '../server/automation/collection/store.js';
import { collectionHash } from '../server/automation/collection/runtime.js';
import { diagnoseCollectionResource, type DiagnosticFetch, type DiagnosticLookup } from '../server/automation/collection/diagnostics.js';

const assetUrl = 'https://assets.example/image.svg?version=2';
const publicLookup: DiagnosticLookup = async () => [{ address: '8.8.8.8', family: 4 }];
function fixture(url = assetUrl) {
  const root = mkdtempSync(resolve(tmpdir(), 'collection-diagnostic-test-'));
  const state = { stylesheets: [{ url: 'https://assets.example/common.css' }], assets: [{ url, status: 'failed', note: 'http-403' }], files: [] };
  mkdirSync(resolve(root, '.work'));
  writeFileSync(resolve(root, '.work/state.json'), JSON.stringify(state));
  writeFileSync(resolve(root, 'original.txt'), 'untouched');
  const collections = { workspace: () => root, json: (_run: CollectionRun, path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8')) } as unknown as CollectionStore;
  const run = { id: 'collection-id', inputVersionId: 'input-version', engineVersion: 'frozen-engine', sourceUrl: 'https://source.example/article', checks: [{ id: 'A6', status: 'failed' }] } as CollectionRun;
  return { root, collections, run, state, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('diagnostic persists response bytes, hash and binding without mutating collection decisions', async () => {
  const f = fixture();
  try {
    const body = '<svg>' + 'x'.repeat(5000) + '</svg>', beforeRun = JSON.stringify(f.run);
    const fetch: DiagnosticFetch = async (url, options) => {
      assert.equal(url, assetUrl);
      assert.deepEqual(options.addresses, [{ address: '8.8.8.8', family: 4 }]);
      assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual');
      assert.deepEqual(Object.keys(options.headers).sort(), ['accept', 'accept-encoding', 'referer', 'user-agent']);
      assert.equal(options.headers['accept-encoding'], 'identity');
      assert.equal(options.headers.referer, f.run.sourceUrl);
      return new Response(body, { status: 403, headers: { 'content-type': 'image/svg+xml', 'set-cookie': 'secret', authorization: 'secret', server: 'mock-server' } });
    };
    const result = await diagnoseCollectionResource(f.collections, f.run, assetUrl, { fetch, lookup: publicLookup });
    assert.equal(result.outcome, 'response'); assert.equal(result.status, 403);
    assert.equal(result.sha256, collectionHash(Buffer.from(body))); assert.equal(result.bytes, Buffer.byteLength(body));
    assert.equal(readFileSync(resolve(f.root, result.bodyPath), 'utf8'), body); assert.equal(result.preview.length, 4000);
    const meta = JSON.parse(readFileSync(resolve(f.root, result.metadataPath), 'utf8'));
    assert.deepEqual(meta.binding, { collectionId: 'collection-id', inputVersionId: 'input-version', engineVersion: 'frozen-engine' });
    assert.equal(meta.attempts[0].headers.server, 'mock-server'); assert.equal(meta.attempts[0].headers['set-cookie'], undefined);
    assert.equal(meta.attempts[0].headers.authorization, undefined);
    assert.deepEqual(meta.requestHeaders, result.requestHeaders);
    assert.deepEqual(meta.attempts[0].requestHeaders, result.requestHeaders);
    assert.deepEqual(Object.keys(result.requestHeaders).sort(), ['accept', 'accept-encoding', 'referer', 'user-agent']);
    assert.equal(JSON.stringify(f.run), beforeRun);
    assert.deepEqual(JSON.parse(readFileSync(resolve(f.root, '.work/state.json'), 'utf8')), f.state);
    assert.equal(readFileSync(resolve(f.root, 'original.txt'), 'utf8'), 'untouched');
  } finally { f.close(); }
});

test('unknown or non-exact URL is rejected before DNS/network and leaves failed metadata', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const result = await diagnoseCollectionResource(f.collections, f.run, assetUrl.replace('version=2', 'version=3'), {
      lookup: async () => { calls++; return []; }, fetch: async () => { calls++; return new Response('unexpected'); },
    });
    assert.equal(calls, 0); assert.equal(result.outcome, 'failed'); assert.match(result.error!, /未.*登记/);
    assert.equal(JSON.parse(readFileSync(resolve(f.root, result.metadataPath), 'utf8')).outcome, 'failed');
  } finally { f.close(); }
});

test('timeout bounds a transport that ignores AbortSignal and leaves request evidence', async () => {
  const f = fixture();
  try {
    const started = Date.now();
    const result = await diagnoseCollectionResource(f.collections, f.run, assetUrl, { lookup: publicLookup, timeoutMs: 15, fetch: () => new Promise(() => {}) });
    assert.equal(result.outcome, 'failed'); assert.match(result.error!, /时限/); assert.ok(Date.now() - started < 1000);
    assert.equal(result.attempts.length, 1); assert.equal(readFileSync(resolve(f.root, result.bodyPath)).length, 0);
    assert.match(JSON.parse(readFileSync(resolve(f.root, result.attempts[0].metadataPath), 'utf8')).error, /时限/);
  } finally { f.close(); }
});

test('public redirect to private IP saves redirect response and blocks the next connection', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const result = await diagnoseCollectionResource(f.collections, f.run, assetUrl, {
      lookup: publicLookup, fetch: async () => { calls++; return new Response('redirect evidence', { status: 302, headers: { location: 'http://127.0.0.1/admin' } }); },
    });
    assert.equal(calls, 1); assert.equal(result.outcome, 'failed'); assert.match(result.error!, /私有|保留/);
    assert.equal(result.attempts.length, 2); assert.equal(result.attempts[0].status, 302); assert.equal(result.attempts[1].status, null);
    assert.equal(readFileSync(resolve(f.root, result.attempts[0].bodyPath), 'utf8'), 'redirect evidence');
  } finally { f.close(); }
});

test('each redirect resolves again and rejects mixed public/private DNS answers', async () => {
  const f = fixture();
  try {
    const hosts: string[] = []; let calls = 0;
    const result = await diagnoseCollectionResource(f.collections, f.run, assetUrl, {
      lookup: async hostname => { hosts.push(hostname); return hostname === 'assets.example' ? [{ address: '8.8.8.8', family: 4 }] : [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]; },
      fetch: async () => { calls++; return new Response('moved', { status: 301, headers: { location: 'https://other.example/file' } }); },
    });
    assert.equal(calls, 1); assert.deepEqual(hosts, ['assets.example', 'other.example']); assert.match(result.error!, /DNS/);
  } finally { f.close(); }
});

test('registered unsafe URLs fail closed without calling DNS or network', async () => {
  for (const url of ['file:///etc/passwd', 'https://name:password@public.example/file', 'http://localhost./file', 'http://127.1/file', 'http://[::ffff:127.0.0.1]/file', 'http://[2001:db8::1]/file', 'https://printer.lan/file']) {
    const f = fixture(url);
    try {
      let calls = 0;
      const result = await diagnoseCollectionResource(f.collections, f.run, url, { lookup: async () => { calls++; return []; }, fetch: async () => { calls++; return new Response('unexpected'); } });
      assert.equal(result.outcome, 'failed', url); assert.equal(calls, 0, url);
    } finally { f.close(); }
  }
});

test('no more than three redirects are followed; every received response is retained', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const result = await diagnoseCollectionResource(f.collections, f.run, assetUrl, { lookup: publicLookup, fetch: async () => new Response(`hop ${++calls}`, { status: 302, headers: { location: `/hop-${calls}` } }) });
    assert.equal(calls, 4); assert.equal(result.attempts.length, 4); assert.match(result.error!, /重定向超过 3/);
    result.attempts.forEach((attempt, index) => assert.equal(readFileSync(resolve(f.root, attempt.bodyPath), 'utf8'), `hop ${index + 1}`));
  } finally { f.close(); }
});

test('10 MiB aggregate cap retains partial bytes and never returns binary preview', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const result = await diagnoseCollectionResource(f.collections, f.run, assetUrl, { lookup: publicLookup, fetch: async () => {
      calls++;
      if (calls === 1) return new Response(Buffer.alloc(6 * 1024 * 1024, 1), { status: 302, headers: { location: '/large' } });
      return new Response(Buffer.alloc(5 * 1024 * 1024, 2), { headers: { 'content-type': 'application/octet-stream' } });
    } });
    assert.equal(result.outcome, 'failed'); assert.equal(result.truncated, true); assert.match(result.error!, /10 MiB/);
    assert.equal(result.attempts.reduce((n, item) => n + item.bytes, 0), 10 * 1024 * 1024);
    assert.equal(result.preview, ''); assert.equal(result.bytes, 4 * 1024 * 1024);
    assert.equal(result.sha256, collectionHash(readFileSync(resolve(f.root, result.bodyPath))));
  } finally { f.close(); }
});

test('body streaming timeout preserves bytes already received', async () => {
  const f = fixture();
  try {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('partial')); } });
    const result = await diagnoseCollectionResource(f.collections, f.run, assetUrl, { lookup: publicLookup, timeoutMs: 15, fetch: async () => new Response(stream, { headers: { 'content-type': 'text/plain' } }) });
    assert.equal(result.outcome, 'failed'); assert.equal(result.status, 200); assert.equal(result.preview, 'partial');
    assert.equal(readFileSync(resolve(f.root, result.bodyPath), 'utf8'), 'partial');
  } finally { f.close(); }
});

test('compressed response remains original bytes and has no undecoded text preview', async () => {
  const f = fixture();
  try {
    const original = Buffer.from([0x1f, 0x8b, 0x08, 0x00]);
    const result = await diagnoseCollectionResource(f.collections, f.run, assetUrl, { lookup: publicLookup, fetch: async () => new Response(original, { headers: { 'content-type': 'text/css', 'content-encoding': 'gzip' } }) });
    assert.equal(result.outcome, 'response'); assert.equal(result.contentEncoding, 'gzip'); assert.equal(result.preview, '');
    assert.deepEqual(readFileSync(resolve(f.root, result.bodyPath)), original);
  } finally { f.close(); }
});

test('asset and file diagnostics use their registered same-source page Referer and persist it per hop', async () => {
  for (const kind of ['assets', 'files'] as const) {
    const f = fixture();
    try {
      const pageUrl = 'https://WWW.SOURCE.EXAMPLE./cn/show/1058?lang=zh#photo';
      writeFileSync(resolve(f.root, '.work/state.json'), JSON.stringify({ [kind]: [{ url: assetUrl, pageUrl }] }));
      const expected = new URL(pageUrl); expected.hash = '';
      let calls = 0;
      const result = await diagnoseCollectionResource(f.collections, f.run, assetUrl, { lookup: publicLookup, fetch: async (_url, options) => {
        assert.equal(options.headers.referer, expected.href); calls++;
        return calls === 1 ? new Response('moved', { status: 302, headers: { location: '/final-image' } }) : new Response('ok');
      } });
      assert.equal(result.outcome, 'response'); assert.equal(calls, 2); assert.equal(result.requestHeaders.referer, expected.href);
      const aggregate = JSON.parse(readFileSync(resolve(f.root, result.metadataPath), 'utf8'));
      assert.equal(aggregate.requestHeaders.referer, expected.href);
      for (const attempt of result.attempts) {
        assert.equal(attempt.requestHeaders.referer, expected.href);
        assert.equal(JSON.parse(readFileSync(resolve(f.root, attempt.metadataPath), 'utf8')).requestHeaders.referer, expected.href);
      }
    } finally { f.close(); }
  }
});

test('foreign, credential-bearing and unsafe registered page URLs fall back to source Referer', async () => {
  for (const pageUrl of ['https://evil.example/article', 'https://source.example.evil.example/article', 'https://user:password@source.example/article', 'file:///source.example/article', 'http://localhost/article', '/relative/article']) {
    const f = fixture();
    try {
      writeFileSync(resolve(f.root, '.work/state.json'), JSON.stringify({ assets: [{ url: assetUrl, pageUrl }] }));
      const result = await diagnoseCollectionResource(f.collections, f.run, assetUrl, { lookup: publicLookup, fetch: async (_url, options) => {
        assert.equal(options.headers.referer, f.run.sourceUrl); return new Response('ok');
      } });
      assert.equal(result.outcome, 'response', pageUrl); assert.equal(result.requestHeaders.referer, f.run.sourceUrl);
    } finally { f.close(); }
  }
});

test('stylesheet diagnostics retain source Referer even if a stylesheet record has pageUrl', async () => {
  const f = fixture();
  try {
    writeFileSync(resolve(f.root, '.work/state.json'), JSON.stringify({ stylesheets: [{ url: assetUrl, pageUrl: 'https://source.example/other-page' }] }));
    const result = await diagnoseCollectionResource(f.collections, f.run, assetUrl, { lookup: publicLookup, fetch: async (_url, options) => {
      assert.equal(options.headers.referer, f.run.sourceUrl); return new Response('ok');
    } });
    assert.equal(result.requestHeaders.referer, f.run.sourceUrl);
  } finally { f.close(); }
});
