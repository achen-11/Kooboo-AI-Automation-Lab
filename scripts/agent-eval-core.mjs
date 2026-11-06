import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export const VERSION = 'agent-site-ui-v1';
export const DIMENSIONS = [
  { id: 'layout', name: '页面结构与布局', weight: 30 },
  { id: 'spacing', name: '尺寸与间距', weight: 20 },
  { id: 'typography', name: '字体与文字层级', weight: 15 },
  { id: 'decoration', name: '颜色与装饰', weight: 10 },
  { id: 'imagery', name: '图片与图形', weight: 15 },
  { id: 'mobile', name: '移动端布局', weight: 10 },
];
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const configHash = config => sha256(JSON.stringify({ version: VERSION, config }));
export function positions(height, viewportHeight, maxHeight = 30000) {
  const bottom = Math.max(0, Math.min(height, maxHeight) - viewportHeight);
  const output = [];
  for (let y = 0; y < bottom; y += Math.max(1, Math.floor(viewportHeight * .9))) output.push(y);
  if (output.at(-1) !== bottom) output.push(bottom);
  return output;
}
export function validateConfig(config) {
  for (const role of ['target', 'reference']) {
    const url = new URL(config[role]);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw Error(`${role}: use a public HTTP(S) URL without credentials, query or fragment`);
  }
  if (!Array.isArray(config.viewports) || !config.viewports.length) throw Error('Viewports required');
  const ids = new Set();
  for (const v of config.viewports) {
    if (!/^[a-z][a-z0-9-]*$/.test(v.id) || ids.has(v.id)) throw Error('Viewport IDs must be unique and safe');
    ids.add(v.id);
    if (![v.width, v.height].every(n => Number.isInteger(n) && n >= 320 && n <= 3840)) throw Error('Viewport outside bounds');
  }
  if (config.maxHeight !== undefined && (!Number.isInteger(config.maxHeight) || config.maxHeight < 900 || config.maxHeight > 40000)) throw Error('maxHeight outside bounds');
  return config;
}
export async function verifyArtifacts(manifest, directory) {
  const base = await realpath(directory);
  const results = [];
  const ids = new Set();
  for (const capture of Object.values(manifest.captures)) {
    for (const a of capture.artifacts || []) {
      if (ids.has(a.id)) throw Error(`Duplicate artifact: ${a.id}`);
      ids.add(a.id);
      const path = await realpath(resolve(base, a.file));
      if (!path.startsWith(base + sep)) throw Error(`Artifact outside run: ${a.id}`);
      const bytes = await readFile(path);
      if (sha256(bytes) !== a.sha256) throw Error(`Artifact changed: ${a.id}`);
      if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw Error(`Invalid PNG: ${a.id}`);
      if (bytes.readUInt32BE(16) !== a.width || bytes.readUInt32BE(20) !== a.height) throw Error(`PNG dimensions differ: ${a.id}`);
      results.push(a.id);
    }
  }
  return results;
}
export function validateAssessment(assessment, manifest) {
  if (manifest.configHash !== configHash(manifest.config)) throw Error('Manifest config changed');
  const captures = Object.values(manifest.captures);
  const expectedKeys = ['target', 'reference'].flatMap(role => manifest.config.viewports.map(v => `${role}-${v.id}`));
  for (const key of expectedKeys) {
    if (manifest.captures[key]?.status !== 'captured') throw Error(`Capture missing: ${key}`);
  }
  const shots = new Map(captures.flatMap(c => (c.artifacts || []).map(a => [a.id, { ...a, role: c.role, viewport: c.viewport.id }])));
  if (!Array.isArray(assessment.captureReviews)) throw Error('Agent capture reviews required');
  const reviews = new Map();
  for (const review of assessment.captureReviews) {
    if (reviews.has(review.captureId)) throw Error('Duplicate capture review');
    reviews.set(review.captureId, review);
  }
  for (const key of expectedKeys) {
    const review = reviews.get(key), capture = manifest.captures[key];
    if (!review || review.usable !== true || !review.reason?.trim()) throw Error(`Usable visual review required: ${key}`);
    if (!Array.isArray(review.evidence) || !review.evidence.length || review.evidence.some(id => !capture.artifacts.some(a => a.id === id))) throw Error(`Invalid review evidence: ${key}`);
    if (capture.coverage?.complete !== true) throw Error(`Incomplete capture: ${key}; full-scope score prohibited`);
  }
  if (!Array.isArray(assessment.dimensions) || assessment.dimensions.length !== DIMENSIONS.length) throw Error('Exactly six dimensions required');
  const seen = new Set();
  const dimensions = assessment.dimensions.map(d => {
    const definition = DIMENSIONS.find(v => v.id === d.id);
    if (!definition || seen.has(d.id)) throw Error(`Unknown or duplicate dimension: ${d.id}`);
    seen.add(d.id);
    if (!Number.isFinite(d.score) || d.score < 0 || d.score > 100) throw Error(`Invalid score: ${d.id}`);
    if (!d.reason?.trim()) throw Error(`Reason required: ${d.id}`);
    validateEvidence(d.evidence, shots, d.id);
    if (d.id === 'mobile' && !['target', 'reference'].every(role => d.evidence.some(id => shots.get(id).role === role && shots.get(id).viewport === 'mobile'))) throw Error('Mobile evidence required from both sites');
    return { ...d, ...definition, weightedScore: d.score * definition.weight / 100 };
  });
  if (!assessment.summary?.trim() || !['low', 'medium', 'high'].includes(assessment.confidence)) throw Error('Summary and confidence required');
  if (!Array.isArray(assessment.issues) || !Array.isArray(assessment.limitations)) throw Error('Issues and limitations required');
  for (const issue of assessment.issues) {
    if (!['critical', 'major', 'minor'].includes(issue.severity) || !issue.title?.trim() || !issue.detail?.trim() || !DIMENSIONS.some(d => d.id === issue.dimension)) throw Error('Invalid issue');
    validateEvidence(issue.evidence, shots, issue.title);
  }
  return { ...assessment, dimensions, totalScore: Math.round(dimensions.reduce((sum, d) => sum + d.weightedScore, 0) * 10) / 10,
    schemaVersion: 1, ruleVersion: VERSION, configHash: manifest.configHash, scoringStatus: 'scored', scoredAt: new Date().toISOString() };
}
function validateEvidence(ids, shots, label) {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => !shots.has(id))) throw Error(`Unknown or missing evidence: ${label}`);
  if (ids.some(id => ['full', 'diagnostic'].includes(shots.get(id).kind) || shots.get(id).visualUse === 'diagnostic-only')) throw Error(`Diagnostic image cannot establish a score: ${label}`);
  if (!['target', 'reference'].every(role => ids.some(id => shots.get(id).role === role))) throw Error(`Both site roles required: ${label}`);
}
export function reportMarkdown(result, manifest) {
  const artifacts = new Map(Object.values(manifest.captures).flatMap(c => c.artifacts.map(a => [a.id, a])));
  const refs = ids => ids.map(id => `[${id}](${artifacts.get(id).file})`).join(' · ');
  return `# 首页 UI 还原度评测\n\n评测时间：${result.scoredAt}\n\n生成站：${manifest.config.target}\n\n参考站：${manifest.config.reference}\n\n**总分：${result.totalScore}/100；置信度：${result.confidence}**\n\n${result.summary}\n\n评分规则尚未校准；本次为首页静态视觉抽样，不代表全站或功能验收。\n\n## 分项评分\n\n| 维度 | 权重 | 分数 |\n|---|---:|---:|\n${result.dimensions.map(d => `| ${d.name} | ${d.weight}% | ${d.score} |`).join('\n')}\n\n${result.dimensions.map(d => `### ${d.name}\n\n${d.reason}\n\n证据：${refs(d.evidence)}`).join('\n\n')}\n\n## 主要问题\n\n${result.issues.map(i => `### ${i.severity} · ${i.title}\n\n${i.detail}\n\n证据：${refs(i.evidence)}`).join('\n\n')}\n\n## 采集审查\n\n${result.captureReviews.map(r => `- ${r.captureId}：${r.reason}`).join('\n')}\n\n## 局限\n\n${result.limitations.map(s => `- ${s}`).join('\n')}\n`;
}
