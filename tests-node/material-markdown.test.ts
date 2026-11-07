import test from 'node:test';
import assert from 'node:assert/strict';
import { isMaterialMarkdown, linkedMaterial, renderMaterialMarkdown } from '../frontend/src/lib/material-markdown.js';

const files = [
  { id: 'readme', name: 'Pack/docs/README.md', type: 'text/markdown' },
  { id: 'image', name: 'Pack/images/logo blue.svg', type: 'image/svg+xml' },
  { id: 'note', name: 'Pack/docs/details.md', type: 'text/markdown' },
];
const render = (source: string) => renderMaterialMarkdown(source, files[0].name, files);

test('Markdown preview renders headings, emphasis, nested lists, quotes, tables and fenced code', () => {
  const html = render('# 商家资料\n\n**名称** 和 `代号`\n\n- 图片\n  - 标识\n\n> 引用说明\n\n| 列 | 值 |\n| --- | --- |\n| A | B |\n\n```js\nconst value = "<tag>";\n```');
  for (const pattern of [/<h1 id="商家资料">/, /<strong>名称<\/strong>/, /<code>代号<\/code>/, /<ul>/, /<blockquote>/, /<table>/, /<th>列<\/th>/, /class="language-js"/, /&lt;tag&gt;/]) assert.match(html, pattern);
  assert.equal((html.match(/<ul>/g) || []).length, 2);
});

test('raw HTML stays inert and dangerous links cannot become executable markup', () => {
  const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n\n[x](data:text/html,hello)\n\n[x](file:///etc/passwd)');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /href="(?:javascript|data|file):/i);
});

test('relative file references resolve within uploaded materials, with parent paths, spaces and same-folder links', () => {
  assert.equal(linkedMaterial('../images/logo%20blue.svg', files[0].name, files)?.id, 'image');
  assert.equal(linkedMaterial('./details.md#说明', files[0].name, files)?.id, 'note');
  assert.equal(linkedMaterial('DETAILS.MD', files[0].name, files)?.id, 'note');
  for (const href of ['../../../etc/passwd', 'missing.md', '//other.test/image.svg', 'https://other.test/image.svg', '../images/%ZZ', '../images/logo%5Cblue.svg']) assert.equal(linkedMaterial(href, files[0].name, files), undefined);
});

test('local file links select previews; unresolved paths never navigate out of the SPA', () => {
  const html = render('[详情](details.md) 和 [缺失](missing.md)');
  assert.match(html, /<a href="#" data-material-file="note">详情<\/a>/);
  assert.match(html, /<span class="markdown-missing-link"[^>]*>缺失<\/span>/);
  assert.ok(!html.includes('href="missing.md"'));
});

test('external links open explicitly while remote images do not cause background requests', () => {
  const html = render('[文档](https://example.test/doc)\n\n![外部图片](https://example.test/a.png)');
  assert.match(html, /href="https:\/\/example.test\/doc" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /href="https:\/\/example.test\/a.png"/);
  assert.doesNotMatch(html, /<img[^>]+src="https:/);
});

test('local Markdown images preserve their material identity without embedding uploaded markup', () => {
  const html = render('![品牌标识](../images/logo%20blue.svg)');
  assert.match(html, /data-material-file="image"/);
  assert.match(html, /<img data-material-image="image" alt="品牌标识" loading="lazy"/);
  assert.doesNotMatch(html, /<svg|onerror|src="/);
  const linkedImage = render('[![品牌标识](../images/logo%20blue.svg)](https://example.test)');
  assert.equal((linkedImage.match(/<a /g) || []).length, 1);
  assert.match(linkedImage, /data-material-image="image"/);
});

test('document anchors get unique heading IDs and remain inside the document preview', () => {
  const html = render('# Hello\n\n# Hello\n\n# Hello-1\n\n[返回](#hello)');
  const ids = Array.from(html.matchAll(/<h1 id="([^"]+)"/g), match => match[1]);
  assert.equal(new Set(ids).size, 3);
  assert.match(html, /data-markdown-anchor="hello"/);
});

test('Markdown detection distinguishes prose documents from ordinary text and code', () => {
  assert.equal(isMaterialMarkdown({ name: 'README.MD' }), true);
  assert.equal(isMaterialMarkdown({ name: 'notes.markdown' }), true);
  assert.equal(isMaterialMarkdown({ name: 'unknown', type: 'text/markdown; charset=utf-8' }), true);
  assert.equal(isMaterialMarkdown({ name: 'data.json', type: 'application/json' }), false);
  assert.equal(isMaterialMarkdown({ name: 'notes.txt', type: 'text/plain' }), false);
});
