import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMaterialPreview, materialFormat, materialNodes, visibleMaterialNodes, MATERIAL_TEXT_LIMIT } from '../frontend/src/lib/material-browser.js';

test('material hierarchy groups interleaved paths, counts descendants and sorts folders before naturally ordered files', () => {
  const files = ['Pack/image10.jpg', 'Pack/images/nested/a.jpg', 'Pack/README.md', 'Pack/image2.jpg', 'Pack/images/b.jpg', 'loose.txt'].map((name, index) => ({ id: String(index), name }));
  const nodes = materialNodes(files);
  assert.deepEqual(nodes.map(node => node.key), ['Pack', 'Pack/images', 'Pack/images/nested', 'Pack/images/nested/a.jpg', 'Pack/images/b.jpg', 'Pack/image2.jpg', 'Pack/image10.jpg', 'Pack/README.md', 'loose.txt']);
  assert.equal(nodes.find(node => node.key === 'Pack')?.count, 5);
  assert.equal(nodes.find(node => node.key === 'Pack/images')?.count, 2);
  assert.equal(nodes.find(node => node.key === 'Pack/images/nested/a.jpg')?.file, files[1]);
  assert.equal(nodes.find(node => node.key === 'Pack/images/nested/a.jpg')?.depth, 3);
  assert.equal(files[0].name, 'Pack/image10.jpg');
});

test('same basenames remain distinct and collapsing a folder hides its entire subtree', () => {
  const nodes = materialNodes([{ name: 'a/images/logo.svg', id: 'a' }, { name: 'b/images/logo.svg', id: 'b' }]);
  assert.equal(nodes.filter(node => node.name === 'logo.svg').length, 2);
  assert.deepEqual(visibleMaterialNodes(nodes, new Set()).map(node => node.key), ['a', 'b']);
  assert.deepEqual(visibleMaterialNodes(nodes, new Set(['a', 'a/images'])).filter(node => !node.folder).map(node => node.file?.id), ['a']);
});

test('search reveals collapsed matches with their ancestors, supports folder paths and preserves the expansion state', () => {
  const nodes = materialNodes([{ name: 'Pack/images/hero.jpg' }, { name: 'Pack/docs/README.md' }, { name: 'Pack/images/icon.svg' }]);
  const expanded = new Set<string>();
  assert.deepEqual(visibleMaterialNodes(nodes, expanded, ' readME ').map(node => node.key), ['Pack', 'Pack/docs', 'Pack/docs/README.md']);
  assert.equal(visibleMaterialNodes(nodes, expanded, 'images/').filter(node => !node.folder).length, 2);
  assert.deepEqual(visibleMaterialNodes(nodes, expanded, 'missing'), []);
  assert.deepEqual([...expanded], []);
  assert.deepEqual(visibleMaterialNodes(nodes, expanded).map(node => node.key), ['Pack']);
});

test('format detection handles missing MIME, uppercase extensions, SVG and inert text while excluding unknown binaries', () => {
  assert.deepEqual(materialFormat({ name: 'Pack/logo.SVG', type: 'application/octet-stream' }), { kind: 'image', mime: 'image/svg+xml' });
  assert.equal(materialFormat({ name: 'Pack/README' }).kind, 'text');
  assert.equal(materialFormat({ name: 'Pack/page.html', type: 'text/html' }).kind, 'text');
  assert.equal(materialFormat({ name: 'unknown', type: 'text/plain; charset=utf-8' }).kind, 'text');
  assert.equal(materialFormat({ name: 'data.docx', type: 'application/octet-stream' }).kind, 'unsupported');
  assert.equal(materialFormat({ name: 'constructor' }).kind, 'unsupported');
});

test('text preview uses the existing download endpoint without navigating and leaves uploaded markup as plain text', async () => {
  const controller = new AbortController();
  const source = '<script>alert("test")</script><h1>资料</h1>';
  const result = await loadMaterialPreview({ id: 'file-id', name: 'page.html' }, async (url, options) => {
    assert.equal(url, '/api/automation/files/file-id');
    assert.equal(options.signal, controller.signal);
    assert.equal(options.credentials, 'same-origin');
    return new Response(source, { headers: { 'Content-Disposition': 'attachment' } });
  }, controller.signal);
  assert.deepEqual(result, { kind: 'text', text: source, truncated: false });
});

test('large text preview cancels its stream after the limit and does not retain a partial UTF-8 character', async () => {
  let cancelled = false;
  const bytes = new Uint8Array(MATERIAL_TEXT_LIMIT + 5).fill(97);
  bytes[MATERIAL_TEXT_LIMIT - 1] = 0xe4;
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); }, cancel() { cancelled = true; } }));
  const result = await loadMaterialPreview({ id: 'text', name: 'large.md' }, async () => response, new AbortController().signal);
  assert.equal(result.kind, 'text');
  if (result.kind === 'text') { assert.equal(result.text.length, MATERIAL_TEXT_LIMIT - 1); assert.equal(result.truncated, true); assert.ok(!result.text.endsWith('�')); }
  assert.equal(cancelled, true);
});

test('text decoder supports UTF-16 BOMs and rejects binary content masquerading as text', async () => {
  const result = await loadMaterialPreview({ id: 'utf16', name: 'README.txt' }, async () => new Response(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文资料', 'utf16le')])), new AbortController().signal);
  assert.deepEqual(result, { kind: 'text', text: '中文资料', truncated: false });
  await assert.rejects(loadMaterialPreview({ id: 'binary', name: 'binary.txt' }, async () => new Response(new Uint8Array([1, 0, 4])), new AbortController().signal), /不是可预览的文本/);
});

test('image preview restores the image MIME independently of attachment headers', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
  const result = await loadMaterialPreview({ id: 'svg', name: 'badge.svg', type: '' }, async () => new Response(svg, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment' } }), new AbortController().signal);
  assert.equal(result.kind, 'image');
  if (result.kind === 'image') { assert.equal(result.blob.type, 'image/svg+xml'); assert.equal(await result.blob.text(), svg); }
});

test('unsupported files and cancelled selections do not fetch; missing files retain an actionable error', async () => {
  const fetcher = async () => { assert.fail('must not fetch'); return new Response(); };
  await assert.rejects(loadMaterialPreview({ id: 'zip', name: 'archive.zip' }, fetcher, new AbortController().signal), /暂不支持/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadMaterialPreview({ id: 'old', name: 'old.md' }, fetcher, controller.signal), { name: 'AbortError' });
  await assert.rejects(loadMaterialPreview({ id: 'missing', name: 'missing.md' }, async () => new Response('', { status: 404 }), new AbortController().signal), /不存在/);
});
