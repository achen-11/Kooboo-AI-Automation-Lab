import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import {
  defaultAutomationSettings,
  defaultDeliveryPolicy,
  defaultFollowupSettings,
  defaultOptimizationPolicy,
  type AutomationReport,
  type AutomationRule,
  type AutomationTask,
} from '../shared/automation.js';
import type { TaskWorkflowGraph } from '../shared/workflow-graph.js';

const sampleRule: AutomationRule = {
  id: randomUUID(),
  name: '基础评测规则',
  kind: 'site',
  scenarios: ['materials', 'migration', 'upgrade', 'site-template'],
  sop: 'Check both viewports',
  references: '',
  createdAt: Date.now(),
  hash: 'rule-hash-1',
  criteria: [
    {
      id: 'visual',
      label: '视觉还原',
      weight: 100,
      instruction: 'Check layout',
      required: true,
      viewports: ['desktop', 'mobile'],
      scopes: ['homepage', 'site'],
    },
  ],
};

function makeReport(quality: 'passed' | 'failed' | 'unverified', desktop: number, mobile: number): AutomationReport {
  return {
    summary: quality === 'passed' ? '双端表现良好，通过核验' : '移动端首屏留白与桌面端间距需调整',
    assessments: [
      { criterionId: 'visual', viewport: 'desktop', score: desktop, reason: 'ok', evidence: [], passed: desktop >= 85 },
      { criterionId: 'visual', viewport: 'mobile', score: mobile, reason: 'ok', evidence: [], passed: mobile >= 85 },
    ],
    issues: quality === 'passed'
      ? []
      : [{ severity: 'major', title: '移动端首屏对齐偏差', detail: '卡片内边距不一致', evidence: [] }],
    coverage: { verified: ['desktop', 'mobile'], unverified: [], outOfScope: [] },
    scores: [
      { viewport: 'desktop', value: desktop },
      { viewport: 'mobile', value: mobile },
    ],
    quality,
    artifacts: [],
  };
}

async function fixture(options: { autoEnabled?: boolean; deliveryEnabled?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-graph-test-'));
  const services = await createApp({ directory, serveWeb: false, startWorker: false });
  const login = await services.app.inject({ method: 'POST', url: '/api/login' });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const headers = { cookie };
  const environmentId = randomUUID();
  services.vault.update({
    threshold: 85,
    paused: true,
    execution: { timeoutSeconds: 300, captureAttempts: 2 },
    model: { endpoint: 'https://model.test/v1', name: 'test', apiKey: 'secret-model-key' },
    environments: [
      {
        id: environmentId,
        name: 'TestEnv',
        origin: 'https://kooboo.test',
        apiOrigin: 'https://kooboo.test',
        token: 'secret-kooboo-token',
        ...(options.deliveryEnabled
          ? { delivery: { ...defaultDeliveryPolicy, enabled: true, token: 'secret-delivery-token', auto: true } }
          : {}),
      },
    ],
    automation: {
      ...defaultAutomationSettings,
      enabled: options.autoEnabled ?? true,
    },
  });

  const saveResource = async (overrides: Record<string, unknown> = {}) => {
    const res = await services.app.inject({
      method: 'POST',
      url: '/api/automation/resources',
      headers,
      payload: {
        name: 'Corp Site',
        scenario: 'materials',
        description: '企业官网资料',
        contentUrl: '',
        referenceUrl: 'https://ref.example.com',
        externalSource: '',
        externalId: '',
        files: [],
        ...overrides,
      },
    });
    return res.json();
  };

  const fetchWorkflow = async (taskId: string) => {
    const res = await services.app.inject({
      method: 'GET',
      url: `/api/automation/tasks/${taskId}/workflow`,
      headers,
    });
    return { statusCode: res.statusCode, body: res.json() as TaskWorkflowGraph };
  };

  return {
    ...services,
    directory,
    headers,
    environmentId,
    saveResource,
    fetchWorkflow,
    async close() {
      await services.app.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('interrupted prepare stage with site name collision pinpoints prepare blocker and sanitizes secrets', async () => {
  const f = await fixture();
  try {
    const res = await f.saveResource();
    const task = f.automationStore.create(
      { resourceIds: [res.id], kind: 'generation', scope: 'homepage', environmentId: f.environmentId, requirements: '建站' },
      defaultAutomationSettings,
    )[0];
    task.status = 'interrupted';
    task.stopped = true;
    task.stage = 'prepare';
    task.error = '自定义站点名或子域名已被占用（secret-kooboo-token 不可暴露）';
    task.interruption = {
      stage: 'prepare',
      reason: '自定义站点名或子域名已被占用：corp_demo',
      evidence: [],
      attempted: [],
      nextSteps: ['更换站点名'],
      resumeFrom: 'prepare',
      time: Date.now(),
    };
    f.automationStore.put(task);

    const { statusCode, body } = await f.fetchWorkflow(task.id);
    assert.equal(statusCode, 200);
    assert.equal(body.overallStatus, 'attention');
    assert.ok(body.blocker);
    assert.equal(body.blocker!.nodeId, 'prepare');
    assert.equal(body.blocker!.category, 'site-collision');
    assert.equal(body.blocker!.recoveryAction, 'adjust-site-names');
    assert.equal(body.nodes.find((n) => n.id === 'prepare')?.isBlocker, true);
    assert.equal(body.nodes.find((n) => n.id === 'prepare')?.durationMs, null, 'missing lifecycle timing must stay null');
    assert.ok(!JSON.stringify(body).includes('secret-kooboo-token'));
    assert.ok(!JSON.stringify(body).includes('secret-model-key'));
  } finally {
    await f.close();
  }
});

test('queued task with paused automation explains waiting reason on the target stage node', async () => {
  const f = await fixture({ autoEnabled: false });
  try {
    const res = await f.saveResource();
    const task = f.automationStore.create(
      { resourceIds: [res.id], kind: 'generation', scope: 'homepage', environmentId: f.environmentId, requirements: '' },
      defaultAutomationSettings,
    )[0];

    const { statusCode, body } = await f.fetchWorkflow(task.id);
    assert.equal(statusCode, 200);
    assert.equal(body.overallStatus, 'queued');
    assert.ok(body.blocker);
    assert.equal(body.blocker!.severity, 'waiting');
    assert.equal(body.blocker!.queueCode, 'paused');
    assert.equal(body.blocker!.nodeId, 'prepare');
    assert.match(body.blocker!.explanation, /暂停/);
  } finally {
    await f.close();
  }
});

test('followup running task attaches followup branch node to active stage', async () => {
  const f = await fixture();
  try {
    const res = await f.saveResource();
    const task = f.automationStore.create(
      { resourceIds: [res.id], kind: 'generation', scope: 'homepage', environmentId: f.environmentId, requirements: '' },
      defaultAutomationSettings,
    )[0];
    task.status = 'following-up';
    task.stopped = false;
    task.stage = 'generation';
    task.generation = { prepared: true, deliveryId: randomUUID(), deliveryState: 'accepted' };
    task.followup = {
      state: 'running',
      attempts: 1,
      startedAt: Date.now() - 5000,
      nextAt: Date.now(),
      tokens: 1200,
      threadId: 'thr_123',
      policy: defaultFollowupSettings,
      executionStopped: true,
      observations: [],
      lastAction: {
        action: 'continue',
        reason: '继续推进页面构建',
        evidence: [],
      },
    };
    f.automationStore.put(task);

    const { body } = await f.fetchWorkflow(task.id);
    const followup = body.nodes.find((n) => n.id === 'followup');
    assert.ok(followup);
    assert.equal(followup.lane, 'branch');
    assert.equal(followup.anchorNodeId, 'generation');
    assert.equal(followup.status, 'running');
    assert.ok(body.edges.some((e) => e.from === 'generation' && e.to === 'followup' && e.kind === 'branch'));
  } finally {
    await f.close();
  }
});

test('optimization loop with rounds, evaluation child view, delivery, and learning projects full graph', async () => {
  const f = await fixture({ deliveryEnabled: true });
  try {
    const res = await f.saveResource({ scenario: 'migration', contentUrl: 'https://old.example.com', referenceUrl: '' });
    const site = {
      id: randomUUID(),
      resourceId: res.id,
      versionId: f.automationStore.versions(res.id)[0].id,
      environmentId: f.environmentId,
      siteId: randomUUID(),
      name: 'migrated_site',
      url: 'https://migrated.kooboo.test',
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(site);

    const root = f.automationStore.create(
      {
        resourceIds: [res.id],
        kind: 'generation',
        scope: 'site',
        environmentId: f.environmentId,
        generatedSiteId: site.id,
        requirements: '迁移全站',
        ruleSnapshot: sampleRule,
        optimization: { targetScore: 85, maxRounds: 3, maxCostCny: null },
        autoDelivery: true,
      },
      defaultAutomationSettings,
    )[0];
    root.status = 'completed';
    root.stopped = true;
    root.stage = 'optimization';
    root.siteUrl = site.url;
    root.siteRevision = 'rev-1';
    root.generation = { prepared: true, deliveryId: randomUUID(), deliveryState: 'completed' };

    const eval0 = f.automationStore.create(
      {
        resourceIds: [res.id],
        kind: 'evaluation',
        scope: 'site',
        environmentId: f.environmentId,
        generatedSiteId: site.id,
        requirements: '',
        parentId: root.id,
        ruleSnapshot: sampleRule,
        optimizationRootId: root.id,
        optimizationRound: 0,
      },
      defaultAutomationSettings,
    )[0];
    eval0.status = 'completed';
    eval0.stopped = true;
    eval0.siteRevision = 'rev-0';
    eval0.report = makeReport('failed', 88, 72);
    f.automationStore.put(eval0);

    const repair1 = f.automationStore.create(
      {
        resourceIds: [res.id],
        kind: 'generation',
        scope: 'site',
        environmentId: f.environmentId,
        generatedSiteId: site.id,
        requirements: '修复移动端对齐',
        parentId: root.id,
        ruleSnapshot: sampleRule,
        optimizationRootId: root.id,
        optimizationRound: 1,
      },
      defaultAutomationSettings,
    )[0];
    repair1.status = 'completed';
    repair1.stopped = true;
    repair1.siteRevision = 'rev-1';
    repair1.generation = { prepared: true, deliveryId: randomUUID(), deliveryState: 'completed' };
    f.automationStore.put(repair1);

    const eval1 = f.automationStore.create(
      {
        resourceIds: [res.id],
        kind: 'evaluation',
        scope: 'site',
        environmentId: f.environmentId,
        generatedSiteId: site.id,
        requirements: '',
        parentId: root.id,
        ruleSnapshot: sampleRule,
        optimizationRootId: root.id,
        optimizationRound: 1,
      },
      defaultAutomationSettings,
    )[0];
    eval1.status = 'completed';
    eval1.stopped = true;
    eval1.siteRevision = 'rev-1';
    eval1.report = makeReport('passed', 91, 89);
    eval1.delivery = {
      id: randomUUID(),
      policy: { ...defaultDeliveryPolicy, enabled: true },
      status: 'completed',
      stopped: true,
      sourceEnvironmentId: f.environmentId,
      sourceSiteId: site.siteId,
      sourceUrl: site.url,
      evaluationTaskId: eval1.id,
      target: { siteId: randomUUID(), siteUrl: 'https://delivered.kooboo.test' },
      updatedAt: Date.now(),
      error: '',
      checks: [{ url: 'https://delivered.kooboo.test/', status: 200, ok: true, detail: 'ok' }],
    };
    f.automationStore.put(eval1);
    f.automationStore.beginSiteChange(repair1);
    eval1.siteRevision = repair1.siteRevision;
    f.automationStore.put(eval1);
    f.automationStore.publishSiteReport(eval1);

    root.evaluationTaskId = eval1.id;
    root.optimization = {
      policy: defaultOptimizationPolicy,
      state: 'completed',
      rounds: [
        {
          number: 0,
          revision: 'rev-0',
          generationTaskId: root.id,
          evaluationTaskId: eval0.id,
          progress: { improved: false, reason: '移动端待优化', resolved: [], remaining: ['移动端对齐'], unverified: [], introduced: [] },
          startedAt: Date.now() - 20000,
        },
        {
          number: 1,
          revision: repair1.siteRevision!,
          generationTaskId: repair1.id,
          evaluationTaskId: eval1.id,
          progress: { improved: true, reason: '已修复移动端对齐并达标', resolved: ['移动端对齐'], remaining: [], unverified: [], introduced: [] },
          startedAt: Date.now() - 10000,
        },
      ],
      activeTaskId: eval1.id,
      currentRevision: repair1.siteRevision!,
      reportId: eval1.id,
      noImprovement: 0,
      reason: '双端均达标',
      nextSteps: [],
      recoveryPolicy: defaultFollowupSettings,
      threshold: 85,
    };
    f.automationStore.put(root);

    // Querying from the child evaluation task resolves to the full workflow root
    const { body } = await f.fetchWorkflow(eval1.id);
    assert.equal(body.rootTaskId, root.id);
    assert.equal(body.viewingTaskId, eval1.id);
    assert.equal(body.overallStatus, 'completed');
    assert.equal(body.blocker, null);
    assert.ok(body.nodes.some((n) => n.id === 'quality-gate' && n.status === 'completed'));
    assert.ok(body.nodes.some((n) => n.id === 'optimization' && n.status === 'completed'));
    assert.ok(body.nodes.some((n) => n.id === 'delivery' && n.status === 'completed'));
    assert.ok(body.edges.some((e) => e.kind === 'fail'));
    assert.ok(body.edges.some((e) => e.kind === 'loop'));
    assert.ok(body.edges.some((e) => e.kind === 'pass'));
    assert.equal(body.rounds.length, 2);
    assert.equal(body.rounds[1].improved, true);
  } finally {
    await f.close();
  }
});

test('standalone evaluation task shows adapted evaluation workflow without generation/optimization/delivery nodes', async () => {
  const f = await fixture();
  try {
    const res = await f.saveResource();
    const site = {
      id: randomUUID(),
      resourceId: res.id,
      versionId: f.automationStore.versions(res.id)[0].id,
      environmentId: f.environmentId,
      siteId: randomUUID(),
      name: 'eval_only',
      url: 'https://eval.kooboo.test',
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(site);
    const evalTask = f.automationStore.create(
      {
        resourceIds: [res.id],
        kind: 'evaluation',
        scope: 'homepage',
        environmentId: f.environmentId,
        generatedSiteId: site.id,
        requirements: '',
        ruleSnapshot: sampleRule,
      },
      defaultAutomationSettings,
    )[0];
    evalTask.status = 'completed';
    evalTask.stopped = true;
    evalTask.report = makeReport('failed', 90, 74);
    f.automationStore.put(evalTask);

    const { body } = await f.fetchWorkflow(evalTask.id);
    assert.equal(body.kind, 'evaluation');
    assert.deepEqual(
      body.nodes.filter((n) => n.lane === 'main').map((n) => n.id),
      ['evaluation'],
    );
    assert.equal(body.nodes.find((n) => n.id === 'prepare'), undefined);
    assert.equal(body.nodes.find((n) => n.id === 'generation'), undefined);
    assert.equal(body.nodes.find((n) => n.id === 'quality-gate'), undefined);
    assert.equal(body.nodes.find((n) => n.id === 'optimization'), undefined);
    assert.equal(body.nodes.find((n) => n.id === 'delivery'), undefined);
    assert.equal(body.nodes.find((n) => n.id === 'learning'), undefined);
    assert.equal(body.edges.length, 0);
    assert.ok(body.blocker);
    assert.equal(body.blocker!.severity, 'warning');
    assert.equal(body.blocker!.nodeId, 'evaluation');
  } finally {
    await f.close();
  }
});

test('multi-hop manual re-evaluation walks ancestry back to generation and omits unconfigured gate/optimization/delivery nodes', async () => {
  const f = await fixture();
  try {
    const res = await f.saveResource();
    const site = {
      id: randomUUID(),
      resourceId: res.id,
      versionId: f.automationStore.versions(res.id)[0].id,
      environmentId: f.environmentId,
      siteId: randomUUID(),
      name: 'coffee_shop',
      url: 'https://coffee.kooboo.test',
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(site);

    const gen = f.automationStore.create(
      {
        resourceIds: [res.id],
        kind: 'generation',
        scope: 'homepage',
        environmentId: f.environmentId,
        generatedSiteId: site.id,
        requirements: '建站',
        ruleSnapshot: sampleRule,
      },
      defaultAutomationSettings,
    )[0];
    gen.status = 'completed';
    gen.stopped = true;
    gen.stage = 'handoff';
    gen.siteUrl = site.url;
    gen.generation = { prepared: true, deliveryId: randomUUID(), deliveryState: 'completed' };
    f.automationStore.put(gen);

    const eval1 = f.automationStore.create(
      {
        resourceIds: [res.id],
        kind: 'evaluation',
        scope: 'homepage',
        environmentId: f.environmentId,
        generatedSiteId: site.id,
        requirements: '',
        parentId: gen.id,
        ruleSnapshot: sampleRule,
      },
      defaultAutomationSettings,
    )[0];
    eval1.status = 'completed';
    eval1.stopped = true;
    eval1.report = makeReport('failed', 80, 70);
    f.automationStore.put(eval1);

    const eval2 = f.automationStore.create(
      {
        resourceIds: [res.id],
        kind: 'evaluation',
        scope: 'homepage',
        environmentId: f.environmentId,
        generatedSiteId: site.id,
        requirements: '再次手动重评',
        parentId: eval1.id,
        ruleSnapshot: sampleRule,
      },
      defaultAutomationSettings,
    )[0];
    eval2.status = 'completed';
    eval2.stopped = true;
    eval2.report = makeReport('failed', 92.6, 74.4);
    f.automationStore.put(eval2);

    const { body } = await f.fetchWorkflow(eval2.id);
    assert.equal(body.rootTaskId, gen.id);
    assert.equal(body.viewingTaskId, eval2.id);
    assert.deepEqual(
      body.nodes.filter((n) => n.lane === 'main').map((n) => n.id),
      ['prepare', 'generation', 'evaluation'],
    );
    assert.equal(body.nodes.find((n) => n.id === 'prepare')?.status, 'completed');
    assert.equal(body.nodes.find((n) => n.id === 'generation')?.status, 'completed');
    const evalNode = body.nodes.find((n) => n.id === 'evaluation');
    assert.equal(evalNode?.status, 'completed');
    assert.equal(evalNode?.taskId, eval2.id);
    assert.ok(evalNode?.metrics?.some((m) => m.value === '92.6 分'));
    assert.equal(body.nodes.find((n) => n.id === 'quality-gate'), undefined);
    assert.equal(body.nodes.find((n) => n.id === 'optimization'), undefined);
    assert.equal(body.nodes.find((n) => n.id === 'delivery'), undefined);
    assert.equal(body.nodes.find((n) => n.id === 'learning'), undefined);
  } finally {
    await f.close();
  }
});

test('workflow graph omits evaluation/quality-gate/optimization/learning when disabled and reflects HTTP-only direct delivery', async () => {
  const f = await fixture({ deliveryEnabled: true });
  try {
    f.vault.updateAutomation({
      ...defaultAutomationSettings,
      enabled: true,
      autoEvaluate: false,
      learning: { ...defaultAutomationSettings.learning!, collect: false, use: false },
    });
    const res = await f.saveResource();
    const version = f.automationStore.versions(res.id)[0];
    const site = {
      id: randomUUID(),
      resourceId: res.id,
      versionId: version.id,
      environmentId: f.environmentId,
      siteId: randomUUID(),
      name: 'DirectSite',
      url: 'https://direct-site.test/',
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(site);

    const gen = f.automationStore.create(
      {
        resourceIds: [res.id],
        kind: 'generation',
        scope: 'homepage',
        environmentId: f.environmentId,
        generatedSiteId: site.id,
        autoEvaluate: false,
        autoDelivery: true,
        requirements: '',
      },
      f.vault.automation(),
    )[0];
    gen.siteUrl = site.url;
    gen.generation = { prepared: true, deliveryId: randomUUID(), deliveryState: 'completed' };
    gen.stage = 'handoff';
    gen.status = 'completed';
    gen.stopped = true;
    gen.delivery = {
      id: randomUUID(),
      policy: { enabled: true, endpoint: 'https://migrate.test', auto: true, requirePassed: true, verifyWithAi: false, timeoutSeconds: 180 },
      status: 'completed',
      sourceEnvironmentId: f.environmentId,
      sourceSiteId: site.siteId,
      sourceUrl: site.url,
      evaluationTaskId: '',
      target: { siteId: randomUUID(), siteUrl: 'https://delivered-direct.test/' },
      updatedAt: Date.now(),
      error: '',
      checks: [{ url: 'https://delivered-direct.test/', status: 200, ok: true, detail: 'ok' }],
      verifiedAt: Date.now(),
    };
    f.automationStore.put(gen);

    const { body } = await f.fetchWorkflow(gen.id);
    assert.deepEqual(
      body.nodes.filter((n) => n.lane === 'main').map((n) => n.id),
      ['prepare', 'generation', 'delivery'],
    );
    assert.deepEqual(
      body.edges.map((e) => `${e.from}->${e.to}`),
      ['prepare->generation', 'generation->delivery'],
    );
    assert.equal(body.nodes.find((n) => n.id === 'evaluation'), undefined);
    assert.equal(body.nodes.find((n) => n.id === 'quality-gate'), undefined);
    assert.equal(body.nodes.find((n) => n.id === 'optimization'), undefined);
    assert.equal(body.nodes.find((n) => n.id === 'learning'), undefined);
    const prepNode = body.nodes.find((n) => n.id === 'prepare');
    assert.ok(prepNode?.checks?.some((c) => c.id === 'prepare-manifest' && c.label === '锁定交付清单与上下文'));
    const genNode = body.nodes.find((n) => n.id === 'generation');
    assert.equal(genNode?.subtitle, '已生成站点并交接交付');
    assert.ok(genNode?.checks?.some((c) => c.id === 'site-ready' && c.label === '刷新站点地址并交接交付'));
    const delNode = body.nodes.find((n) => n.id === 'delivery');
    assert.equal(delNode?.status, 'completed');
    assert.match(delNode?.summary || '', /已关闭 AI 视觉核验/);
    assert.ok(delNode?.checks?.some((c) => c.label.includes('HTTP 可达性检查（已关闭 AI 视觉核验）')));
    assert.match(body.headline, /站点生成与跨环境交付已全部完成/);
    assert.doesNotMatch(body.headline, /独立评测/);
  } finally {
    await f.close();
  }
});

test('generate-only task without evaluation/delivery/learning shows compact 2-node graph and omits learning copy', async () => {
  const f = await fixture({ deliveryEnabled: false });
  try {
    f.vault.updateAutomation({
      ...defaultAutomationSettings,
      enabled: true,
      autoEvaluate: false,
      learning: { ...defaultAutomationSettings.learning!, collect: false, use: false },
    });
    const res = await f.saveResource();
    const version = f.automationStore.versions(res.id)[0];
    const site = {
      id: randomUUID(),
      resourceId: res.id,
      versionId: version.id,
      environmentId: f.environmentId,
      siteId: randomUUID(),
      name: 'GenOnlySite',
      url: 'https://gen-only.test/',
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(site);

    const gen = f.automationStore.create(
      {
        resourceIds: [res.id],
        kind: 'generation',
        scope: 'homepage',
        environmentId: f.environmentId,
        generatedSiteId: site.id,
        autoEvaluate: false,
        requirements: '',
      },
      f.vault.automation(),
    )[0];
    gen.siteUrl = site.url;
    gen.generation = { prepared: true, deliveryId: randomUUID(), deliveryState: 'completed' };
    gen.stage = 'handoff';
    gen.status = 'completed';
    gen.stopped = true;
    f.automationStore.put(gen);

    const { body } = await f.fetchWorkflow(gen.id);
    assert.equal(body.overallStatus, 'completed');
    assert.equal(body.overallLabel, '全流程完成');
    assert.equal(body.blocker, null);
    assert.deepEqual(
      body.nodes.map((n) => n.id),
      ['prepare', 'generation'],
    );
    assert.deepEqual(
      body.edges.map((e) => `${e.from}->${e.to}`),
      ['prepare->generation'],
    );
    assert.ok(!body.edges.some((e) => ['fail', 'loop', 'pass'].includes(e.kind)));
    const prepNode = body.nodes.find((n) => n.id === 'prepare');
    assert.ok(prepNode?.checks?.some((c) => c.id === 'prepare-manifest' && c.label === '锁定交付清单与上下文'));
    const genNode = body.nodes.find((n) => n.id === 'generation');
    assert.equal(genNode?.subtitle, '已生成可访问站点');
    assert.ok(genNode?.checks?.some((c) => c.id === 'site-ready' && c.label === '刷新站点可访问地址'));
    assert.match(body.headline, /站点已生成完成，可直接访问使用/);
  } finally {
    await f.close();
  }
});

test('generate-only task omits learning even when global learning.collect is true until manual evaluation appears', async () => {
  const f = await fixture();
  try {
    f.vault.updateAutomation({
      ...defaultAutomationSettings,
      enabled: true,
      autoEvaluate: false,
      learning: { ...defaultAutomationSettings.learning!, collect: true, use: false },
    });
    const res = await f.saveResource();
    const version = f.automationStore.versions(res.id)[0];
    const site = {
      id: randomUUID(),
      resourceId: res.id,
      versionId: version.id,
      environmentId: f.environmentId,
      siteId: randomUUID(),
      name: 'CollectToggleSite',
      url: 'https://collect-toggle.test/',
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(site);

    const gen = f.automationStore.create(
      {
        resourceIds: [res.id],
        kind: 'generation',
        scope: 'homepage',
        environmentId: f.environmentId,
        generatedSiteId: site.id,
        autoEvaluate: false,
        requirements: '',
      },
      f.vault.automation(),
    )[0];
    gen.siteUrl = site.url;
    gen.generation = { prepared: true, deliveryId: randomUUID(), deliveryState: 'completed' };
    gen.stage = 'handoff';
    gen.status = 'completed';
    gen.stopped = true;
    f.automationStore.beginSiteChange(gen);

    const beforeEval = await f.fetchWorkflow(gen.id);
    assert.deepEqual(beforeEval.body.nodes.map((n) => n.id), ['prepare', 'generation']);
    assert.equal(beforeEval.body.nodes.find((n) => n.id === 'learning'), undefined);

    const manualEval = f.automationStore.create(
      {
        resourceIds: [res.id],
        kind: 'evaluation',
        scope: 'homepage',
        environmentId: f.environmentId,
        generatedSiteId: site.id,
        requirements: '手动发起评测',
        parentId: gen.id,
        ruleSnapshot: sampleRule,
      },
      f.vault.automation(),
    )[0];
    manualEval.status = 'completed';
    manualEval.stopped = true;
    manualEval.siteRevision = gen.siteRevision;
    manualEval.report = makeReport('passed', 90, 88);
    f.automationStore.put(manualEval);
    f.automationStore.publishSiteReport(manualEval);

    const afterEval = await f.fetchWorkflow(gen.id);
    assert.deepEqual(
      afterEval.body.nodes.filter((n) => n.lane === 'main').map((n) => n.id),
      ['prepare', 'generation', 'evaluation'],
    );
    assert.ok(afterEval.body.nodes.some((n) => n.id === 'learning'));
  } finally {
    await f.close();
  }
});

test('generation + evaluation without optimization shows pass edge to delivery and marks delivery skipped when evaluation fails', async () => {
  const f = await fixture({ deliveryEnabled: true });
  try {
    const res = await f.saveResource();
    const version = f.automationStore.versions(res.id)[0];
    const site = {
      id: randomUUID(),
      resourceId: res.id,
      versionId: version.id,
      environmentId: f.environmentId,
      siteId: randomUUID(),
      name: 'EvalDeliverySite',
      url: 'https://eval-delivery.test/',
      createdAt: Date.now(),
    };
    f.automationStore.saveSite(site);

    const gen = f.automationStore.create(
      {
        resourceIds: [res.id],
        kind: 'generation',
        scope: 'homepage',
        environmentId: f.environmentId,
        generatedSiteId: site.id,
        autoEvaluate: true,
        autoDelivery: true,
        requirements: '',
        ruleSnapshot: sampleRule,
      },
      f.vault.automation(),
    )[0];
    gen.siteUrl = site.url;
    gen.generation = { prepared: true, deliveryId: randomUUID(), deliveryState: 'completed' };
    gen.stage = 'handoff';
    gen.status = 'completed';
    gen.stopped = true;
    f.automationStore.put(gen);

    const evalTask = f.automationStore.create(
      {
        resourceIds: [res.id],
        kind: 'evaluation',
        scope: 'homepage',
        environmentId: f.environmentId,
        generatedSiteId: site.id,
        requirements: '',
        parentId: gen.id,
        ruleSnapshot: sampleRule,
      },
      f.vault.automation(),
    )[0];
    evalTask.status = 'completed';
    evalTask.stopped = true;
    evalTask.report = makeReport('failed', 90, 72);
    f.automationStore.put(evalTask);
    gen.evaluationTaskId = evalTask.id;
    f.automationStore.put(gen);

    const { body } = await f.fetchWorkflow(gen.id);
    assert.deepEqual(
      body.nodes.filter((n) => n.lane === 'main').map((n) => n.id),
      ['prepare', 'generation', 'evaluation', 'delivery'],
    );
    assert.equal(body.nodes.find((n) => n.id === 'quality-gate'), undefined);
    assert.equal(body.nodes.find((n) => n.id === 'optimization'), undefined);
    const evalToDel = body.edges.find((e) => e.from === 'evaluation' && e.to === 'delivery');
    assert.ok(evalToDel);
    assert.equal(evalToDel.kind, 'pass');
    assert.equal(evalToDel.label, '评测通过');
    const delNode = body.nodes.find((n) => n.id === 'delivery');
    assert.equal(delNode?.status, 'skipped');
    assert.equal(delNode?.subtitle, '评测未通过，未自动交付');
  } finally {
    await f.close();
  }
});
