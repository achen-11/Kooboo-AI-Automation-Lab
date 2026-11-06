import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Evidence, Report, RuleSet } from '../shared/types.js';
import builtin from '../server/lib/builtin-rule.js';
import { inspectCapture, scoreEvidence, scoringReadiness, weightedScore } from '../server/lib/scorer.js';
import type { Completion, CompletionRequest } from '../server/lib/model.js';

const rule = builtin as RuleSet;
const model = { endpoint: 'https://model.example/chat/completions', name: 'custom-scoring-model', apiKey: 'key' };
const image = 'iVBORw0KGgoAAAANSUhEUgAAAFAAAAAoCAIAAADmAupWAAAARUlEQVR4nO3PsQ0AAAzCMP5/mp7BUEvZI6fJpNG2qy0wMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw8FvwAYjsdDWqHWo9AAAAAElFTkSuQmCC';
function fixture(): Evidence {
  return { targetUrl: 'https://target.example/', targetTitle: 'Title', text: 'Visible site text', readme: null,
    screenshots: (['target', 'reference'] as const).flatMap(role => rule.viewports.map(viewport => ({
      id: `${role}-${viewport.id}-top`, role, viewport: viewport.id, region: 'top', file: `${role}-${viewport.id}.png`, url: `https://${role}.example/`, capturedAt: 1, width: viewport.width, height: viewport.height,
    }))), health: 'ok', issues: [], fingerprint: 'a', stable: true,
    coverage: { requested: 'homepage', actual: 'homepage', complete: true, note: 'test' } };
}
function result(): Pick<Report, 'summary' | 'confidence' | 'dimensions' | 'completionScore' | 'issues'> {
  return { summary: '图像对比结果', confidence: 'high', dimensions: rule.dimensions.map(d => ({ id: d.id, score: 80, reason: '布局相似，但区块高度有差异', evidence: ['target-desktop-top', 'reference-desktop-top'] })), completionScore: null, issues: [] };
}
function completion(value: unknown): Completion {
  return { choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: JSON.stringify(value), refusal: null } }] };
}
function artifacts() {
  const saved = new Map<string, string>();
  const reads: string[] = [];
  return { saved, reads,
    get: (_evaluation: string, run: string, file: string) => { reads.push(`${run}/${file}`); return image; },
    save: (_evaluation: string, _run: string, file: string, value: string) => { saved.set(file, value); },
  };
}
async function score(evidence: Evidence, value: unknown = result(), store = artifacts()) {
  return scoreEvidence(evidence, rule, model, 'evaluation', 'new-run', 90, store, undefined, undefined, async () => completion(value));
}

test('missing evidence skips model and returns diagnostic rather than fake zero score', async () => {
  const evidence = fixture();
  evidence.screenshots = evidence.screenshots.filter(shot => shot.role === 'reference');
  let called = false;
  const report = await scoreEvidence(evidence, rule, model, 'e', 'r', 90, artifacts(), undefined, undefined, async () => { called = true; return completion(result()); });
  assert.equal(called, false);
  assert.equal(report.fidelityScore, null);
  assert.equal(report.model.name, '未调用');
  assert.match(report.summary, /采集诊断/);
});

test('scoring sends real artifact pixels and reuses source run images', async () => {
  const evidence = fixture(), store = artifacts();
  evidence.screenshots[0].sourceRunId = 'old-run';
  const complete: CompletionRequest = async (config, messages) => {
    assert.equal(config.name, 'custom-scoring-model');
    assert.ok(Array.isArray(messages[1].content));
    assert.equal(messages[1].content.filter(part => part.type === 'image_url').length, 4);
    return completion(result());
  };
  const report = await scoreEvidence(evidence, rule, model, 'e', 'new-run', 90, store, undefined, undefined, complete);
  assert.equal(report.fidelityScore, 80);
  assert.equal(report.completionScore, null);
  assert.ok(store.reads.includes('old-run/target-desktop.png'));
  assert.ok(store.saved.has('model-response.json'));
});

test('evidence IDs must exist and visual dimensions require both screenshot roles', async () => {
  const unknown = result(); unknown.dimensions[0].evidence = ['invented'];
  await assert.rejects(score(fixture(), unknown), /不存在的证据/);
  const single = result(); single.dimensions[0].evidence = ['target-desktop-top'];
  await assert.rejects(score(fixture(), single), /同时引用/);
});

test('all visual dimensions must be unique and code computes weighted score', () => {
  const dimensions = result().dimensions;
  assert.equal(weightedScore(dimensions, rule), 80);
  dimensions[0].score = 100;
  assert.equal(weightedScore(dimensions, rule), 87);
  assert.throws(() => weightedScore([...dimensions.slice(1), dimensions[1]], rule), /完整且唯一/);
});

test('legacy scoring uses the current rule configuration even when its prompt contains old dimension examples', async () => {
  const customRule: RuleSet = { ...rule, version: 'visual-custom', dimensions: [
    { id: 'custom-content', label: '内容完整性', weight: 70, instruction: '逐模块对照可见内容' },
    { id: 'layout', label: '布局', weight: 30, instruction: '检查模块顺序' },
  ] };
  const value = { ...result(), dimensions: customRule.dimensions.map((d, index) => ({ id: d.id, score: index ? 100 : 60, reason: '按当前标准对照截图', evidence: ['target-desktop-top', 'reference-desktop-top'] })) };
  const complete: CompletionRequest = async (_model, messages) => {
    const system = messages[0].content as string;
    assert.ok(system.endsWith('证据引用、实际看图及输出结构约定继续适用。'));
    assert.ok(system.includes(JSON.stringify({ version: customRule.version, dimensions: customRule.dimensions })));
    return completion(value);
  };
  const report = await scoreEvidence(fixture(), customRule, model, 'e', 'r', 90, artifacts(), undefined, undefined, complete);
  assert.equal(report.fidelityScore, 72);
  assert.throws(() => weightedScore([{ ...value.dimensions[0], id: 'not-in-rule' }, value.dimensions[1]], customRule), /不合法/);
});

test('materials-only evaluation has completion score and forbids invented fidelity', async () => {
  const evidence = fixture(); evidence.readme = '首页必须含有公司名称';
  evidence.screenshots = evidence.screenshots.filter(shot => shot.role === 'target');
  const value = result(); value.dimensions = []; value.completionScore = 75;
  const report = await score(evidence, value);
  assert.equal(report.fidelityScore, null);
  assert.equal(report.completionScore, 75);
  assert.equal(report.referenceStatus, 'not_provided');
  const invalid = result();
  invalid.dimensions.forEach(dimension => { dimension.evidence = ['target-desktop-top']; });
  await assert.rejects(score(evidence, invalid), /缺少参考/);
});

test('role errors block readiness and lost/corrupt screenshots never get a score', async () => {
  const evidence = fixture();
  evidence.issues.push({ severity: 'major', dimension: 'reference', title: '不可用', detail: '空白截图', evidence: [] });
  assert.equal(scoringReadiness(evidence, rule).willCallModel, false);
  const store = artifacts(); store.get = () => '';
  await assert.rejects(score(fixture(), result(), store), /已丢失/);
  store.get = () => Buffer.from('not a PNG').toString('base64');
  await assert.rejects(score(fixture(), result(), store), /有效 PNG/);
});

test('capture review keeps diagnostics and validates bounded recovery advice', async () => {
  const store = artifacts();
  const review = await inspectCapture(fixture(), rule, model, store, 'e', 'r', undefined, async () => completion({ usable: false, reason: '懒加载仍显示骨架', retry: { waitMs: 4000, scrollWaitMs: 600 } }));
  assert.equal(review.usable, false);
  assert.equal(review.retry?.waitMs, 4000);
  assert.ok([...store.saved.keys()].some(key => key.startsWith('capture-review-')));
  await assert.rejects(inspectCapture(fixture(), rule, model, store, 'e', 'r', undefined, async () => completion({ usable: false, reason: 'x', retry: { waitMs: 999999, scrollWaitMs: 600 } })), /格式不合法/);
});
