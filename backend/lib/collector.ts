import type { Evidence, RuleSet, Screenshot, Issue } from '../shared/types.js';
import { saveArtifact } from './artifacts.js';
import { sha256 } from '../runtime.js';

export interface CollectionInput {
  targetUrl: string; readme: string | null; warnings: string[]; referenceUrl?: string;
  scope: 'homepage' | 'site'; rule: RuleSet; evaluationId: string; runId: string; deadline: number;
}
export const collectorVersion = 'kooboo-fullpage-slices-v1';
const metadataScript = `({ title: document.title, text: (document.body?.innerText || '').slice(0,40000), height: document.documentElement.scrollHeight, width: document.documentElement.scrollWidth, images: document.images.length, lazy: [...document.images].filter(i => i.loading === 'lazy' || i.hasAttribute('data-src') || i.hasAttribute('data-srcset')).length, broken: [...document.images].filter(i => i.complete && !i.naturalWidth).length })`;
function check(input: CollectionInput) { if (Date.now() > input.deadline) throw new Error('评测超过 4 分钟时限，请检查站点或模型服务'); }

/** Crop actual pixels from the immutable full-page PNG; this script never visits a target site. */
export function cropScript(base64: string, width: number, height: number, maxHeight: number, regions: number) {
  return `(async () => {
    const image = new Image(); image.src = 'data:image/png;base64,${base64}'; await image.decode();
    const height = Math.min(image.height, ${maxHeight});
    const candidates = [{region:'top',y:0},{region:'middle',y:Math.round(Math.max(0,height-${height})/2)},{region:'bottom',y:Math.max(0,height-${height})}].slice(0,${regions});
    const seen = new Set(); return candidates.filter(p => !seen.has(p.y) && seen.add(p.y)).map(p => {
      const canvas=document.createElement('canvas'); canvas.width=${width}; canvas.height=${height};
      const ctx=canvas.getContext('2d'); ctx.fillStyle='#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(image,0,p.y,${width},Math.min(${height},image.height-p.y),0,0,${width},Math.min(${height},image.height-p.y));
      return {region:p.region,content:canvas.toDataURL('image/png').split(',')[1]};
    });
  })()`;
}

export function collectEvidence(input: CollectionInput): Evidence {
  const screenshots: Screenshot[] = [], issues: Issue[] = [];
  let text = '', title = '', fingerprint = '', stable = true;
  for (const warning of input.warnings) issues.push({ severity: 'major', dimension: 'materials', title: '资料读取不完整', detail: warning, evidence: ['materials-unavailable'] });
  for (const role of ['target', 'reference'] as const) {
    const url = role === 'target' ? input.targetUrl : input.referenceUrl;
    if (!url) continue;
    for (const viewport of input.rule.viewports) {
      check(input);
      const evidenceId = `${role}-${viewport.id}-top`;
      try {
        const options = { width: viewport.width, height: viewport.height, delaySeconds: 2, timeoutSeconds: Math.max(1, Math.floor(input.rule.capture.timeoutMs / 1000)) };
        const readMeta = () => JSON.parse(k.utils.puppeteer.evaluate(url, metadataScript, options));
        const before = readMeta(); check(input);
        if (role === 'target' && viewport.id === 'desktop') { text = before.text; title = before.title; fingerprint = sha256(text); }
        // Avoid unbounded image allocation when a page exceeds the declared sampling budget.
        const fullPage = before.height <= input.rule.capture.maxHeight;
        const temporary = `evaluator-temp/${k.security.newGuid()}.png`;
        let base64: string;
        try {
          k.utils.puppeteer.screenshot(url, temporary, { width: viewport.width, height: viewport.height, delaySeconds: 2, fullPage });
          base64 = k.security.toBase64(k.file.readBinary(temporary));
        } finally { if (k.file.exists(temporary)) k.file.delete(temporary); }
        if (base64.length > 24000000) throw new Error('截图超出 18 MB 上限');
        check(input);
        saveArtifact(input.evaluationId, input.runId, `${role}-${viewport.id}-full.png`, base64);
        const slices = JSON.parse(k.utils.puppeteer.evaluateHtml('<!doctype html><html><body></body></html>', cropScript(base64, viewport.width, viewport.height, input.rule.capture.maxHeight, fullPage ? input.rule.capture.regions : 1), { width: viewport.width, height: viewport.height, timeoutSeconds: 15 }));
        if (!Array.isArray(slices) || !slices.length) throw new Error('截图切片失败');
        for (const slice of slices) {
          if (!['top','middle','bottom'].includes(slice.region) || typeof slice.content !== 'string') throw new Error('截图切片格式错误');
          const id = `${role}-${viewport.id}-${slice.region}`, file = `${id}.png`;
          saveArtifact(input.evaluationId, input.runId, file, slice.content);
          screenshots.push({ id, role, viewport: viewport.id, region: slice.region, file, url, capturedAt: Date.now(), width: viewport.width, height: viewport.height });
        }
        const after = readMeta(); check(input);
        if (before.text !== after.text || before.height !== after.height) {
          stable = false;
          issues.push({ severity: 'major', dimension: 'stability', title: '页面内容在采集中变化', detail: `${role} ${viewport.id} 的正文或高度发生变化`, evidence: [evidenceId] });
        }
        if (!fullPage || before.lazy || after.lazy) issues.push({ severity: 'major', dimension: 'coverage', title: '页面采集覆盖需复核', detail: !fullPage ? `页面高度超过 ${input.rule.capture.maxHeight}px，仅截取顶部` : '检测到懒加载图片；当前 Kooboo 截图接口不能确认逐段滚动后的加载结果', evidence: [evidenceId] });
        if (role === 'target' && before.text.trim().length < 20 && !before.images) issues.push({ severity: 'critical', dimension: 'health', title: '页面可能为空白', detail: '缺少可见正文和图片', evidence: [evidenceId] });
        if (before.broken || after.broken) issues.push({ severity: 'major', dimension: 'health', title: '图片未完整加载', detail: `${role} ${viewport.id} 检测到损坏图片`, evidence: [evidenceId] });
        if (role === 'target' && before.width > viewport.width + 4) issues.push({ severity: 'major', dimension: 'health', title: '页面横向溢出', detail: viewport.id, evidence: [evidenceId] });
      } catch {
        check(input);
        if (role === 'target') throw new Error(`目标站 ${viewport.id} 采集失败，请检查站点可访问性与服务器 Puppeteer 配置`);
        issues.push({ severity: 'major', dimension: 'reference', title: '参考站采集失败', detail: `${viewport.id} 缺少可靠参考证据，本轮不输出还原度`, evidence: ['reference-unavailable'] });
      }
    }
  }
  return { targetUrl: input.targetUrl, targetTitle: title, text, readme: input.readme, screenshots, fingerprint, stable, issues,
    health: issues.some(i => i.dimension === 'health' && i.severity === 'critical') ? 'critical' : issues.some(i => i.dimension === 'health') ? 'warning' : 'ok',
    coverage: { requested: input.scope, actual: 'homepage', complete: input.scope === 'homepage' && !issues.some(i => ['coverage','reference'].includes(i.dimension)), note: 'Kooboo 原生截图：桌面/移动首页整页切片；DOM 检查与截图分别导航。未验收逐段懒加载、资源网络事件、业务交互或动效。' } };
}
