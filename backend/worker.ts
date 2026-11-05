import { Store, LostLease } from './lib/store.js';
import { Vault } from './lib/vault.js';
import { listRules } from './lib/rules.js';
import { initializeArtifacts } from './lib/artifacts.js';
import { collectEvidence, collectorVersion } from './lib/collector.js';
import { scoreEvidence } from './lib/scorer.js';
import { resolveTarget } from './lib/kooboo.js';
import { siteDomainFromUrl } from './lib/site-domain.js';
import { randomUUID } from './runtime.js';

export function initialize() {
  const store = new Store('site-sqlite');
  for (const item of listRules()) store.registerRule(item.rule.version, item.hash, item.rule);
  initializeArtifacts();
  return { store, vault: new Vault() };
}
export function tick() {
  const { store, vault } = initialize();
  k.DB.sqlite.execute('CREATE TABLE IF NOT EXISTS evaluator_runtime (id INTEGER PRIMARY KEY, last_tick INTEGER NOT NULL)');
  k.DB.sqlite.execute('INSERT OR REPLACE INTO evaluator_runtime VALUES (1,@now)', { now: Date.now() });
  const settings = vault.get();
  if (settings.paused || !settings.model.endpoint || !settings.model.name) return;
  const owner = randomUUID(), job = store.claim(owner);
  if (!job) return;
  const { evaluation, run } = job, deadline = Date.now() + 240000;
  try {
    const found = store.getRule(evaluation.submission.ruleSetVersion || 'visual-v1');
    if (!found) throw new Error('任务规则版本未发布');
    const snapshot = { rule: found.rule, ruleHash: found.hash, model: { endpoint: settings.model.endpoint, name: settings.model.name }, collector: collectorVersion };
    store.update(run.id, owner, { snapshot });
    const target = resolveTarget(evaluation, settings);
    store.bindSite(evaluation.id, siteDomainFromUrl(target.targetUrl), run.id, owner);
    store.event(run.id, '已解析生成站域名，开始 Kooboo 原生截图');
    const evidence = collectEvidence({ ...target, referenceUrl: evaluation.submission.inputs.referenceUrl, scope: evaluation.submission.scope, rule: found.rule, evaluationId: evaluation.id, runId: run.id, deadline });
    store.update(run.id, owner, { evidence, status: 'scoring' });
    store.event(run.id, '证据已保存，开始评分');
    const remaining = Math.min(90, Math.floor((deadline - Date.now()) / 1000));
    if (remaining < 1) throw new Error('评测超过 4 分钟时限');
    const report = scoreEvidence(evidence, found.rule, settings.model, evaluation.id, run.id, remaining);
    if (Date.now() > deadline) throw new Error('评测超过 4 分钟时限，本轮不保存分数');
    store.update(run.id, owner, { report, status: 'completed' });
    store.event(run.id, report.fidelityScore === null ? '执行完成，还原度不可评估' : `评分完成，还原度 ${report.fidelityScore} 分`);
  } catch (error) {
    if (error instanceof LostLease) return;
    const message = error instanceof Error ? error.message.slice(0,800) : '评测执行失败';
    try { store.update(run.id, owner, { status: 'failed', error: message }); store.event(run.id, message); } catch { /* A stale owner must not write. */ }
  }
}
