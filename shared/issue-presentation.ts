import type { Evidence, Issue, Report } from './types.js';

/** Recognize only the old collector's count-only warning, never a visual finding. */
export function isImageLoadDiagnostic(issue: Issue): boolean {
  return issue.title === '图片未完整加载' &&
    ['health', 'reference-assets'].includes(issue.dimension) &&
    (!issue.capture || issue.capture.stage === '采集检查') &&
    /^\d+ 张未完成，\d+ 张损坏$/.test(issue.detail);
}

/** Keep stored indices stable for ignore, restore and repair actions. */
export function presentedIssues(issues: Issue[]) {
  return issues.map((issue, index) => ({ issue, index }))
    .filter(({ issue }) => !isImageLoadDiagnostic(issue));
}

export function presentedHealth(report: Pick<Report, 'health' | 'issues'>): Evidence['health'] {
  if (report.health === 'warning' &&
      report.issues.some(issue => issue.dimension === 'health' && isImageLoadDiagnostic(issue)) &&
      !report.issues.some(issue => issue.dimension === 'health' && !isImageLoadDiagnostic(issue)))
    return 'ok';
  return report.health;
}
