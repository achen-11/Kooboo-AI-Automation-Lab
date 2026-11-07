import type { MaterialFile } from '../../../shared/automation';

export interface EvidenceContext {
  title: string;
  detail: string;
  evidence: string[];
  severity?: 'critical' | 'major' | 'minor';
}

export function evidenceImages(artifacts: MaterialFile[], names: string[]): MaterialFile[] {
  const files = new Map(artifacts.filter(file => file.type === 'image/png').map(file => [file.name, file]));
  return [...new Set(names)].flatMap(name => files.has(name) ? [files.get(name)!] : []);
}

/** Only compare screenshots explicitly cited in this context and captured at the same viewport. */
export function comparisonFor(files: MaterialFile[], selected: MaterialFile): { reference: MaterialFile; target: MaterialFile } | null {
  if (!selected.viewport || !['reference', 'target'].includes(selected.role || '')) return null;
  const other = files.find(file => file.viewport === selected.viewport && file.role === (selected.role === 'target' ? 'reference' : 'target'));
  if (!other) return null;
  return selected.role === 'reference' ? { reference: selected, target: other } : { reference: other, target: selected };
}

export function evidenceLabel(file: MaterialFile, index: number): string {
  const role = file.role === 'reference' ? '参考站' : file.role === 'target' ? '生成站' : file.role === 'content' ? '内容站' : '截图';
  const viewport = file.viewport === 'desktop' ? 'PC' : file.viewport === 'mobile' ? '移动端' : '';
  return [role, viewport, `证据 ${index + 1}`].filter(Boolean).join(' · ');
}
