/** Old evaluation links still open that report; generation details start at the site's history. */
export function reportLocation(search: string, taskId: string, kind: 'generation' | 'evaluation') {
  const query = new URLSearchParams(search), requestedPage = Number(query.get('reportPage') || 1);
  return {
    reportId: query.get('view') === 'history' ? null : query.get('report') || (kind === 'evaluation' ? taskId : null),
    page: Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1,
  };
}

export function siteReportLink(taskId: string, reportId: string | null = null, page = 1) {
  const query = new URLSearchParams({ tab: 'report' });
  if (reportId) query.set('report', reportId);
  else query.set('view', 'history');
  if (page > 1) query.set('reportPage', String(page));
  return `#/tasks/${taskId}?${query}`;
}
