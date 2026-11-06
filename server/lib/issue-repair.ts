import type { Artifacts } from './artifacts.js';
import { Conflict, type Store } from './store.js';
import type { RepairPayload, RepairTarget } from '../../shared/issue-actions.js';
import { issuePrompt } from '../../shared/issue-actions.js';
import type { Evaluation, RuntimeSettings } from '../../shared/types.js';
import { scopedShots } from '../../shared/comparison.js';
import { createHash } from 'node:crypto';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function repairTargets(evaluation: Evaluation, settings: RuntimeSettings): Promise<{ items: RepairTarget[]; warnings: string[] }> {
  const url = evaluation.run.evidence?.targetUrl || evaluation.targetUrl;
  if (!url) throw new Conflict('尚无已确认的生成站地址');
  const host = new URL(url).hostname.toLowerCase();
  const items: RepairTarget[] = [], warnings: string[] = [];
  for (const environment of settings.environments) {
    try {
      const response = await fetch(`${environment.apiOrigin}/_api/v2/Site/List`, { headers: environment.token ? { Authorization: `Bearer ${environment.token}` } : {}, redirect: 'manual', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw Error();
      const sites = await response.json();
      if (!Array.isArray(sites)) throw Error();
      for (const site of sites) {
        const siteId = site.siteId ?? site.SiteId, address = site.homePageLink ?? site.HomePageLink;
        if (typeof siteId !== 'string' || !uuid.test(siteId) || typeof address !== 'string') continue;
        let siteUrl: URL; try { siteUrl = new URL(address); } catch { continue; }
        if (!['http:', 'https:'].includes(siteUrl.protocol) || siteUrl.hostname.toLowerCase() !== host) continue;
        if (items.some(item => item.environmentId === environment.id && item.siteId === siteId)) continue;
        items.push({ environmentId: environment.id, environmentName: environment.name, origin: new URL(environment.origin).origin, siteId, siteName: String(site.siteDisplayName || site.SiteDisplayName || site.siteName || site.SiteName || host) });
      }
    } catch { warnings.push(`${environment.name || 'Kooboo 环境'}：读取站点失败，请检查环境连接`); }
  }
  return { items, warnings };
}

export function repairPayload(store: Store, artifacts: Artifacts, evaluationId: string, runId: string, indices: number[], target: RepairTarget, id: string): RepairPayload {
  const evaluation = store.get(evaluationId);
  if (!evaluation || evaluation.run.id !== runId || !['completed', 'failed'].includes(evaluation.run.status)) throw new Conflict('评测已更新或尚未结束，请刷新后再发送');
  const report = evaluation.run.report;
  if (!report) throw new Conflict('本轮尚无问题报告');
  const ignored = new Set(store.issueActions(runId).ignored);
  if (!indices.length || new Set(indices).size !== indices.length || indices.some(i => !Number.isInteger(i) || !report.issues[i] || ignored.has(i))) throw new Conflict('选中问题不存在或已忽略，请刷新后重选');
  const evidenceIds = indices.flatMap(i => report.issues[i].evidence);
  const images = scopedShots(evaluation.run.evidence?.screenshots || [], evidenceIds, report.pairings || []).map(shot => {
    const content = artifacts.get(evaluationId, shot.sourceRunId || runId, shot.file);
    if (!content) throw new Conflict('关联截图已丢失，不能发送不完整证据');
    const bytes = Buffer.from(content, 'base64');
    if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || (shot.sha256 && createHash('sha256').update(bytes).digest('hex') !== shot.sha256)) throw new Conflict('关联截图校验失败');
    return { id: shot.id, role: shot.role, viewport: shot.viewport, uri: `data:image/png;base64,${content}`, mediaType: 'image/png' as const };
  });
  if (images.length > 100) throw new Conflict('本批截图过多，请减少选中问题后分批发送');
  if (images.reduce((sum, image) => sum + image.uri.length, 0) > 32 * 1024 * 1024) throw new Conflict('本批截图过大，请减少选中问题后分批发送');
  const text = issuePrompt({ targetUrl: evaluation.run.evidence?.targetUrl || evaluation.targetUrl!, referenceUrl: evaluation.submission.inputs.referenceUrl, runId, issues: indices.map(index => ({ index, issue: report.issues[index] })), images });
  if (text.length > 250000) throw new Conflict('本批问题描述过长，请减少选中问题后分批发送');
  store.prepareIssueHandoff(evaluationId, runId, indices, target, id);
  return { type: 'site-evaluator:repair', version: 1, id, siteId: target.siteId, text, images };
}
