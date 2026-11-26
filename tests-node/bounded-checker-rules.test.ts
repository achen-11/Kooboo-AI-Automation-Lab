import test from 'node:test';
import assert from 'node:assert/strict';
import type { Assessment, Criterion } from '../shared/automation.js';
import {
  applyBoundedVerdictCaps,
  areCrossViewportMinorDuplicates,
  buildBoundedCheckerPrompt,
  classifyUnverifiedLeaks,
  deduplicateBatchTexts,
  defaultOutOfScope,
  filterContradictoryHighlights,
  filterCrossBatchOutOfScopeLeaks,
  filterCrossSliceCoverageLeaks,
  pickStrictestHeadline,
} from '../server/automation/bounded-checker-rules.js';

const homepageCriteria: Criterion[] = [
  {
    id: 'hero',
    label: '首屏与主视觉',
    weight: 40,
    instruction: '首屏构图、视觉主体、文字和 CTA 层级。',
    required: false,
    viewports: ['desktop', 'mobile'],
    scopes: ['homepage', 'site'],
  },
  {
    id: 'structure',
    label: '页面结构与适配',
    weight: 40,
    instruction: '区段组成、顺序、节奏与双端适配。',
    required: false,
    viewports: ['desktop', 'mobile'],
    scopes: ['homepage', 'site'],
  },
  {
    id: 'sections',
    label: '内容区段与交互',
    weight: 20,
    instruction: '区段卡片、图文内容与交互表现。',
    required: false,
    viewports: ['desktop', 'mobile'],
    scopes: ['homepage', 'site'],
  },
];

test('R-VISUAL-01 host cap clamps inflated 星禾空间 scores and flips ready verdict to needs-fixes', () => {
  const assessments: Assessment[] = [
    { criterionId: 'hero', viewport: 'desktop', score: 96, reason: 'looks dark and sleek', evidence: ['d1.png'], passed: true },
    { criterionId: 'structure', viewport: 'desktop', score: 93, reason: 'good flow', evidence: ['d2.png'], passed: true },
    { criterionId: 'sections', viewport: 'desktop', score: 85, reason: 'minor title wrap', evidence: ['d3.png'], passed: true },
    { criterionId: 'hero', viewport: 'mobile', score: 95, reason: 'mobile clean', evidence: ['m1.png'], passed: true },
    { criterionId: 'structure', viewport: 'mobile', score: 94, reason: 'mobile stack', evidence: ['m2.png'], passed: true },
    { criterionId: 'sections', viewport: 'mobile', score: 94, reason: 'mobile sections', evidence: ['m3.png'], passed: true },
  ];

  const verdict = applyBoundedVerdictCaps({
    assessments,
    criteria: homepageCriteria,
    threshold: 80,
    issues: [
      {
        severity: 'major',
        ruleId: 'R-VISUAL-01',
        viewport: 'desktop',
        criterionId: 'hero',
        title: 'Hero 主视觉使用廉价几何 SVG 充数',
        detail: '建筑灯光设计工作室首屏右侧使用纯几何线条与渐变光锥 SVG，缺少真实摄影图片或 imagePlaceholder。',
        evidence: ['d1.png'],
      },
    ],
    coverage: {
      verified: ['双端首屏与全页结构'],
      unverified: [],
      outOfScope: [],
    },
    presetOutOfScope: defaultOutOfScope({
      scenario: 'materials',
      scope: 'homepage',
      hasReference: false,
      hasMaterials: false,
      hasBackendAccess: false,
    }),
    humanSummary: {
      verdict: 'ready',
      headline: '首页内容完整且视觉统一',
      highlights: ['深色风格统一'],
      topFixes: [],
    },
  });

  // Raw scores preserved for auditability (92.6 / 94.4)
  assert.equal(verdict.rawScores.find(s => s.viewport === 'desktop')?.value, 92.6);
  assert.equal(verdict.rawScores.find(s => s.viewport === 'mobile')?.value, 94.4);

  // Host cap forces hero(desktop) <= 70 and desktop viewport <= 75
  const cappedHero = verdict.assessments.find(a => a.criterionId === 'hero' && a.viewport === 'desktop')!;
  assert.ok(cappedHero.score !== null && cappedHero.score <= 70);
  assert.equal(cappedHero.passed, false);

  const cappedDesktop = verdict.scores.find(s => s.viewport === 'desktop')!;
  assert.ok(cappedDesktop.value !== null && cappedDesktop.value <= 75);

  assert.equal(verdict.quality, 'failed');
  assert.equal(verdict.humanSummary?.verdict, 'needs-fixes');
  assert.ok(verdict.capNotes.length >= 2);
});

test('critical issue caps affected viewports at <= 55 and generic major caps criterion <= 72 / viewport <= 78', () => {
  const baseAssessments: Assessment[] = [
    { criterionId: 'hero', viewport: 'desktop', score: 90, reason: 'ok', evidence: ['d1.png'], passed: true },
    { criterionId: 'structure', viewport: 'desktop', score: 92, reason: 'ok', evidence: ['d1.png'], passed: true },
    { criterionId: 'sections', viewport: 'desktop', score: 88, reason: 'ok', evidence: ['d1.png'], passed: true },
    { criterionId: 'hero', viewport: 'mobile', score: 91, reason: 'ok', evidence: ['m1.png'], passed: true },
    { criterionId: 'structure', viewport: 'mobile', score: 90, reason: 'ok', evidence: ['m1.png'], passed: true },
    { criterionId: 'sections', viewport: 'mobile', score: 89, reason: 'ok', evidence: ['m1.png'], passed: true },
  ];

  const criticalVerdict = applyBoundedVerdictCaps({
    assessments: baseAssessments,
    criteria: homepageCriteria,
    threshold: 80,
    issues: [
      {
        severity: 'critical',
        viewport: 'both',
        criterionId: 'hero',
        title: '首屏主按钮完全不可见且背景白屏',
        detail: '首屏核心区域未渲染',
        evidence: ['d1.png', 'm1.png'],
      },
    ],
    coverage: { verified: [], unverified: [], outOfScope: [] },
  });

  assert.equal(criticalVerdict.quality, 'failed');
  assert.ok((criticalVerdict.scores.find(s => s.viewport === 'desktop')?.value ?? 100) <= 55);
  assert.ok((criticalVerdict.scores.find(s => s.viewport === 'mobile')?.value ?? 100) <= 55);
  assert.equal(criticalVerdict.assessments.find(a => a.criterionId === 'hero' && a.viewport === 'desktop')?.passed, false);

  const majorVerdict = applyBoundedVerdictCaps({
    assessments: baseAssessments,
    criteria: homepageCriteria,
    threshold: 80,
    issues: [
      {
        severity: 'major',
        ruleId: null,
        viewport: 'mobile',
        criterionId: 'structure',
        title: '移动端内容区块留白比例明显失衡',
        detail: '卡片间距过密且底部文字拥挤',
        evidence: ['m1.png'],
      },
    ],
    coverage: { verified: [], unverified: [], outOfScope: [] },
  });

  assert.equal(majorVerdict.quality, 'failed');
  assert.ok((majorVerdict.assessments.find(a => a.criterionId === 'structure' && a.viewport === 'mobile')?.score ?? 100) <= 72);
  assert.ok((majorVerdict.scores.find(s => s.viewport === 'mobile')?.value ?? 100) <= 78);
  // Desktop had no issue, remains uncapped
  assert.equal(majorVerdict.scores.find(s => s.viewport === 'desktop')?.value, 90.4);

  const layoutVerdict = applyBoundedVerdictCaps({
    assessments: baseAssessments,
    criteria: homepageCriteria,
    threshold: 80,
    issues: [
      {
        severity: 'major',
        ruleId: 'R-LAYOUT-03',
        viewport: 'mobile',
        criterionId: 'structure',
        title: '移动端存在横向溢出',
        detail: 'scrollWidth > viewportWidth',
        evidence: ['m1.png'],
      },
    ],
    coverage: { verified: [], unverified: [], outOfScope: [] },
  });

  assert.equal(layoutVerdict.quality, 'failed');
  assert.ok((layoutVerdict.scores.find(s => s.viewport === 'mobile')?.value ?? 100) <= 75);
});

test('boilerplate preview disclaimers move from unverified to outOfScope so clean sites can pass', () => {
  const preset = defaultOutOfScope({
    scenario: 'materials',
    scope: 'homepage',
    hasReference: false,
    hasMaterials: false,
    hasBackendAccess: false,
  });

  const cleanAssessments: Assessment[] = [
    { criterionId: 'hero', viewport: 'desktop', score: 91, reason: 'ok', evidence: ['d1.png'], passed: true },
    { criterionId: 'structure', viewport: 'desktop', score: 90, reason: 'ok', evidence: ['d1.png'], passed: true },
    { criterionId: 'sections', viewport: 'desktop', score: 89, reason: 'ok', evidence: ['d1.png'], passed: true },
    { criterionId: 'hero', viewport: 'mobile', score: 90, reason: 'ok', evidence: ['m1.png'], passed: true },
    { criterionId: 'structure', viewport: 'mobile', score: 90, reason: 'ok', evidence: ['m1.png'], passed: true },
    { criterionId: 'sections', viewport: 'mobile', score: 88, reason: 'ok', evidence: ['m1.png'], passed: true },
  ];

  const verdict = applyBoundedVerdictCaps({
    assessments: cleanAssessments,
    criteria: homepageCriteria,
    threshold: 80,
    issues: [],
    coverage: {
      verified: ['首页双端完整视觉与锚点交互'],
      unverified: [
        '正式域名上线、搜索引擎收录与未来权重未核验',
        '键盘完整焦点顺序、hover／focus 细节和减少动态效果偏好的表现未逐项完整验收',
        '资料包清单为空，缺少原始图片、字体资产或参考站，无法核对媒体素材来源及视觉逐项映射',
      ],
      outOfScope: [],
    },
    presetOutOfScope: preset,
    humanSummary: {
      verdict: 'ready',
      headline: '首页达标可交付',
      highlights: ['视觉完整'],
      topFixes: [],
    },
  });

  assert.deepEqual(verdict.coverage.unverified, []);
  assert.ok(verdict.coverage.outOfScope.some(item => item.includes('正式域名上线')));
  assert.ok(verdict.coverage.outOfScope.some(item => item.includes('键盘完整焦点顺序')));
  assert.equal(verdict.quality, 'passed');
  assert.equal(verdict.humanSummary?.verdict, 'ready');
});

test('genuine in-scope capture gap stays in unverified and blocks passed status', () => {
  const preset = defaultOutOfScope({
    scenario: 'upgrade',
    scope: 'homepage',
    hasReference: true,
    hasMaterials: true,
    hasBackendAccess: false,
  });

  const classified = classifyUnverifiedLeaks(
    [
      '移动端页脚截图缺失，无法确认是否裁切',
      '正式域名上线、搜索引擎收录与未来权重未核验',
    ],
    preset,
  );

  assert.deepEqual(classified.keptUnverified, ['移动端页脚截图缺失，无法确认是否裁切']);
  assert.deepEqual(classified.movedToOutOfScope, ['正式域名上线、搜索引擎收录与未来权重未核验']);

  const verdict = applyBoundedVerdictCaps({
    assessments: [
      { criterionId: 'hero', viewport: 'desktop', score: 92, reason: 'ok', evidence: ['d1.png'], passed: true },
      { criterionId: 'hero', viewport: 'mobile', score: 90, reason: 'ok', evidence: ['m1.png'], passed: true },
    ],
    criteria: homepageCriteria,
    threshold: 80,
    issues: [],
    coverage: {
      verified: ['首屏检查'],
      unverified: ['移动端页脚截图缺失，无法确认是否裁切'],
      outOfScope: [],
    },
    presetOutOfScope: preset,
    humanSummary: {
      verdict: 'ready',
      headline: '看起来不错',
      highlights: ['ok'],
      topFixes: [],
    },
  });

  assert.equal(verdict.quality, 'unverified');
  assert.equal(verdict.humanSummary?.verdict, 'incomplete-check');
  assert.deepEqual(verdict.coverage.unverified, ['移动端页脚截图缺失，无法确认是否裁切']);
});

test('buildBoundedCheckerPrompt includes imagePlaceholder, R-VISUAL-01, 4 exemptions, score bands and preset outOfScope', () => {
  const preset = defaultOutOfScope({
    scenario: 'materials',
    scope: 'homepage',
    hasReference: false,
    hasMaterials: false,
  });

  const prompt = buildBoundedCheckerPrompt({
    scenario: 'materials',
    scope: 'homepage',
    siteUrl: 'https://example.test/',
    description: '建筑灯光设计工作室单页官网',
    criteria: homepageCriteria,
    presetOutOfScope: preset,
    precheckDigest: '### desktop 预检事实\n- ⚠️ [HERO_SVG_PLACEHOLDER / R-VISUAL-01] 检测到大型 SVG',
    imageManifestLines: ['hero-desktop.png (role=target, viewport=desktop, 1440×1000)'],
    hasReference: false,
    viewports: ['desktop'],
    materialNotes: '附件：brief.md（核心卖点说明）',
  });

  assert.match(prompt, /imagePlaceholder/);
  assert.match(prompt, /R-VISUAL-01/);
  assert.match(prompt, /工具型 SaaS 界面示意/);
  assert.match(prompt, /技术架构图/);
  assert.match(prompt, /数据可视化图表/);
  assert.match(prompt, /品牌 Logo 与小尺寸 UI 功能图标/);
  assert.match(prompt, /90–100/);
  assert.match(prompt, /75–84/);
  assert.match(prompt, /60–74/);
  assert.match(prompt, /正式域名上线/);
  assert.match(prompt, /hero-desktop\.png/);
  assert.match(prompt, /必须严格使用简体中文输出/);
  assert.match(prompt, /视口 \[desktop\]/);
  assert.doesNotMatch(prompt, /视口 \[desktop, mobile\]/);
  assert.match(prompt, /brief\.md/);

  // English outOfScope duplicates are stripped when canonical Chinese presetOutOfScope is present.
  const dedupVerdict = applyBoundedVerdictCaps({
    assessments: [
      { criterionId: 'hero', viewport: 'desktop', score: 91, reason: '真实图片', evidence: ['d1.png'], passed: true },
    ],
    criteria: homepageCriteria,
    threshold: 80,
    issues: [],
    coverage: {
      verified: ['桌面首屏'],
      unverified: [],
      outOfScope: ['Production domain launch, DNS, search indexing and live rankings in the preview environment'],
    },
    presetOutOfScope: preset,
  });
  assert.equal(
    dedupVerdict.coverage.outOfScope.some(line => line.startsWith('Production domain launch')),
    false,
  );
});

test('outOfScope deduplicates whitespace variants and preset paraphrases while keeping new custom outOfScope items', () => {
  const preset = defaultOutOfScope({
    scenario: 'materials',
    scope: 'homepage',
    hasReference: false,
    hasMaterials: false,
    hasBackendAccess: false,
  });

  const verdict = applyBoundedVerdictCaps({
    assessments: [
      { criterionId: 'hero', viewport: 'desktop', score: 91, reason: 'ok', evidence: ['d1.png'], passed: true },
      { criterionId: 'hero', viewport: 'mobile', score: 90, reason: 'ok', evidence: ['m1.png'], passed: true },
    ],
    criteria: homepageCriteria,
    threshold: 80,
    issues: [],
    coverage: {
      verified: ['双端首页'],
      unverified: [],
      outOfScope: [
        '正式域名上线、DNS解析、搜索引擎收录与线上排名权重；当前为预览环境',
        '后台内容管理、商务与数据库动态数据模型及站点源码内部实现审计（本次仅基于前台公开渲染页面验收）',
        '真实在线支付回调与 SMS 短信发送（本次仅静态预约展示）',
      ],
    },
    presetOutOfScope: preset,
  });

  const dnsItems = verdict.coverage.outOfScope.filter(item => item.includes('正式域名上线'));
  assert.equal(dnsItems.length, 1);
  assert.equal(dnsItems[0].includes('DNS 解析'), true);

  const backendItems = verdict.coverage.outOfScope.filter(
    item => item.includes('动态数据模型') || item.includes('CMS/Commerce/Sqlite'),
  );
  assert.equal(backendItems.length, 1);
  assert.equal(backendItems[0].includes('CMS/Commerce/Sqlite'), true);

  assert.equal(
    verdict.coverage.outOfScope.includes('真实在线支付回调与 SMS 短信发送（本次仅静态预约展示）'),
    true,
  );
  assert.equal(verdict.quality, 'passed');
});

test('Phase 1.2 cross-batch helpers strip viewport leaks, filter contradictory highlights, and merge cross-viewport Minor duplicates', () => {
  const cleanedOutOfScope = filterCrossBatchOutOfScopeLeaks(
    [
      '桌面端视口的布局与交互验收（本轮仅提供移动端证据）',
      '真实在线支付网关回调',
    ],
    new Set(['desktop', 'mobile']),
  );
  assert.deepEqual(cleanedOutOfScope, ['真实在线支付网关回调']);

  // Single-viewport run preserves single-viewport notice
  assert.equal(
    filterCrossBatchOutOfScopeLeaks(
      ['桌面端视口的布局与交互验收（本轮仅提供移动端证据）'],
      new Set(['mobile']),
    ).length,
    1,
  );

  const highlightsInput = [
    '首屏采用真实高质量手冲摄影，品牌层级清楚。',
    '已发现的瑕疵仅为半透明固定导航叠影和英文日期占位符，均不阻断使用。',
  ];
  assert.deepEqual(
    filterContradictoryHighlights(highlightsInput, 'failed', 'needs-fixes'),
    ['首屏采用真实高质量手冲摄影，品牌层级清楚。'],
  );
  assert.equal(filterContradictoryHighlights(highlightsInput, 'passed', 'ready').length, 2);

  // Exact real-world cross-viewport Minor pairs from 33a45716 should merge cleanly
  assert.equal(
    areCrossViewportMinorDuplicates(
      {
        severity: 'minor',
        ruleId: null,
        viewport: 'desktop',
        criterionId: 'structure',
        title: '半透明固定导航在滚动时透出底层文字，形成轻微叠影',
        detail: '门店与预约区段滚动到视口顶部时，导航栏后方文字仍可辨认，建议提高导航底色不透明度。',
        evidence: ['d1.png'],
      },
      {
        severity: 'minor',
        ruleId: null,
        viewport: 'mobile',
        criterionId: 'sections',
        title: '固定页头半透明造成滚动内容透出叠字',
        detail: '滚动到预约表单和页脚时，页头下方内容会透过半透明页头叠加，建议提高背景不透明度。',
        evidence: ['m1.png'],
      },
    ),
    true,
  );

  assert.equal(
    areCrossViewportMinorDuplicates(
      {
        severity: 'minor',
        ruleId: null,
        viewport: 'desktop',
        criterionId: 'sections',
        title: '预约表单日期字段使用英文日期占位格式',
        detail: '到店日期输入框显示“mm/dd/yyyy”英文日期占位符，与中文语境不一致。',
        evidence: ['d2.png'],
      },
      {
        severity: 'minor',
        ruleId: null,
        viewport: 'mobile',
        criterionId: 'sections',
        title: '预约日期占位符与中文界面不一致',
        detail: '日期字段直接显示“mm/dd/yyyy”英文格式占位，建议改为中文日期提示。',
        evidence: ['m2.png'],
      },
    ),
    true,
  );

  // Must NOT merge unrelated mobile minor or same-viewport minors
  assert.equal(
    areCrossViewportMinorDuplicates(
      {
        severity: 'minor',
        ruleId: null,
        viewport: 'desktop',
        criterionId: 'sections',
        title: '预约表单日期字段使用英文日期占位格式',
        detail: '显示“mm/dd/yyyy”英文格式占位。',
        evidence: ['d2.png'],
      },
      {
        severity: 'minor',
        ruleId: null,
        viewport: 'mobile',
        criterionId: 'hero',
        title: '首屏底部信息留下孤字换行',
        detail: '第二行仅剩“豆子”形成孤字。',
        evidence: ['m0.png'],
      },
    ),
    false,
  );
  assert.equal(
    areCrossViewportMinorDuplicates(
      {
        severity: 'minor',
        ruleId: null,
        viewport: 'mobile',
        criterionId: 'sections',
        title: '固定页头半透明造成滚动内容透出叠字',
        detail: '滚动内容叠加。',
        evidence: ['m1.png'],
      },
      {
        severity: 'minor',
        ruleId: null,
        viewport: 'mobile',
        criterionId: 'sections',
        title: '半透明固定导航在滚动时透出底层文字',
        detail: '滚动内容叠加。',
        evidence: ['m2.png'],
      },
    ),
    false,
  );

  const mergedTexts = deduplicateBatchTexts(
    ['提高固定导航底色不透明度', '提高固定页头背景不透明度', '增加菜单关闭按钮'],
    6,
  );
  assert.equal(mergedTexts.length >= 2 && mergedTexts.length <= 3, true);
  assert.equal(
    pickStrictestHeadline([
      { verdict: 'ready', headline: '桌面通过', highlights: [], topFixes: [] },
      { verdict: 'needs-fixes', headline: '移动端菜单无法退出', highlights: [], topFixes: [] },
    ]),
    '移动端菜单无法退出',
  );

  const parallelPrompt = buildBoundedCheckerPrompt({
    scenario: 'materials',
    scope: 'homepage',
    description: '咖啡馆单页',
    criteria: homepageCriteria,
    presetOutOfScope: defaultOutOfScope({ scenario: 'materials', scope: 'homepage', hasReference: false, hasMaterials: false }),
    imageManifestLines: ['m1.png'],
    hasReference: false,
    viewports: ['mobile'],
    siblingViewports: ['desktop'],
  });
  assert.match(parallelPrompt, /桌面端（desktop）.*由并行批次独立核验/);
  assert.match(parallelPrompt, /请控制内部思考简洁高效/);
  assert.match(parallelPrompt, /避免因思考过长耗尽输出额度/);

  // 72689a9a regressions: contradictory "未发现严重或主要缺陷" & static-demo booking form disclaimer
  assert.deepEqual(
    filterContradictoryHighlights(
      ['真实手冲摄影与暖白深褐配色统一', '未发现严重或主要缺陷'],
      'failed',
      'needs-fixes',
    ),
    ['真实手冲摄影与暖白深褐配色统一'],
  );

  const homepagePreset = defaultOutOfScope({
    scenario: 'materials',
    scope: 'homepage',
    hasReference: false,
    hasMaterials: false,
    hasBackendAccess: false,
  });
  const formClassified = classifyUnverifiedLeaks(
    [
      '预约表单的提交、校验与确认结果（页面已明确标注当前为静态展示）',
      '移动端关键交互（菜单点击）失败，无法验证菜单状态',
    ],
    homepagePreset,
  );
  assert.deepEqual(formClassified.keptUnverified, ['移动端关键交互（菜单点击）失败，无法验证菜单状态']);
  assert.deepEqual(formClassified.movedToOutOfScope, [
    '预约表单的提交、校验与确认结果（页面已明确标注当前为静态展示）',
  ]);
});

test('buildBoundedCheckerPrompt enforces target+reference citation only when role=reference is attached and filterCrossSliceCoverageLeaks preserves genuine gaps', () => {
  const preset = defaultOutOfScope({
    scenario: 'materials',
    scope: 'homepage',
    hasReference: true,
    hasMaterials: true,
  });

  const withRefPrompt = buildBoundedCheckerPrompt({
    scenario: 'materials',
    scope: 'homepage',
    siteUrl: 'https://ovo.example.test/',
    description: 'OVO 阀门工业独立站',
    criteria: homepageCriteria,
    presetOutOfScope: preset,
    imageManifestLines: [
      't-hero.png (role=target, viewport=mobile, 390x844, action=take_page_screenshots, scrollY=0)',
      'r-hero.png (role=reference, viewport=mobile, 390x844, action=take_page_screenshots, scrollY=0)',
    ],
    hasReference: true,
    viewports: ['mobile'],
  });

  assert.match(withRefPrompt, /目标站（target）截图：/);
  assert.match(withRefPrompt, /参考\/源站（reference）截图：/);
  assert.match(withRefPrompt, /必须同时引用至少 1 张同视口 target 文件名和至少 1 张同视口 reference 文件名/);

  // Pure text business batch with hasReference=true must not inject role=reference screenshot mandate
  const businessPrompt = buildBoundedCheckerPrompt({
    scenario: 'materials',
    scope: 'site',
    siteUrl: 'https://ovo.example.test/',
    description: '全站业务批次',
    criteria: [
      {
        id: 'seo',
        label: 'SEO',
        weight: 100,
        instruction: '检查 SEO 与后台结构',
        required: false,
        viewports: ['business'],
        scopes: ['site'],
      },
    ],
    presetOutOfScope: preset,
    imageManifestLines: ['implementation-pages.json', 't-hero.png'],
    hasReference: true,
  });
  assert.doesNotMatch(businessPrompt, /参考站证据硬性要求/);

  const filtered = filterCrossSliceCoverageLeaks(
    [
      '本段仅覆盖下段区段，未包含首屏与顶部内容',
      '首屏 Hero 由并行分段核验',
      '移动端页脚截图缺失，无法确认是否裁切',
      '预约表单提交未验证',
    ],
    true,
  );
  assert.deepEqual(filtered, ['移动端页脚截图缺失，无法确认是否裁切', '预约表单提交未验证']);
});

test('homepage preset outOfScope moves static-screenshot accordion/hover/link-target notes out of unverified while keeping real failures', () => {
  const preset = defaultOutOfScope({
    scenario: 'materials',
    scope: 'homepage',
    hasReference: true,
    hasMaterials: true,
    hasBackendAccess: false,
  });

  const classified = classifyUnverifiedLeaks(
    [
      '常见问题手风琴的展开态、关闭态及展开动效未提供截图，未能核验',
      '产品卡片和行业卡片的悬停状态、主行动按钮点击后的目标页未提供截图，无法核验交互反馈',
      '本批分段未呈现轮播、手风琴或滚动动效的运行状态',
      '静态截图无法确认导航、页脚隐私与条款链接以及常见问题折叠项的点击跳转是否有效',
      '合作流程第 02–05 步的展开与收起结果及过渡动效，当前仅有第 01 步展开的静态画面',
      '移动端关键交互（菜单点击）失败，无法验证菜单状态',
      '移动端页脚截图缺失，无法确认是否裁切',
    ],
    preset,
  );

  assert.deepEqual(classified.keptUnverified, [
    '移动端关键交互（菜单点击）失败，无法验证菜单状态',
    '移动端页脚截图缺失，无法确认是否裁切',
  ]);
  assert.equal(classified.movedToOutOfScope.length, 5);

  // When a 0-Major homepage only has static accordion/hover caveats, verdict resolves to passed/ready
  const verdict = applyBoundedVerdictCaps({
    assessments: [
      { criterionId: 'hero', viewport: 'desktop', score: 90, reason: 'ok', evidence: ['d1.png'], passed: true },
      { criterionId: 'structure', viewport: 'desktop', score: 88, reason: 'ok', evidence: ['d1.png'], passed: true },
      { criterionId: 'sections', viewport: 'desktop', score: 86, reason: 'ok', evidence: ['d1.png'], passed: true },
      { criterionId: 'hero', viewport: 'mobile', score: 89, reason: 'ok', evidence: ['m1.png'], passed: true },
      { criterionId: 'structure', viewport: 'mobile', score: 86, reason: 'ok', evidence: ['m1.png'], passed: true },
      { criterionId: 'sections', viewport: 'mobile', score: 85, reason: 'ok', evidence: ['m1.png'], passed: true },
    ],
    criteria: homepageCriteria,
    threshold: 80,
    issues: [],
    coverage: {
      verified: ['双端视觉与内容检查'],
      unverified: [
        '常见问题手风琴的展开态、关闭态及展开动效未提供截图，未能核验',
        '静态截图无法确认导航、页脚隐私与条款链接以及常见问题折叠项的点击跳转是否有效',
      ],
      outOfScope: [],
    },
    presetOutOfScope: preset,
    humanSummary: {
      verdict: 'ready',
      headline: '双端达标可交付',
      highlights: ['内容与视觉一致'],
      topFixes: [],
    },
  });

  assert.equal(verdict.quality, 'passed');
  assert.equal(verdict.humanSummary?.verdict, 'ready');
  assert.deepEqual(verdict.coverage.unverified, []);
});

test('buildBoundedCheckerPrompt emits Option A brand-palette rule for upgrade with reference and omits it for site-template', () => {
  const preset = defaultOutOfScope({
    scenario: 'upgrade',
    scope: 'homepage',
    hasReference: true,
    hasMaterials: true,
    hasBackendAccess: false,
  });
  const upgradePrompt = buildBoundedCheckerPrompt({
    scenario: 'upgrade',
    scope: 'homepage',
    siteUrl: 'https://target.test/',
    description: 'Classic auto workshop upgrade',
    criteria: homepageCriteria,
    presetOutOfScope: preset,
    imageManifestLines: ['t.png (role=target)', 'r.png (role=reference)'],
    hasReference: true,
  });
  assert.match(upgradePrompt, /升级场景配色口径（重要）/);
  assert.match(upgradePrompt, /品牌主色、强调色与 Logo 优先承接原内容站与商家行业气质/);
  assert.match(upgradePrompt, /R-TRUST-01/);

  const templatePrompt = buildBoundedCheckerPrompt({
    scenario: 'site-template',
    scope: 'homepage',
    siteUrl: 'https://tpl.test/',
    description: 'Template generation',
    criteria: homepageCriteria,
    presetOutOfScope: preset,
    imageManifestLines: ['t.png (role=target)', 'r.png (role=reference)'],
    hasReference: true,
  });
  assert.doesNotMatch(templatePrompt, /升级场景配色口径/);
});
