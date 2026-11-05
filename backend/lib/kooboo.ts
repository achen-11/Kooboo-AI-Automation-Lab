import type { Evaluation, RuntimeSettings } from '../shared/types.js';
import { httpJson, URL, randomUUID } from '../runtime.js';
function api(environment: RuntimeSettings['environments'][number], path: string, body?: unknown): any {
 return httpJson(`${environment.apiOrigin}/_api/v2/${path}`, body === undefined ? 'GET' : 'POST', body, environment.token ? {Authorization:`Bearer ${environment.token}`} : {});
}
export function testEnvironment(environment: RuntimeSettings['environments'][number]): number {
  const result = api(environment, 'Site/List');
  if (!Array.isArray(result)) throw new Error('环境未返回有效站点列表，请检查登录凭据');
  return result.length;
}
export function resolveTarget(evaluation: Evaluation, settings: RuntimeSettings): { targetUrl: string; readme: string | null; warnings: string[] } {
  if (evaluation.targetUrl) return { targetUrl: evaluation.targetUrl, readme: null, warnings: [] };
  const environment = settings.environments.find((env) => env.origin === evaluation.submission.target.koobooOrigin);
  if (!environment) throw new Error('尚未配置此 Kooboo 环境，请在环境连接中添加后重新评测');
  const siteId = encodeURIComponent(evaluation.submission.target.siteId);
  const info = api(environment, `Site/Get?SiteId=${siteId}`) as Record<string, unknown>;
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
      const response = api(environment, `AI/CallFunction?SiteId=${siteId}`, {
        name: 'run_kscript', callId: randomUUID(),
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
