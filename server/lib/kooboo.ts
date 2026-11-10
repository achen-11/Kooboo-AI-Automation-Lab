import type { Evaluation, RuntimeSettings } from '../../shared/types.js';
import { parseRootDomains } from '../../shared/kooboo-domains.js';

async function api(environment: RuntimeSettings['environments'][number], path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
  const response = await fetch(`${environment.apiOrigin}/_api/v2/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(environment.token ? { Authorization: `Bearer ${environment.token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
  });
  if (response.status === 401 || response.status === 403) throw new Error('Kooboo 登录已失效或没有访问权限，请在连接设置中重新登录');
  if (!response.ok) throw new Error(`Kooboo 读取失败（HTTP ${response.status}），请检查平台独立配置的环境凭据`);
  return response.json();
}
export async function testEnvironment(environment: RuntimeSettings['environments'][number], signal = AbortSignal.timeout(20000)): Promise<number> {
  const result = await api(environment, 'Site/List', signal);
  if (!Array.isArray(result)) throw new Error('环境未返回有效站点列表，请检查登录凭据');
  return result.length;
}
export async function availableRootDomains(environment: RuntimeSettings['environments'][number]) {
  if (!environment.token) throw new Error('请先登录连接 Kooboo 环境');
  try { return parseRootDomains(await api(environment, 'Domain/Available', AbortSignal.timeout(20000))); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('根域名响应不是有效 JSON，请检查环境连接');
    throw error;
  }
}
export async function resolveTarget(evaluation: Evaluation, settings: RuntimeSettings, signal: AbortSignal): Promise<{ targetUrl: string; readme: string | null; warnings: string[] }> {
  if (evaluation.targetUrl && !evaluation.submission.inputs.materialsPath) return { targetUrl: evaluation.targetUrl, readme: null, warnings: [] };
  const environment = settings.environments.find((env) => env.origin === evaluation.submission.target.koobooOrigin);
  if (!environment) throw new Error('尚未配置此 Kooboo 环境，请在环境连接中添加后重新评测');
  const siteId = encodeURIComponent(evaluation.submission.target.siteId);
  const info = evaluation.targetUrl ? { prUrl: evaluation.targetUrl } : await api(environment, `Site/Get?SiteId=${siteId}`, signal) as Record<string, unknown>;
  const targetUrl = info.prUrl ?? info.PrUrl ?? info.baseUrl ?? info.BaseUrl;
  if (typeof targetUrl !== 'string' || !/^https?:\/\//i.test(targetUrl)) throw new Error('Kooboo 未返回有效的站点访问地址，不能推测子域名');
  const parsedTarget = new URL(targetUrl);
  if (parsedTarget.username || parsedTarget.password) throw new Error('站点访问地址不能包含账号或密码');
  const warnings: string[] = [];
  let readme: string | null = null;
  const materialsPath = evaluation.submission.inputs.materialsPath;
  if (materialsPath) {
    try {
      // 代码固定为只读；不执行网页或模型生成的脚本。
      const response = await api(environment, `AI/CallFunction?SiteId=${siteId}`, signal, {
        name: 'run_kscript', callId: crypto.randomUUID(),
        arguments: { code: `var text = k.file.read(${JSON.stringify(materialsPath)}); return text;` },
      }) as { contents?: { result?: unknown }[] };
      let result = response.contents?.[0]?.result;
      if (typeof result === 'string') {
        try { const decoded = JSON.parse(result); if (typeof decoded === 'string') result = decoded; } catch { /* 原文是普通 Markdown */ }
      }
      if (typeof result === 'string' && result.trim() && !/^(error|exception):/i.test(result.trim())) readme = result.slice(0, 40000);
      else warnings.push('指定 README 未读到有效文本，任务完成度不可评估');
    } catch {
      warnings.push('指定 README 读取失败，任务完成度不可评估');
    }
  }
  return { targetUrl, readme, warnings };
}
