import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  TemplateBaseline,
  TemplateChecklist,
  TemplateEvaluation,
  TemplateWorkflowResponse,
} from '../../shared/template-workflow.js';
import {
  appendUrlParam,
  buildPageViewCheckTree,
  buildTemplateStageSteps,
  cloneChecklistForEdit,
  createBlankTemplateCheck,
  describeTemplateWorkflowGuidance,
  resolveTemplateEvidenceHref,
  sanitizeTemplateChecklistInput,
  shouldShowRepairStage,
  summarizeTemplateEvaluation,
  toPreviewArtifacts,
  validateTemplateChecklist,
} from '../src/lib/template-workflow.js';
import { isRouteMissing } from '../src/lib/template-workflow-client.js';

const TASK_ID = '11111111-2222-4333-8444-555555555555';
const ROOT_ID = '11111111-2222-4333-8444-555555555555';
const REF_PNG = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png';
const TARGET_PNG = 'ffffffff-1111-4222-8333-444444444444.png';

function sampleChecklist(): TemplateChecklist {
  return {
    id: '22222222-3333-4444-8555-666666666666',
    revision: 2,
    hash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    createdAt: 1762920000000,
    name: 'AI Site 区块检查 v2',
    checks: [
      {
        id: 'view-presence',
        title: '区块组成',
        enabled: true,
        kind: 'presence',
        executor: 'hybrid',
        instruction: '核对必需语义区块是否存在',
        scopes: ['homepage', 'site'],
        viewports: ['desktop', 'mobile'],
        required: true,
        severity: 'critical',
        weight: 2,
        tolerancePx: 0,
        exceptions: '',
      },
      {
        id: 'content-gutter',
        title: '正文留白',
        enabled: true,
        kind: 'gutter',
        executor: 'script',
        instruction: '检查移动端正文左右安全边距',
        scopes: ['homepage', 'site'],
        viewports: ['mobile'],
        required: true,
        severity: 'major',
        weight: 1,
        tolerancePx: 8,
        exceptions: '满宽背景与横向轮播卡片允许贴边露出',
      },
    ],
  };
}

function sampleBaseline(): TemplateBaseline {
  return {
    id: '33333333-4444-4555-8666-777777777777',
    revision: 1,
    createdAt: 1762920100000,
    inputVersionId: '44444444-5555-4666-8777-888888888888',
    referenceUrl: 'https://detailix.webflow.io/',
    contentUrl: null,
    scope: 'site',
    checklistId: sampleChecklist().id,
    complete: true,
    contentMapping: '使用模板默认服务分类与占位联系方式',
    limitations: [],
    pages: [
      {
        path: '/',
        title: '首页',
        views: [
          {
            id: 'hero',
            title: '首屏主视觉',
            role: 'hero',
            required: true,
            layouts: [
              {
                viewport: 'desktop',
                selector: 'section.hero',
                evidence: [REF_PNG],
                intent: '左侧标题与描述组，右侧筛选操作区水平并列',
                exceptions: '标题随替换文案允许两行以内自然换行',
                constraints: [
                  {
                    id: 'c-hero-rel',
                    checkId: 'view-presence',
                    expected: '保留主标题组与操作区',
                    anchors: ['.hero-copy', '.hero-cta'],
                    relation: 'left-of',
                  },
                ],
              },
            ],
          },
          {
            id: 'contact',
            title: '联系我们',
            role: 'contact',
            required: true,
            layouts: [],
          },
        ],
      },
    ],
    evidence: [
      {
        name: REF_PNG,
        ownerTaskId: ROOT_ID,
        role: 'reference',
        viewport: 'desktop',
        url: 'https://detailix.webflow.io/',
        type: 'image/png',
        sha256: '0'.repeat(64),
        size: 4096,
        siteRevision: null,
        href: `/api/automation/tasks/${TASK_ID}/template-workflow/artifacts/${REF_PNG}`,
      },
    ],
  };
}

function sampleEvaluation(quality: TemplateEvaluation['quality'] = 'failed'): TemplateEvaluation {
  return {
    taskId: TASK_ID,
    siteRevision: 'rev-20261112-a',
    baselineId: sampleBaseline().id,
    checklistId: sampleChecklist().id,
    createdAt: 1762920500000,
    complete: quality !== 'unverified',
    quality,
    captures: [
      {
        pagePath: '/',
        viewport: 'desktop',
        mode: 'inherited',
        selectors: [],
        reason: 'PC 端样式与依赖签名未变，继承首轮采集证据',
        evidence: [TARGET_PNG],
        complete: true,
        sourceTaskId: ROOT_ID,
        sourceRevision: 'rev-20261112-0',
      },
      {
        pagePath: '/',
        viewport: 'mobile',
        mode: 'regions',
        selectors: ['section.contact'],
        reason: '修复仅改动联系区块移动端内边距，局部重采该区块与上下衔接区域',
        evidence: [],
        complete: true,
      },
    ],
    checks: [
      {
        id: 'chk-1',
        checkId: 'view-presence',
        pagePath: '/',
        viewId: 'hero',
        viewport: 'desktop',
        status: 'passed',
        expected: '存在首屏主视觉',
        actual: '已匹配首屏区块',
        reason: '语义角色一致',
        score: 95,
        evidence: [TARGET_PNG],
        provenance: 'inherited',
        sourceTaskId: ROOT_ID,
        sourceRevision: 'rev-20261112-0',
        inheritanceReason: '依赖哈希一致',
      },
      {
        id: 'chk-2',
        checkId: 'content-gutter',
        pagePath: '/',
        viewId: 'contact',
        viewport: 'mobile',
        status: quality === 'passed' ? 'passed' : 'failed',
        expected: '左右留白 >= 16px（容差 8px）',
        actual: quality === 'passed' ? '左右留白 20px' : '左右留白 2px，正文贴近视口边缘',
        reason: '脚本几何测量核对',
        score: quality === 'passed' ? 92 : 40,
        measurements: { paddingLeft: quality === 'passed' ? 20 : 2, paddingRight: 2 },
        evidence: [],
        provenance: 'measured',
        sourceTaskId: TASK_ID,
        sourceRevision: 'rev-20261112-a',
      },
      {
        id: 'chk-3',
        checkId: 'view-presence',
        pagePath: '/',
        viewId: 'contact',
        viewport: 'desktop',
        status: 'unverified',
        expected: '存在联系区块',
        actual: '桌面截图待补采',
        reason: '缺少当前修订桌面截图，保留未验证',
        score: null,
        evidence: [],
        provenance: 'unverified',
        sourceTaskId: TASK_ID,
        sourceRevision: 'rev-20261112-a',
      },
    ],
    issues:
      quality === 'passed'
        ? [
            {
              id: 'issue-contact-gutter',
              checkResultId: 'chk-2',
              pagePath: '/',
              viewId: 'contact',
              viewport: 'mobile',
              title: '移动端联系区块正文贴边',
              severity: 'major',
              expected: '正文距离屏幕边缘不少于 16px',
              actual: '已恢复 20px 内边距',
              acceptance: '独立复验移动端实测留白达标且无横向溢出',
              evidence: [],
              status: 'done',
            },
          ]
        : [
            {
              id: 'issue-contact-gutter',
              checkResultId: 'chk-2',
              pagePath: '/',
              viewId: 'contact',
              viewport: 'mobile',
              title: '移动端联系区块正文贴边',
              severity: 'major',
              expected: '正文距离屏幕边缘不少于 16px',
              actual: '实测左右留白仅 2px',
              acceptance: '独立复验移动端实测留白达标且无横向溢出',
              evidence: [],
              status: 'open',
            },
          ],
    evidence: [
      {
        name: TARGET_PNG,
        ownerTaskId: ROOT_ID,
        role: 'target',
        viewport: 'desktop',
        url: 'https://target.example.test/',
        type: 'image/png',
        sha256: '1'.repeat(64),
        size: 8192,
        siteRevision: 'rev-20261112-0',
        href: `/api/automation/tasks/${TASK_ID}/template-workflow/artifacts/${TARGET_PNG}`,
      },
    ],
  };
}

test('checklist validation enforces unique IDs, enabled check presence, and non-negative bounds', () => {
  const base = cloneChecklistForEdit(sampleChecklist());
  assert.equal(validateTemplateChecklist(base).valid, true);

  // Duplicate IDs and disabled-all should fail
  const invalid = structuredClone(base);
  invalid.checks[0].enabled = false;
  invalid.checks[1].enabled = false;
  invalid.checks[1].id = invalid.checks[0].id;
  invalid.checks[1].tolerancePx = -5;
  invalid.checks[0].scopes = [];

  const result = validateTemplateChecklist(invalid);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(msg => msg.includes('至少启用一个检查项')));
  assert.ok(result.checkErrors[0]?.some(msg => msg.includes('适用范围')));
  assert.ok(result.checkErrors[1]?.some(msg => msg.includes('重复')));
  assert.ok(result.checkErrors[1]?.some(msg => msg.includes('像素容差')));

  const blank = createBlankTemplateCheck(base.checks);
  assert.ok(!base.checks.some(c => c.id === blank.id));

  const sanitized = sanitizeTemplateChecklistInput({
    name: '  新版本检查集  ',
    checks: [{ ...base.checks[0], title: '  区块组成  ', exceptions: '  允许满宽  ' }],
  });
  assert.equal(sanitized.name, '新版本检查集');
  assert.equal(sanitized.checks[0].title, '区块组成');
  assert.equal(sanitized.checks[0].exceptions, '允许满宽');
});

test('workflow stage builder keeps initial pass to 3 stages and adds repair only when needed', () => {
  const passedEval = sampleEvaluation('passed');
  passedEval.checks = passedEval.checks.filter(c => c.status !== 'unverified');
  const passedWorkflow: TemplateWorkflowResponse = {
    supported: true,
    taskId: TASK_ID,
    rootTaskId: ROOT_ID,
    version: 1,
    phase: 'completed',
    checklist: sampleChecklist(),
    baseline: sampleBaseline(),
    evaluation: passedEval,
    limitations: [],
  };

  assert.equal(shouldShowRepairStage(passedWorkflow, 0), false);
  const initialPassSteps = buildTemplateStageSteps(passedWorkflow, 'completed', 0);
  assert.deepEqual(initialPassSteps.map(s => s.id), ['analysis', 'generation', 'evaluation']);
  assert.ok(initialPassSteps.every(s => s.state === 'completed'));

  // Failed evaluation exposes repair stage and marks evaluation as needing attention
  const failedWorkflow: TemplateWorkflowResponse = {
    ...passedWorkflow,
    phase: 'evaluation',
    evaluation: sampleEvaluation('failed'),
  };
  assert.equal(shouldShowRepairStage(failedWorkflow, 0), true);
  const failedSteps = buildTemplateStageSteps(failedWorkflow, 'completed', 0);
  assert.deepEqual(failedSteps.map(s => s.id), ['analysis', 'generation', 'evaluation', 'repair']);
  assert.equal(failedSteps[2].state, 'attention');

  // Incomplete coverage must never mark evaluation stage as completed even if quality field says passed
  const incompleteWorkflow: TemplateWorkflowResponse = {
    ...passedWorkflow,
    evaluation: { ...passedEval, complete: false },
  };
  const incompleteSteps = buildTemplateStageSteps(incompleteWorkflow, 'completed', 0);
  assert.equal(incompleteSteps[2].state, 'attention');
  const guidance = describeTemplateWorkflowGuidance(incompleteWorkflow);
  assert.equal(guidance.tone, 'warning');
});

test('evaluation summary and page->view->check drilldown preserve provenance without treating null score as zero', () => {
  const checklist = sampleChecklist();
  const baseline = sampleBaseline();
  const evaluation = sampleEvaluation('failed');

  const summary = summarizeTemplateEvaluation(evaluation, checklist);
  assert.equal(summary.passedChecks, 1);
  assert.equal(summary.failedChecks, 1);
  assert.equal(summary.unverifiedChecks, 1);
  assert.equal(summary.failedRequiredChecks, 1);
  assert.equal(summary.measuredChecks, 1);
  assert.equal(summary.inheritedChecks, 1);
  assert.equal(summary.unverifiedProvenanceChecks, 1);
  assert.equal(summary.openIssues, 1);

  // Desktop has 1 scored check (95) and 1 unverified null score: weighted score stays 95, not diluted by 0!
  const desktop = summary.viewportScores.find(v => v.viewport === 'desktop')!;
  assert.equal(desktop.score, 95);
  assert.equal(desktop.scoredCount, 1);
  assert.equal(desktop.unverifiedCount, 1);

  // Explicit backend evaluation.scores takes precedence when provided (including explicit null for unverified viewport)
  const serverScoredSummary = summarizeTemplateEvaluation(
    {
      ...evaluation,
      scores: [
        { viewport: 'desktop', value: null },
        { viewport: 'mobile', value: 78.44 },
      ],
    },
    checklist,
  );
  assert.equal(serverScoredSummary.viewportScores.find(v => v.viewport === 'desktop')!.score, null);
  assert.equal(serverScoredSummary.viewportScores.find(v => v.viewport === 'mobile')!.score, 78.4);

  const tree = buildPageViewCheckTree(evaluation, baseline, checklist);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].pagePath, '/');
  assert.deepEqual(tree[0].views.map(v => v.viewId), ['hero', 'contact']);
  // Failed check should sort before unverified inside 'contact'
  assert.deepEqual(tree[0].views[1].checks.map(c => c.result.id), ['chk-2', 'chk-3']);

  const inheritedOnly = buildPageViewCheckTree(evaluation, baseline, checklist, { provenance: 'inherited' });
  assert.equal(inheritedOnly.length, 1);
  assert.equal(inheritedOnly[0].views.length, 1);
  assert.equal(inheritedOnly[0].views[0].viewId, 'hero');
});

test('evidence href resolution rejects traversal or non-API paths and preserves valid registered links', () => {
  const valid = sampleBaseline().evidence[0];
  assert.equal(
    resolveTemplateEvidenceHref(valid, TASK_ID),
    `/api/automation/tasks/${TASK_ID}/template-workflow/artifacts/${REF_PNG}`,
  );
  assert.equal(
    resolveTemplateEvidenceHref({ ...valid, href: '/api/automation/tasks/../secret.png' }, TASK_ID),
    null,
  );
  assert.equal(
    resolveTemplateEvidenceHref({ ...valid, href: 'file:///Users/test/secret.png' }, TASK_ID),
    null,
  );
  assert.equal(
    resolveTemplateEvidenceHref({ ...valid, href: '/var/data/evidence.png' }, TASK_ID),
    null,
  );
  assert.equal(
    resolveTemplateEvidenceHref({ ...valid, href: '', name: '../../etc/passwd' }, TASK_ID),
    null,
  );

  const artifacts = toPreviewArtifacts([valid, { ...valid, name: 'bad.png', href: '/etc/passwd' }], TASK_ID);
  assert.equal(artifacts.length, 1);
  assert.equal(appendUrlParam('/api/test/a.png', 'download', '1'), '/api/test/a.png?download=1');
  assert.equal(appendUrlParam('/api/test/a.png?v=1', 'download', '1'), '/api/test/a.png?v=1&download=1');
});

test('endpoint classifier distinguishes unmounted Fastify 404 routes from real domain 404 errors', () => {
  assert.equal(
    isRouteMissing(
      { status: 404 },
      { statusCode: 404, error: 'Not Found', message: 'Route GET:/api/automation/template-checklists not found' },
    ),
    true,
  );
  assert.equal(isRouteMissing({ status: 501 }, null), true);
  assert.equal(isRouteMissing({ status: 404 }, { error: '任务不存在' }), false);
  assert.equal(isRouteMissing({ status: 404 }, { error: '证据不存在或不属于此工作流' }), false);
  assert.equal(isRouteMissing({ status: 200 }, { supported: false }), false);
});
