import MarkdownIt from 'markdown-it';
import type { MaterialTreeFile } from './material-browser';
import { materialFormat } from './material-browser';

export function isMaterialMarkdown(file: Pick<MaterialTreeFile, 'name' | 'type'>): boolean {
  return /\.(md|markdown)$/i.test(file.name) || /^text\/(?:x-)?markdown(?:;|$)/i.test(file.type || '');
}

export function linkedMaterial(href: string, path: string, files: readonly MaterialTreeFile[]): MaterialTreeFile | undefined {
  if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href.trim())) return;
  let relative: string;
  try { relative = decodeURIComponent(href.split(/[?#]/)[0]).normalize('NFC'); } catch { return; }
  if (!relative || /[\\\u0000-\u001f]/.test(relative)) return;
  const parts = path.split('/').slice(0, -1);
  for (const part of relative.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return; parts.pop(); } else parts.push(part);
  }
  const name = parts.join('/');
  return files.find(file => file.name === name) || files.find(file => file.name.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'));
}

export function renderMaterialMarkdown(source: string, path: string, files: readonly MaterialTreeFile[]): string {
  const md = new MarkdownIt({ html: false, linkify: false });
  const escape = md.utils.escapeHtml, linkTags: string[] = [], headings = new Set<string>();
  md.renderer.rules.heading_open = (tokens, index, options, _env, renderer) => {
    const inline = tokens[index + 1];
    const title = inline.children?.filter(token => ['text', 'code_inline'].includes(token.type)).map(token => token.content).join('') || inline.content;
    const base = title.trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'section';
    let id = base, count = 0;
    while (headings.has(id)) id = `${base}-${++count}`;
    headings.add(id); tokens[index].attrSet('id', id);
    return renderer.renderToken(tokens, index, options);
  };
  md.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
    const token = tokens[index], href = String(token.attrGet('href') ?? ''), file = linkedMaterial(href, path, files);
    if (file?.id) { token.attrSet('href', '#'); token.attrSet('data-material-file', file.id); }
    else if (href.startsWith('#')) token.attrSet('data-markdown-anchor', href.slice(1));
    else if (/^(https?:\/\/|mailto:|tel:)/i.test(href)) { token.attrSet('target', '_blank'); token.attrSet('rel', 'noopener noreferrer'); }
    else { linkTags.push('span'); return '<span class="markdown-missing-link" title="资料中未找到此文件">'; }
    linkTags.push('a');
    return renderer.renderToken(tokens, index, options);
  };
  md.renderer.rules.link_close = () => `</${linkTags.pop() || 'a'}>`;
  md.renderer.rules.image = (tokens, index) => {
    const token = tokens[index], src = String(token.attrGet('src') ?? ''), alt = token.content || '图片';
    const file = linkedMaterial(src, path, files);
    if (file?.id && materialFormat(file).kind === 'image') {
      const image = `<img data-material-image="${escape(file.id)}" alt="${escape(alt)}" loading="lazy" />`;
      return linkTags.at(-1) === 'a' ? image : `<a href="#" data-material-file="${escape(file.id)}" class="markdown-image-link" title="点击查看原图">${image}</a>`;
    }
    if (/^https?:\/\//i.test(src)) return linkTags.at(-1) === 'a' ? escape(alt) : `<a href="${escape(src)}" target="_blank" rel="noopener noreferrer">${escape(alt)}（打开图片）</a>`;
    return `<span class="markdown-missing-link">${escape(alt)}（图片未在资料中找到）</span>`;
  };
  return md.render(source);
}
