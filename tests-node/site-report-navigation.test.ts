import test from 'node:test';
import assert from 'node:assert/strict';
import { reportLocation, siteReportLink } from '../frontend/src/lib/site-reports.js';

test('report navigation preserves old direct links and explicitly returns evaluation tasks to the site history', () => {
  assert.deepEqual(reportLocation('tab=report', 'evaluation-id', 'evaluation'), { reportId: 'evaluation-id', page: 1 });
  assert.deepEqual(reportLocation('tab=report', 'generation-id', 'generation'), { reportId: null, page: 1 });
  const report = siteReportLink('generation-id', 'historical-report', 3);
  assert.equal(report.split('?')[0], '#/tasks/generation-id');
  assert.deepEqual(reportLocation(report.split('?')[1], 'generation-id', 'generation'), { reportId: 'historical-report', page: 3 });
  const history = siteReportLink('evaluation-id', null, 3);
  assert.deepEqual(reportLocation(history.split('?')[1], 'evaluation-id', 'evaluation'), { reportId: null, page: 3 });
  assert.equal(reportLocation('reportPage=-1', 'id', 'generation').page, 1);
  assert.equal(reportLocation('reportPage=NaN', 'id', 'generation').page, 1);
  assert.equal(reportLocation('reportPage=1.5', 'id', 'generation').page, 1);
});
