export interface MaterialTreeFile { name: string; id?: string; size?: number; type?: string }
export interface MaterialNode { key: string; name: string; depth: number; folder: boolean; count: number; file?: MaterialTreeFile }

export function materialNodes(files: readonly MaterialTreeFile[]): MaterialNode[] {
  const children = new Map<string, MaterialNode[]>(), nodes = new Map<string, MaterialNode>();
  for (const file of files) {
    const parts = file.name.split('/');
    parts.forEach((name, depth) => {
      const key = parts.slice(0, depth + 1).join('/'), parent = parts.slice(0, depth).join('/');
      let node = nodes.get(key);
      if (!node) {
        node = { key, name, depth, folder: depth < parts.length - 1, count: 0 };
        nodes.set(key, node);
        const siblings = children.get(parent) || [];
        siblings.push(node); children.set(parent, siblings);
      }
      node.count++;
      if (!node.folder) node.file = file;
    });
  }
  const rows: MaterialNode[] = [];
  function visit(parent: string) {
    const siblings = children.get(parent) || [];
    siblings.sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
    for (const node of siblings) { rows.push(node); if (node.folder) visit(node.key); }
  }
  visit('');
  return rows;
}

export function visibleMaterialNodes(nodes: readonly MaterialNode[], expanded: ReadonlySet<string>, query = ''): MaterialNode[] {
  const search = query.trim().toLocaleLowerCase();
  if (search) {
    const matching = new Set<string>();
    for (const node of nodes) if (!node.folder && node.key.toLocaleLowerCase().includes(search)) {
      const parts = node.key.split('/');
      for (let i = 1; i <= parts.length; i++) matching.add(parts.slice(0, i).join('/'));
    }
    return nodes.filter(node => matching.has(node.key));
  }
  return nodes.filter(node => {
    const parts = node.key.split('/');
    return parts.slice(0, -1).every((_, index) => expanded.has(parts.slice(0, index + 1).join('/')));
  });
}

const imageTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon' };
const textExtensions = new Set(['txt', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'xml', 'html', 'htm', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'yaml', 'yml', 'toml', 'ini', 'conf', 'config', 'log', 'sql', 'sh', 'py']);
export function materialFormat(file: Pick<MaterialTreeFile, 'name' | 'type'>): { kind: 'image' | 'text' | 'unsupported'; mime: string } {
  const basename = file.name.split('/').at(-1)!.toLowerCase(), extension = basename.split('.').at(-1)!;
  if (Object.hasOwn(imageTypes, extension)) return { kind: 'image', mime: imageTypes[extension] };
  if (textExtensions.has(extension) || /^(readme|license|licence|changelog|dockerfile|makefile)$/.test(basename)) return { kind: 'text', mime: 'text/plain' };
  const mime = (file.type || '').split(';')[0].trim().toLowerCase();
  if (Object.values(imageTypes).includes(mime)) return { kind: 'image', mime };
  if (mime.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript', 'application/yaml'].includes(mime)) return { kind: 'text', mime: 'text/plain' };
  return { kind: 'unsupported', mime: 'application/octet-stream' };
}

export const MATERIAL_TEXT_LIMIT = 256 * 1024;
const IMAGE_LIMIT = 16 * 1024 * 1024;
export type MaterialPreview = { kind: 'text'; text: string; truncated: boolean } | { kind: 'image'; blob: Blob };
type MaterialFetcher = (url: string, options: RequestInit) => Promise<Response>;

/** Read only a bounded preview; never render uploaded HTML or SVG as page markup. */
export async function loadMaterialPreview(file: MaterialTreeFile & { id: string }, fetcher: MaterialFetcher, signal: AbortSignal): Promise<MaterialPreview> {
  signal.throwIfAborted();
  const format = materialFormat(file);
  if (format.kind === 'unsupported') throw new Error('暂不支持此格式预览');
  const response = await fetcher(`/api/automation/files/${encodeURIComponent(file.id)}`, { credentials: 'same-origin', signal });
  if (!response.ok) throw new Error(response.status === 404 ? '资料文件不存在，请刷新后重试' : `文件加载失败（${response.status}）`);
  const reader = response.body?.getReader(), limit = format.kind === 'text' ? MATERIAL_TEXT_LIMIT : IMAGE_LIMIT;
  const chunks: Uint8Array[] = [];
  let length = 0, truncated = false;
  try {
    while (reader) {
      signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      const available = limit - length;
      chunks.push(result.value.slice(0, available));
      length += Math.min(available, result.value.byteLength);
      if (result.value.byteLength > available) { truncated = true; await reader.cancel(); break; }
    }
  } finally { reader?.releaseLock(); }
  signal.throwIfAborted();
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  if (format.kind === 'image') {
    if (truncated) throw new Error('图片过大，请下载查看');
    return { kind: 'image', blob: new Blob([bytes], { type: format.mime }) };
  }
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : undefined;
  if (!utf16 && bytes.subarray(0, 8192).includes(0)) throw new Error('此文件不是可预览的文本，请下载查看');
  return { kind: 'text', text: new TextDecoder(utf16 || 'utf-8').decode(bytes, { stream: truncated }), truncated };
}
