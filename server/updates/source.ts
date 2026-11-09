import { z } from 'zod';
import { compareVersions, stableVersion, updateProduct, type UpdateManifest, type UpdateRelease, type UpdateSource } from '../../shared/update.js';

export const sourceSchema = z.object({
  repository: z.string().trim().transform(value => value.replace(/^https:\/\/github\.com\//, '').replace(/\.git\/?$/, '').replace(/\/$/, ''))
    .pipe(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/, '请填写 GitHub 仓库地址或 owner/repo')),
  token: z.string().max(500).regex(/^[^\r\n]*$/).default(''), clearToken: z.boolean().default(false),
}).strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const manifestSchema = z.object({
  schemaVersion: z.literal(1), product: z.literal(updateProduct), version: z.string().refine(value => { try { return stableVersion(value) === value; } catch { return false; } }),
  commit: z.string().regex(/^[a-f0-9]{40}$/), publishedAt: z.iso.datetime({ offset: true }),
  minLauncher: z.number().int().min(1).max(100), dataVersion: z.literal(1), nodeMajor: z.number().int().min(24).max(100),
  collectionLockSha256: hash, platforms: z.array(z.enum(['darwin', 'win32', 'linux'])).min(1), architectures: z.array(z.enum(['arm64', 'x64'])).min(1),
  archive: z.object({ name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}\.zip$/), size: z.number().int().positive().max(512 * 1024 * 1024), sha256: hash }).strict(),
}).strict();
export type Fetcher = typeof fetch;

/** Token is only sent to api.github.com, never forwarded to signed asset hosts. */
export async function githubResponse(url: string, source: UpdateSource, signal: AbortSignal, binary = false, fetcher: Fetcher = fetch): Promise<Response> {
  let current = new URL(url);
  for (let hops = 0; hops < 6; hops++) {
    if (current.protocol !== 'https:' || current.username || current.password || current.port || !['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(current.hostname)) throw new Error('发布附件地址不受信任');
    if (current.hostname === 'api.github.com' && !current.pathname.toLowerCase().startsWith(`/repos/${source.repository.toLowerCase()}/`)) throw new Error('附件不属于当前发布仓库');
    const headers: Record<string, string> = { Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json', 'User-Agent': 'Kooboo-AI-Automation-Lab-Updater' };
    if (current.hostname === 'api.github.com') {
      headers['X-GitHub-Api-Version'] = '2022-11-28';
      if (source.token) headers.Authorization = `Bearer ${source.token}`;
    }
    const response = await fetcher(current, { headers, redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('location'); await response.body?.cancel();
      if (!next) throw new Error('发布附件重定向无效'); current = new URL(next, current); continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) throw new Error('尚无可用的正式发行版，或当前账号没有读取权限');
      if ([401, 403].includes(response.status)) throw new Error('GitHub 访问被拒绝，请检查仓库读取权限或 API 限额');
      throw new Error(`GitHub 请求失败（${response.status}）`);
    }
    return response;
  }
  throw new Error('发布附件重定向次数过多');
}
export async function limitedBytes(response: Response, limit: number, signal: AbortSignal, progress?: (bytes: number) => void) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('发布附件超过大小限制'); }
  if (!response.body) throw new Error('发布附件为空');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted(); const next = await reader.read(); if (next.done) break;
      bytes += next.value.length; if (bytes > limit) throw new Error('发布附件超过大小限制');
      chunks.push(next.value); progress?.(bytes);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return Buffer.concat(chunks, bytes);
}
const assetSchema = z.object({ id: z.number().int().positive(), name: z.string(), size: z.number().int().nonnegative() });
export async function checkRelease(source: UpdateSource, currentVersion: string, fetcher: Fetcher = fetch, signal = AbortSignal.timeout(30000)): Promise<UpdateRelease> {
  const response = await githubResponse(`https://api.github.com/repos/${source.repository}/releases/latest`, source, signal, false, fetcher);
  const data = z.object({ id: z.number().int().positive(), tag_name: z.string(), draft: z.boolean(), prerelease: z.boolean(), body: z.string().nullable(), published_at: z.string(), html_url: z.string(), assets: z.array(assetSchema) }).parse(JSON.parse((await limitedBytes(response, 2 * 1024 * 1024, signal)).toString()));
  const version = stableVersion(data.tag_name);
  if (data.draft || data.prerelease) throw new Error('该发行版不是稳定版本');
  const manifestAsset = data.assets.find(asset => asset.name === 'UPDATE_MANIFEST.json');
  if (!manifestAsset) throw new Error('发行版缺少 UPDATE_MANIFEST.json，请使用平台发布工具制作更新包');
  const manifestResponse = await githubResponse(`https://api.github.com/repos/${source.repository}/releases/assets/${manifestAsset.id}`, source, signal, true, fetcher);
  const manifest: UpdateManifest = manifestSchema.parse(JSON.parse((await limitedBytes(manifestResponse, 64 * 1024, signal)).toString()));
  if (manifest.version !== version) throw new Error('发行标签与更新包版本不一致');
  const archive = data.assets.find(asset => asset.name === manifest.archive.name);
  if (!archive || archive.size !== manifest.archive.size) throw new Error('更新包尚未完整发布');
  const page = new URL(data.html_url);
  if (page.origin !== 'https://github.com' || !page.pathname.toLowerCase().startsWith(`/${source.repository.toLowerCase()}/releases/`)) throw new Error('发行版页面地址不合法');
  compareVersions(version, currentVersion);
  return { id: data.id, version, notes: (data.body || '').slice(0, 80000), publishedAt: data.published_at, pageUrl: page.href, manifest, repository: source.repository, assetUrl: `https://api.github.com/repos/${source.repository}/releases/assets/${archive.id}` };
}
