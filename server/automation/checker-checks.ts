import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../runtime.js';
import type { AutomationStore } from './store.js';
import { Conflict } from '../lib/store.js';
import {
  activeScenarios,
  type Assessment,
  type Criterion,
  type Scenario,
  type Scope,
} from '../../shared/automation.js';
import {
  CHECK_RULE_ID_PATTERN,
  type CheckerCalibrationCase,
  type CheckerCalibrationInput,
  type CheckerCheckRevision,
  type CheckerCheckRule,
  type CheckerCheckRuleInput,
  type CheckerChecksSnapshot,
  type ChecksRegressionAssertion,
  type ChecksRegressionCaseResult,
  type ChecksRegressionReport,
} from '../../shared/checker-checks.js';
import {
  applyBoundedVerdictCaps,
  buildBoundedCheckerPrompt,
  DEFAULT_ANTI_PATTERN_RULES,
  defaultOutOfScope,
  type AntiPatternRule,
  type BoundedIssue,
} from './bounded-checker-rules.js';

const ALL_ACTIVE_SCENARIOS = Object.keys(activeScenarios) as Scenario[];
const ALL_SCOPES: Scope[] = ['homepage', 'site'];

const BUILTIN_CALIBRATION_SEEDS: readonly Omit<CheckerCalibrationCase, 'createdAt'>[] = [
  {
    id: 'cal-r-visual-01-catch',
    ruleId: 'R-VISUAL-01',
    title: '星禾空间：Hero 使用纯几何光锥 SVG 替代实景图（应拦截）',
    kind: 'should-catch',
    scenario: 'materials',
    scope: 'homepage',
    source: 'builtin',
    notes: '来源于 2026-11-20 edc98e9c 反例：灯光设计工作室 Hero 右侧用抽象几何 SVG 充当主视觉，必须判定 Major 且 Hero<=70、视口<=75。',
    evidenceFiles: [],
    viewport: 'both',
    criterionId: 'hero',
    simulatedIssue: {
      severity: 'major',
      title: '首屏主视觉使用抽象几何 SVG 替代真实灯光项目摄影',
      detail: '[R-VISUAL-01] Hero 右侧使用纯几何半圆与渐变光锥 SVG 占位。',
      ruleId: 'R-VISUAL-01',
      viewport: 'both',
      criterionId: 'hero',
    },
    expected: {
      quality: 'failed',
      maxDesktopScore: 75,
      maxMobileScore: 75,
      requireRuleInPrompt: true,
      requireCapNote: true,
    },
  },
  {
    id: 'cal-r-visual-01-exempt',
    ruleId: 'R-VISUAL-01',
    title: '数据可视化仪表盘卡片含真实数据图表 SVG（豁免应放行）',
    kind: 'should-pass',
    scenario: 'materials',
    scope: 'homepage',
    source: 'builtin',
    notes: '校验 Prompt 保留「数据可视化图表」豁免条款，且无违规 issue 时宿主评分正常 passed。',
    evidenceFiles: [],
    viewport: 'desktop',
    criterionId: 'sections',
    expected: {
      quality: 'passed',
      minDesktopScore: 85,
      requireRuleInPrompt: true,
      expectedExemptionText: '数据可视化图表',
    },
  },
  {
    id: 'cal-r-visual-02-catch',
    ruleId: 'R-VISUAL-02',
    title: '到访/主图出现第三方外语招牌与门牌冲突（应拦截并封顶）',
    kind: 'should-catch',
    scenario: 'upgrade',
    scope: 'homepage',
    source: 'builtin',
    notes: '来源于云隅咖啡初评实测 f77959db：到访区主图出现无关 VERMILION 招牌与 28/A 门牌，核心展示主图触发 R-VISUAL-02 Major（维度<=72、视口<=78）。',
    evidenceFiles: [],
    viewport: 'desktop',
    criterionId: 'sections',
    simulatedIssue: {
      severity: 'major',
      title: '到访区主图出现无关第三方 VERMILION 招牌与门牌',
      detail: '[R-VISUAL-02] 中文咖啡馆愚园路地址配合了外语第三方门面招牌图。',
      ruleId: 'R-VISUAL-02',
      viewport: 'desktop',
      criterionId: 'sections',
    },
    expected: {
      quality: 'failed',
      maxDesktopScore: 78,
      requireRuleInPrompt: true,
      requireCapNote: true,
    },
  },
  {
    id: 'cal-r-layout-03-catch',
    ruleId: 'R-LAYOUT-03',
    title: '移动端菜单展开无关闭入口或横向溢出（应拦截并封顶）',
    kind: 'should-catch',
    scenario: 'materials',
    scope: 'homepage',
    source: 'builtin',
    notes: '来源于 f9579f55 MOBILE_MENU_TRAPPED 与 Playo 128：移动端导航缺少可见关闭入口，触发 R-LAYOUT-03（维度<=72、移动端<=75）。',
    evidenceFiles: [],
    viewport: 'mobile',
    criterionId: 'structure',
    simulatedIssue: {
      severity: 'major',
      title: '移动端全屏菜单展开后缺少可点击关闭按钮',
      detail: '[R-LAYOUT-03] 探针检测到汉堡开关被全屏遮罩覆盖且无关闭出口。',
      ruleId: 'R-LAYOUT-03',
      viewport: 'mobile',
      criterionId: 'structure',
    },
    expected: {
      quality: 'failed',
      maxMobileScore: 75,
      requireRuleInPrompt: true,
      requireCapNote: true,
    },
  },
  {
    id: 'cal-r-cover-04-catch',
    ruleId: 'R-COVER-04',
    title: '全站必需页面或核心交付项未核验禁给高分放行（应封顶拦截）',
    kind: 'should-catch',
    scenario: 'upgrade',
    scope: 'site',
    source: 'builtin',
    notes: '来源于 Stageo 歌剧院：全站必检项或内页未验证时，不得靠其余区段给出 >= 80 分 passed。',
    evidenceFiles: [],
    viewport: 'both',
    criterionId: 'structure',
    simulatedIssue: {
      severity: 'major',
      title: '全站存在核心交付项未验证',
      detail: '[R-COVER-04] 关键产品详情与导航页面缺少证据，禁止高分放行。',
      ruleId: 'R-COVER-04',
      viewport: 'both',
      criterionId: 'structure',
    },
    expected: {
      quality: 'failed',
      maxDesktopScore: 78,
      maxMobileScore: 78,
      requireRuleInPrompt: true,
      requireCapNote: true,
    },
  },
  {
    id: 'cal-r-layout-04-catch',
    ruleId: 'R-LAYOUT-04',
    title: '首屏安全线越界或桌面双栏图文高度失衡（沿用参考站失衡）',
    kind: 'should-catch',
    scenario: 'upgrade',
    scope: 'homepage',
    source: 'builtin',
    notes: '桌面 1440px 下左文右图双栏图文高度差 310px 远超容差 48px，或首屏主 CTA 底部超出 900px 安全线。',
    evidenceFiles: [],
    viewport: 'desktop',
    criterionId: 'structure',
    simulatedIssue: {
      severity: 'major',
      title: '桌面双栏图文高度差 310px 失衡',
      detail: '[R-LAYOUT-04] 沿用参考站失衡结构，未按 relative+absolute 或纵排多图重构。',
      ruleId: 'R-LAYOUT-04',
      viewport: 'desktop',
      criterionId: 'structure',
    },
    expected: {
      quality: 'failed',
      maxDesktopScore: 78,
      requireRuleInPrompt: true,
      requireCapNote: true,
    },
  },
  {
    id: 'cal-r-typo-01-catch',
    ruleId: 'R-TYPO-01',
    title: '全站存在 ≥10 处 <12px 小字或非中文站现原生 date 年/月/日',
    kind: 'should-catch',
    scenario: 'upgrade',
    scope: 'homepage',
    source: 'builtin',
    notes: '页面有 14 处 badge 与页脚提示沿用参考站 10–11px 小字，且荷兰语页面保留了原生 input[type="date"] 与 <html lang="en">。',
    evidenceFiles: [],
    viewport: 'desktop',
    criterionId: 'sections',
    simulatedIssue: {
      severity: 'major',
      title: '全局 <12px 小字与语种本地化异常',
      detail: '[R-TYPO-01] 存在 14 处 <12px 可见文字且非中文站点出现原生 date 年/月/日。',
      ruleId: 'R-TYPO-01',
      viewport: 'desktop',
      criterionId: 'sections',
    },
    expected: {
      quality: 'failed',
      maxDesktopScore: 78,
      requireRuleInPrompt: true,
      requireCapNote: true,
    },
  },
  {
    id: 'cal-r-dupe-01-catch',
    ruleId: 'R-DUPE-01',
    title: '同页相同 CTA 文案或电话重复超过 H32 上限',
    kind: 'should-catch',
    scenario: 'materials',
    scope: 'homepage',
    source: 'builtin',
    notes: '页面正文中「Afspraak maken」CTA 按钮重复出现 6 次未按区块换场景词，且同一电话号码出现 5 次。',
    evidenceFiles: [],
    viewport: 'desktop',
    criterionId: 'sections',
    simulatedIssue: {
      severity: 'minor',
      title: '同页相同 CTA 文案与电话重复超限',
      detail: '[R-DUPE-01] 违背 H32，CTA 重复 6 次且未按区块替换场景词。',
      ruleId: 'R-DUPE-01',
      viewport: 'desktop',
      criterionId: 'sections',
    },
    expected: {
      quality: 'passed',
      requireRuleInPrompt: true,
    },
  },
  {
    id: 'cal-r-trust-01-catch',
    ruleId: 'R-TRUST-01',
    title: '遗漏 24/7 紧急热线、灰白实拍图充 Logo 墙或 homepage 指向子页死链',
    kind: 'should-catch',
    scenario: 'upgrade',
    scope: 'homepage',
    source: 'builtin',
    notes: '源于经典车修复站反馈：旧站含座机与 24/7 手机热线但页面漏掉手机，用 4 张极小灰白实拍图充合作品牌墙，且仅首页模式下卡片跳往未建子页。',
    evidenceFiles: [],
    viewport: 'desktop',
    criterionId: 'sections',
    simulatedIssue: {
      severity: 'major',
      title: '遗漏 24/7 手机热线、灰白实拍图充 Logo 墙且存在仅首页子页死链',
      detail: '[R-TRUST-01] 页面只留白天座机却宣称 24/7 接听，缺少真实 Logo 强行放 4 张灰白缩略图，且 HOMEPAGE_SUBPAGE_LINK 检测到子页链接。',
      ruleId: 'R-TRUST-01',
      viewport: 'desktop',
      criterionId: 'sections',
    },
    expected: {
      quality: 'failed',
      maxDesktopScore: 76,
      requireRuleInPrompt: true,
      requireCapNote: true,
    },
  },
];

function validateCap(value: number | null, label: string): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${label}必须为空或 0 到 100 之间的数字`);
  }
  return Math.round(value * 10) / 10;
}

function normalizeRuleInput(input: CheckerCheckRuleInput): Omit<CheckerCheckRule, 'revision' | 'createdAt' | 'updatedAt'> {
  const id = input.id.trim().toUpperCase();
  if (!CHECK_RULE_ID_PATTERN.test(id)) {
    throw new Error('规则编号必须符合 R-<类别>-<两位或三位数字>（例如 R-CONTENT-01）');
  }
  const title = input.title.trim();
  const trigger = input.trigger.trim();
  const action = input.action.trim();
  if (!title) throw new Error('规则标题不能为空');
  if (!trigger) throw new Error('触发条件不能为空');
  if (!action) throw new Error('裁决动作说明不能为空');
  const scenarios = [...new Set(input.scenarios)].filter(Boolean);
  const scopes = [...new Set(input.scopes)].filter((s): s is Scope => s === 'homepage' || s === 'site');
  if (!scenarios.length) throw new Error('至少选择一个适用场景');
  if (!scopes.length) throw new Error('至少选择一个适用范围（首页或全站）');
  const exemptions = [...new Set(input.exemptions.map(item => item.trim()).filter(Boolean))];
  return {
    id,
    title,
    severity: input.severity,
    trigger,
    exemptions,
    criterionCap: validateCap(input.criterionCap, '维度封顶'),
    viewportCap: validateCap(input.viewportCap, '视口封顶'),
    action,
    scenarios,
    scopes,
    enabled: input.enabled ?? true,
    source: input.source ?? 'human-review',
    ...(input.sourceReportId ? { sourceReportId: input.sourceReportId } : {}),
    ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}),
    ...(input.sourceSiteUrl ? { sourceSiteUrl: input.sourceSiteUrl } : {}),
    ...(input.reviewKind ? { reviewKind: input.reviewKind } : {}),
    ...(input.rationale?.trim() ? { rationale: input.rationale.trim() } : {}),
  };
}

export function renderChecksMarkdown(
  rules: readonly CheckerCheckRule[],
  calibrations: readonly CheckerCalibrationCase[] = [],
): string {
  const enabledRules = rules.filter(r => r.enabled);
  const disabledRules = rules.filter(r => !r.enabled);
  const lines: string[] = [
    '# 独立评测反模式红线清单（CHECKS.md）',
    '',
    `> 共包含 ${enabledRules.length} 条启用规则${disabledRules.length ? `（另有 ${disabledRules.length} 条已停用）` : ''}，关联 ${calibrations.length} 条自动回归标定反例。`,
    '',
  ];

  if (!enabledRules.length) {
    lines.push('（当前筛选条件下没有启用的红线规则。）', '');
  } else {
    for (const r of enabledRules) {
      lines.push(`## \`${r.id}\` [${r.severity.toUpperCase()}] ${r.title}`);
      lines.push(`- **来源与版本**：${r.source === 'builtin' ? '内置种子规则' : '人工复核沉淀'}（rev ${r.revision}${r.sourceReportId ? ` · 来源报告 ${r.sourceReportId}` : ''}）`);
      lines.push(`- **适用场景 / 范围**：${r.scenarios.join(', ')} / ${r.scopes.join(', ')}`);
      lines.push(`- **触发条件**：${r.trigger}`);
      lines.push(`- **明确豁免**：${r.exemptions.length ? r.exemptions.join('；') : '无'}`);
      lines.push(
        `- **宿主封顶与动作**：维度 ${r.criterionCap !== null ? `≤ ${r.criterionCap}` : '不额外封顶'} / 视口 ${r.viewportCap !== null ? `≤ ${r.viewportCap}` : '按通用规则'}；${r.action}`,
      );
      const count = calibrations.filter(c => c.ruleId === r.id).length;
      if (count) {
        lines.push(`- **标定反例**：已绑定 ${count} 条回归标定用例`);
      }
      lines.push('');
    }
  }

  if (disabledRules.length) {
    lines.push('---', '', '## 已停用规则（归档参考）');
    for (const r of disabledRules) {
      lines.push(`- \`${r.id}\` ${r.title}（rev ${r.revision}，已停用）`);
    }
    lines.push('');
  }

  return lines.join('\n').trim() + '\n';
}

export function hashChecksSnapshot(markdown: string, rules: readonly CheckerCheckRule[]): string {
  const canonical = rules.map(r => ({
    id: r.id,
    revision: r.revision,
    enabled: r.enabled,
    severity: r.severity,
    trigger: r.trigger,
    exemptions: r.exemptions,
    criterionCap: r.criterionCap,
    viewportCap: r.viewportCap,
    action: r.action,
    scenarios: r.scenarios,
    scopes: r.scopes,
  }));
  return createHash('sha256').update(JSON.stringify({ markdown, canonical })).digest('hex');
}

export function toAntiPatternRules(rules: readonly CheckerCheckRule[]): AntiPatternRule[] {
  return rules
    .filter(r => r.enabled)
    .map(r => ({
      id: r.id,
      title: r.title,
      severity: r.severity,
      trigger: r.trigger,
      exemptions: r.exemptions,
      criterionCap: r.criterionCap,
      viewportCap: r.viewportCap,
      action: r.action,
    }));
}

export class CheckerChecksStore {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS auto_checker_checks(
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auto_checker_check_revisions(
        rule_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY(rule_id, revision)
      );
      CREATE TABLE IF NOT EXISTS auto_checker_calibrations(
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        json TEXT NOT NULL
      );`);
    this.seedDefaultsIfEmpty();
  }

  private seedDefaultsIfEmpty() {
    this.db.transaction(() => {
      const hasRuleStmt = this.db.prepare('SELECT 1 FROM auto_checker_checks WHERE id = ?');
      const now = Date.now();
      for (let i = 0; i < DEFAULT_ANTI_PATTERN_RULES.length; i++) {
        const seed = DEFAULT_ANTI_PATTERN_RULES[i];
        if (hasRuleStmt.get(seed.id)) continue;
        const rule: CheckerCheckRule = {
          id: seed.id,
          title: seed.title,
          severity: seed.severity,
          trigger: seed.trigger,
          exemptions: [...seed.exemptions],
          criterionCap: seed.criterionCap,
          viewportCap: seed.viewportCap,
          action: seed.action,
          scenarios: [...ALL_ACTIVE_SCENARIOS],
          scopes: [...ALL_SCOPES],
          enabled: true,
          source: 'builtin',
          revision: 1,
          createdAt: now + i,
          updatedAt: now + i,
          rationale: 'Phase 1 Verification Engineering 内置种子红线规则',
        };
        this.writeRuleRow(rule, 'system', '初始化内置种子红线规则');
      }
      const hasCalStmt = this.db.prepare('SELECT 1 FROM auto_checker_calibrations WHERE id = ?');
      const insertCalStmt = this.db.prepare('INSERT INTO auto_checker_calibrations VALUES(?,?,?,?)');
      for (let i = 0; i < BUILTIN_CALIBRATION_SEEDS.length; i++) {
        const item = BUILTIN_CALIBRATION_SEEDS[i];
        if (hasCalStmt.get(item.id)) continue;
        const cal: CheckerCalibrationCase = { ...item, createdAt: now + i };
        insertCalStmt.run(cal.id, cal.ruleId, cal.createdAt, JSON.stringify(cal));
      }
    });
  }

  private writeRuleRow(rule: CheckerCheckRule, actor: 'system' | 'human', reason: string) {
    this.db
      .prepare(
        `INSERT INTO auto_checker_checks VALUES(?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, enabled=excluded.enabled, updated_at=excluded.updated_at, json=excluded.json`,
      )
      .run(rule.id, rule.revision, rule.enabled ? 1 : 0, rule.createdAt, rule.updatedAt, JSON.stringify(rule));
    const rev: CheckerCheckRevision = {
      ruleId: rule.id,
      revision: rule.revision,
      actor,
      reason,
      snapshot: rule,
      createdAt: rule.updatedAt,
    };
    this.db
      .prepare('INSERT OR REPLACE INTO auto_checker_check_revisions VALUES(?,?,?,?)')
      .run(rule.id, rule.revision, rule.updatedAt, JSON.stringify(rev));
  }

  listRules(): CheckerCheckRule[] {
    const rows = this.db
      .prepare('SELECT json FROM auto_checker_checks ORDER BY created_at ASC, id ASC')
      .all() as Array<{ json: string }>;
    return rows.map(row => JSON.parse(row.json) as CheckerCheckRule);
  }

  getRule(id: string): CheckerCheckRule | undefined {
    const row = this.db
      .prepare('SELECT json FROM auto_checker_checks WHERE id=?')
      .get(id.trim().toUpperCase()) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as CheckerCheckRule) : undefined;
  }

  activeRules(scenario?: Scenario, scope?: Scope): CheckerCheckRule[] {
    return this.listRules().filter(rule => {
      if (!rule.enabled) return false;
      if (scenario && !rule.scenarios.includes(scenario)) return false;
      if (scope && !rule.scopes.includes(scope)) return false;
      return true;
    });
  }

  revisions(ruleId: string): CheckerCheckRevision[] {
    const rows = this.db
      .prepare('SELECT json FROM auto_checker_check_revisions WHERE rule_id=? ORDER BY revision DESC')
      .all(ruleId.trim().toUpperCase()) as Array<{ json: string }>;
    return rows.map(row => JSON.parse(row.json) as CheckerCheckRevision);
  }

  listCalibrations(ruleId?: string): CheckerCalibrationCase[] {
    const rows = ruleId
      ? (this.db
          .prepare('SELECT json FROM auto_checker_calibrations WHERE rule_id=? ORDER BY created_at ASC, id ASC')
          .all(ruleId.trim().toUpperCase()) as Array<{ json: string }>)
      : (this.db
          .prepare('SELECT json FROM auto_checker_calibrations ORDER BY created_at ASC, id ASC')
          .all() as Array<{ json: string }>);
    return rows.map(row => JSON.parse(row.json) as CheckerCalibrationCase);
  }

  nextSuggestedIds(): Record<string, string> {
    const existing = this.listRules().map(r => r.id);
    const prefixes = ['R-VISUAL', 'R-LAYOUT', 'R-CONTENT', 'R-COVER', 'R-CUSTOM'];
    const result: Record<string, string> = {};
    for (const prefix of prefixes) {
      let max = 0;
      for (const id of existing) {
        if (id.startsWith(`${prefix}-`)) {
          const suffix = Number.parseInt(id.slice(prefix.length + 1), 10);
          if (Number.isFinite(suffix) && suffix > max) max = suffix;
        }
      }
      result[prefix] = `${prefix}-${String(max + 1).padStart(2, '0')}`;
    }
    return result;
  }

  createRule(
    input: CheckerCheckRuleInput,
    reason: string,
    calibrationInput?: CheckerCalibrationInput,
  ): { rule: CheckerCheckRule; calibration?: CheckerCalibrationCase } {
    return this.db.transaction(() => {
      const normalized = normalizeRuleInput(input);
      if (this.getRule(normalized.id)) {
        throw new Conflict(`规则 ${normalized.id} 已存在，请更换编号或在原规则上修订`);
      }
      const now = Date.now();
      const rule: CheckerCheckRule = {
        ...normalized,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.writeRuleRow(rule, 'human', reason.trim() || '人工复核沉淀新规则');
      let calibration: CheckerCalibrationCase | undefined;
      if (calibrationInput) {
        calibration = this.insertCalibrationForRule(rule, calibrationInput);
      }
      return { rule, ...(calibration ? { calibration } : {}) };
    });
  }

  updateRule(
    id: string,
    patch: Partial<Omit<CheckerCheckRuleInput, 'id'>>,
    expectedRevision: number,
    reason: string,
    calibrationInput?: CheckerCalibrationInput,
  ): { rule: CheckerCheckRule; calibration?: CheckerCalibrationCase } {
    return this.db.transaction(() => {
      const existing = this.getRule(id);
      if (!existing) throw new Conflict('规则不存在');
      if (existing.revision !== expectedRevision) {
        throw new Conflict('规则版本已变更，请刷新后重新编辑');
      }
      const normalized = normalizeRuleInput({
        id: existing.id,
        title: patch.title ?? existing.title,
        severity: patch.severity ?? existing.severity,
        trigger: patch.trigger ?? existing.trigger,
        exemptions: patch.exemptions ?? existing.exemptions,
        criterionCap: patch.criterionCap !== undefined ? patch.criterionCap : existing.criterionCap,
        viewportCap: patch.viewportCap !== undefined ? patch.viewportCap : existing.viewportCap,
        action: patch.action ?? existing.action,
        scenarios: patch.scenarios ?? existing.scenarios,
        scopes: patch.scopes ?? existing.scopes,
        enabled: patch.enabled ?? existing.enabled,
        source: existing.source,
        sourceReportId: patch.sourceReportId ?? existing.sourceReportId,
        sourceTaskId: patch.sourceTaskId ?? existing.sourceTaskId,
        sourceSiteUrl: patch.sourceSiteUrl ?? existing.sourceSiteUrl,
        reviewKind: patch.reviewKind ?? existing.reviewKind,
        rationale: patch.rationale ?? existing.rationale,
      });
      const now = Date.now();
      const updated: CheckerCheckRule = {
        ...normalized,
        revision: existing.revision + 1,
        createdAt: existing.createdAt,
        updatedAt: now,
      };
      this.writeRuleRow(updated, 'human', reason.trim() || '人工编辑修订规则');
      let calibration: CheckerCalibrationCase | undefined;
      if (calibrationInput) {
        calibration = this.insertCalibrationForRule(updated, calibrationInput);
      }
      return { rule: updated, ...(calibration ? { calibration } : {}) };
    });
  }

  restoreRule(
    id: string,
    expectedRevision: number,
    targetRevision: number,
    reason: string,
  ): CheckerCheckRule {
    return this.db.transaction(() => {
      const existing = this.getRule(id);
      if (!existing) throw new Conflict('规则不存在');
      if (existing.revision !== expectedRevision) {
        throw new Conflict('规则版本已变更，请刷新后重试');
      }
      const revRow = this.db
        .prepare('SELECT json FROM auto_checker_check_revisions WHERE rule_id=? AND revision=?')
        .get(existing.id, targetRevision) as { json: string } | undefined;
      if (!revRow) throw new Conflict(`历史版本 rev ${targetRevision} 不存在`);
      const target = (JSON.parse(revRow.json) as CheckerCheckRevision).snapshot;
      const now = Date.now();
      const restored: CheckerCheckRule = {
        ...target,
        id: existing.id,
        revision: existing.revision + 1,
        createdAt: existing.createdAt,
        updatedAt: now,
      };
      this.writeRuleRow(restored, 'human', reason.trim() || `恢复至历史版本 rev ${targetRevision}`);
      return restored;
    });
  }

  private insertCalibrationForRule(
    rule: CheckerCheckRule,
    input: CheckerCalibrationInput,
  ): CheckerCalibrationCase {
    const viewport = input.viewport ?? 'desktop';
    const criterionId = input.criterionId !== undefined ? input.criterionId : 'sections';
    const isBlockingRule = rule.severity !== 'minor';
    const defaultQuality = input.kind === 'should-catch' && isBlockingRule ? 'failed' : 'passed';
    const cal: CheckerCalibrationCase = {
      id: `cal-${randomUUID().slice(0, 8)}`,
      ruleId: rule.id,
      title: input.title.trim() || `${rule.id} · ${rule.title}`,
      kind: input.kind,
      scenario: input.scenario,
      scope: input.scope,
      source: 'human-review',
      ...(input.sourceReportId ? { sourceReportId: input.sourceReportId } : {}),
      ...(input.sourceTaskId ? { sourceTaskId: input.sourceTaskId } : {}),
      ...(input.sourceSiteUrl ? { sourceSiteUrl: input.sourceSiteUrl } : {}),
      evidenceFiles: [...new Set((input.evidenceFiles || []).map(f => f.trim()).filter(Boolean))],
      notes: (input.notes || rule.rationale || rule.trigger).trim(),
      viewport,
      criterionId,
      ...(input.kind === 'should-catch'
        ? {
            simulatedIssue: input.simulatedIssue || {
              severity: rule.severity,
              title: input.title.trim() || rule.title,
              detail: `[${rule.id}] ${(input.notes || rule.trigger).trim()}`,
              ruleId: rule.id,
              viewport,
              criterionId,
            },
          }
        : {}),
      expected: {
        quality: input.expected?.quality ?? defaultQuality,
        maxDesktopScore:
          input.expected?.maxDesktopScore !== undefined
            ? input.expected.maxDesktopScore
            : input.kind === 'should-catch' && isBlockingRule && viewport !== 'mobile'
              ? (rule.viewportCap ?? (rule.severity === 'critical' ? 55 : 78))
              : undefined,
        maxMobileScore:
          input.expected?.maxMobileScore !== undefined
            ? input.expected.maxMobileScore
            : input.kind === 'should-catch' && isBlockingRule && viewport !== 'desktop'
              ? (rule.viewportCap ?? (rule.severity === 'critical' ? 55 : 78))
              : undefined,
        minDesktopScore: input.expected?.minDesktopScore ?? (input.kind === 'should-pass' ? 85 : undefined),
        minMobileScore: input.expected?.minMobileScore ?? (input.kind === 'should-pass' ? 85 : undefined),
        requireRuleInPrompt: input.expected?.requireRuleInPrompt ?? true,
        requireCapNote:
          input.expected?.requireCapNote ??
          (input.kind === 'should-catch' &&
            rule.severity !== 'minor' &&
            (rule.criterionCap !== null || rule.viewportCap !== null)),
        ...(input.expected?.expectedExemptionText
          ? { expectedExemptionText: input.expected.expectedExemptionText }
          : {}),
      },
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO auto_checker_calibrations VALUES(?,?,?,?)')
      .run(cal.id, cal.ruleId, cal.createdAt, JSON.stringify(cal));
    return cal;
  }

  addCalibration(ruleId: string, input: CheckerCalibrationInput): CheckerCalibrationCase {
    return this.db.transaction(() => {
      const rule = this.getRule(ruleId);
      if (!rule) throw new Conflict(`关联规则 ${ruleId} 不存在`);
      return this.insertCalibrationForRule(rule, input);
    });
  }

  deleteCalibration(id: string): void {
    const row = this.db
      .prepare('SELECT json FROM auto_checker_calibrations WHERE id=?')
      .get(id) as { json: string } | undefined;
    if (!row) throw new Conflict('标定反例不存在');
    const cal = JSON.parse(row.json) as CheckerCalibrationCase;
    if (cal.source === 'builtin') {
      throw new Conflict('内置基线标定反例不可删除');
    }
    this.db.prepare('DELETE FROM auto_checker_calibrations WHERE id=?').run(id);
  }

  snapshot(filter?: { scenario?: Scenario; scope?: Scope }): CheckerChecksSnapshot {
    const rules = filter?.scenario || filter?.scope
      ? this.activeRules(filter.scenario, filter.scope)
      : this.listRules();
    const ruleSet = new Set(rules.map(r => r.id));
    const calibrations = this.listCalibrations().filter(c =>
      filter?.scenario || filter?.scope ? ruleSet.has(c.ruleId) : true,
    );
    const markdown = renderChecksMarkdown(rules, calibrations);
    return {
      hash: hashChecksSnapshot(markdown, rules),
      markdown,
      rules,
      calibrations,
    };
  }
}

const DEFAULT_REGRESSION_CRITERIA: Criterion[] = [
  {
    id: 'hero',
    label: 'Hero 首屏',
    weight: 40,
    instruction: '首屏视觉主位、信息层级与 CTA。',
    required: false,
    viewports: ['desktop', 'mobile'],
    scopes: ['homepage', 'site'],
  },
  {
    id: 'structure',
    label: '页面结构',
    weight: 40,
    instruction: '区段结构与响应式布局。',
    required: false,
    viewports: ['desktop', 'mobile'],
    scopes: ['homepage', 'site'],
  },
  {
    id: 'sections',
    label: '其他区段',
    weight: 20,
    instruction: '内容展示与配图质量。',
    required: false,
    viewports: ['desktop', 'mobile'],
    scopes: ['homepage', 'site'],
  },
];

function checkEvidenceFilesOnDisk(
  cal: CheckerCalibrationCase,
  dataDirectory?: string,
): 'verified' | 'missing-on-disk' | 'synthetic' {
  if (!cal.evidenceFiles.length) return 'synthetic';
  if (!dataDirectory || !cal.sourceReportId) return 'synthetic';
  for (const file of cal.evidenceFiles) {
    const abs = resolve(dataDirectory, 'automation-runs', cal.sourceReportId, 'evidence', file);
    if (!existsSync(abs)) return 'missing-on-disk';
    try {
      const head = readFileSync(abs).subarray(0, 8).toString('hex');
      if (head !== '89504e470d0a1a0a') return 'missing-on-disk';
    } catch {
      return 'missing-on-disk';
    }
  }
  return 'verified';
}

export function runChecksRegressionSuite(
  rules: readonly CheckerCheckRule[],
  calibrations: readonly CheckerCalibrationCase[],
  dataDirectory?: string,
): ChecksRegressionReport {
  const allSnapshot = renderChecksMarkdown(rules, calibrations);
  const checksHash = hashChecksSnapshot(allSnapshot, rules);
  const results: ChecksRegressionCaseResult[] = [];

  for (const cal of calibrations) {
    const assertions: ChecksRegressionAssertion[] = [];
    const matchingRules = rules.filter(
      r => r.enabled && r.scenarios.includes(cal.scenario) && r.scopes.includes(cal.scope),
    );
    const antiPatternRules = toAntiPatternRules(matchingRules);
    const matchedRule = matchingRules.find(r => r.id === cal.ruleId);

    const presetOutOfScope = defaultOutOfScope({
      scenario: cal.scenario,
      scope: cal.scope,
      hasReference: false,
      hasMaterials: cal.scenario === 'materials',
    });

    const prompt = buildBoundedCheckerPrompt({
      scenario: cal.scenario,
      scope: cal.scope,
      siteUrl: cal.sourceSiteUrl || 'https://calibration.localkooboo.test/',
      description: cal.title,
      criteria: DEFAULT_REGRESSION_CRITERIA,
      presetOutOfScope,
      imageManifestLines:
        cal.evidenceFiles.length > 0
          ? cal.evidenceFiles.map(
              f => `${f} (role=target, viewport=${cal.viewport === 'mobile' ? 'mobile' : 'desktop'})`,
            )
          : ['synthetic-desktop-0.png (role=target, viewport=desktop)'],
      hasReference: false,
      antiPatternRules,
    });

    if (cal.expected.requireRuleInPrompt) {
      const hasRule = Boolean(matchedRule) && prompt.includes(cal.ruleId) && prompt.includes(matchedRule!.title);
      assertions.push({
        name: 'Prompt 注入启用规则',
        passed: hasRule,
        detail: hasRule
          ? `规则 ${cal.ruleId}（${matchedRule!.title}）已注入评测 Prompt`
          : `规则 ${cal.ruleId} 未启用或未命中当前场景(${cal.scenario})/范围(${cal.scope})的 Prompt`,
      });
    }

    if (cal.expected.expectedExemptionText) {
      const hasExemption = prompt.includes(cal.expected.expectedExemptionText);
      assertions.push({
        name: 'Prompt 保留豁免条款',
        passed: hasExemption,
        detail: hasExemption
          ? `Prompt 已保留豁免关键词「${cal.expected.expectedExemptionText}」`
          : `Prompt 缺少期望豁免文本「${cal.expected.expectedExemptionText}」`,
      });
    }

    const baseAssessments: Assessment[] = DEFAULT_REGRESSION_CRITERIA.flatMap(c =>
      (['desktop', 'mobile'] as const).map(vp => ({
        criterionId: c.id,
        viewport: vp,
        score: 92,
        reason: '标定基准高分',
        evidence: ['cal-evidence.png'],
        passed: true,
      })),
    );

    const issues: BoundedIssue[] =
      cal.kind === 'should-catch'
        ? [
            {
              severity: cal.simulatedIssue?.severity ?? matchedRule?.severity ?? 'major',
              title: cal.simulatedIssue?.title || cal.title,
              detail: cal.simulatedIssue?.detail || cal.notes,
              evidence: cal.evidenceFiles.length ? cal.evidenceFiles : ['cal-evidence.png'],
              // If the rule itself isn't active for this scenario/scope, drop ruleId so disabled rules fail cap checks loudly.
              ruleId: matchedRule ? (cal.simulatedIssue?.ruleId ?? cal.ruleId) : null,
              viewport: cal.simulatedIssue?.viewport ?? cal.viewport,
              criterionId: cal.simulatedIssue?.criterionId ?? cal.criterionId,
            },
          ]
        : [];

    const verdict = applyBoundedVerdictCaps({
      assessments: baseAssessments,
      issues,
      criteria: DEFAULT_REGRESSION_CRITERIA,
      threshold: 85,
      coverage: { verified: ['已完成标定基线验证'], unverified: [], outOfScope: [] },
      presetOutOfScope,
      humanSummary: {
        verdict: 'ready',
        headline: '标定测试初始乐观输出',
        highlights: ['结构整齐'],
        topFixes: [],
      },
      antiPatternRules,
    });

    const qualityPass = verdict.quality === cal.expected.quality;
    assertions.push({
      name: '质量裁决符合预期',
      passed: qualityPass,
      detail: `期望 ${cal.expected.quality}，实际 ${verdict.quality}`,
    });

    if (cal.kind === 'should-catch' && cal.expected.quality === 'failed') {
      const verdictBlocked = verdict.humanSummary?.verdict !== 'ready';
      assertions.push({
        name: '禁止乐观 ready verdict',
        passed: verdictBlocked,
        detail: verdictBlocked
          ? `humanSummary.verdict 已转为 ${verdict.humanSummary?.verdict}`
          : 'humanSummary.verdict 仍错误保留为 ready',
      });
    }

    const desk = verdict.scores.find(s => s.viewport === 'desktop')?.value ?? null;
    const mob = verdict.scores.find(s => s.viewport === 'mobile')?.value ?? null;

    if (cal.expected.maxDesktopScore != null) {
      const ok = desk !== null && desk <= cal.expected.maxDesktopScore;
      assertions.push({
        name: 'PC 分数封顶',
        passed: ok,
        detail: `期望 ≤ ${cal.expected.maxDesktopScore}，实际 ${desk ?? 'null'}`,
      });
    }
    if (cal.expected.maxMobileScore != null) {
      const ok = mob !== null && mob <= cal.expected.maxMobileScore;
      assertions.push({
        name: '移动端分数封顶',
        passed: ok,
        detail: `期望 ≤ ${cal.expected.maxMobileScore}，实际 ${mob ?? 'null'}`,
      });
    }
    if (cal.expected.minDesktopScore != null) {
      const ok = desk !== null && desk >= cal.expected.minDesktopScore;
      assertions.push({
        name: 'PC 豁免分数不误伤',
        passed: ok,
        detail: `期望 ≥ ${cal.expected.minDesktopScore}，实际 ${desk ?? 'null'}`,
      });
    }
    if (cal.expected.minMobileScore != null) {
      const ok = mob !== null && mob >= cal.expected.minMobileScore;
      assertions.push({
        name: '移动端豁免分数不误伤',
        passed: ok,
        detail: `期望 ≥ ${cal.expected.minMobileScore}，实际 ${mob ?? 'null'}`,
      });
    }
    if (cal.expected.requireCapNote) {
      const hasCapNote = verdict.capNotes.some(note => note.includes(cal.ruleId));
      assertions.push({
        name: '宿主封顶说明包含规则编号',
        passed: hasCapNote,
        detail: hasCapNote
          ? verdict.capNotes.join('；')
          : `capNotes 中未命中 ${cal.ruleId}：${verdict.capNotes.join('；') || '无封顶日志'}`,
      });
    }

    const evidenceStatus = checkEvidenceFilesOnDisk(cal, dataDirectory);
    if (evidenceStatus === 'missing-on-disk') {
      assertions.push({
        name: '关联磁盘截图存在且为有效 PNG',
        passed: false,
        detail: `报告 ${cal.sourceReportId} 中部分截图在磁盘上缺失或已损坏`,
      });
    }

    results.push({
      caseId: cal.id,
      ruleId: cal.ruleId,
      title: cal.title,
      kind: cal.kind,
      passed: assertions.every(a => a.passed),
      assertions,
      evidenceStatus,
      observedQuality: verdict.quality,
      observedScores: verdict.scores,
    });
  }

  const passed = results.filter(r => r.passed).length;
  return {
    generatedAt: Date.now(),
    checksHash,
    total: results.length,
    passed,
    failed: results.length - passed,
    mode: 'deterministic',
    modeNote:
      '本回归验证基于当前启用的红线规则，确定性检验「Prompt 注入（含豁免条款）+ 宿主封顶硬裁决（applyBoundedVerdictCaps）+ 磁盘证据完整性」（0 Token）；若需调真实视觉模型看图复测，请运行 `node --import tsx scripts/checks-regression.ts --live --case <id>`。',
    results,
  };
}

const scenarioEnum = z.enum(['materials', 'upgrade', 'migration', 'site-template', 'app-template']);
const scopeEnum = z.enum(['homepage', 'site']);
const severityEnum = z.enum(['critical', 'major', 'minor']);
const viewportEnum = z.enum(['desktop', 'mobile', 'both']);

const calibrationInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    kind: z.enum(['should-catch', 'should-pass']),
    scenario: scenarioEnum,
    scope: scopeEnum,
    sourceReportId: z.string().uuid().optional(),
    sourceTaskId: z.string().uuid().optional(),
    sourceSiteUrl: z.string().trim().max(2000).optional(),
    evidenceFiles: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    notes: z.string().trim().max(4000).optional(),
    viewport: viewportEnum.optional(),
    criterionId: z.string().trim().min(1).max(60).nullable().optional(),
    simulatedIssue: z
      .object({
        severity: severityEnum,
        title: z.string().trim().min(1).max(200),
        detail: z.string().trim().min(1).max(2000),
        ruleId: z.string().trim().max(40).nullable(),
        viewport: viewportEnum,
        criterionId: z.string().trim().min(1).max(60).nullable(),
      })
      .optional(),
    expected: z
      .object({
        quality: z.enum(['passed', 'failed', 'unverified']).optional(),
        maxDesktopScore: z.number().min(0).max(100).nullable().optional(),
        maxMobileScore: z.number().min(0).max(100).nullable().optional(),
        minDesktopScore: z.number().min(0).max(100).nullable().optional(),
        minMobileScore: z.number().min(0).max(100).nullable().optional(),
        requireRuleInPrompt: z.boolean().optional(),
        requireCapNote: z.boolean().optional(),
        expectedExemptionText: z.string().trim().max(400).optional(),
      })
      .optional(),
  })
  .strict();

export function registerCheckerChecksApi(
  app: FastifyInstance,
  store: AutomationStore,
  directory: string,
) {
  const ruleParams = z.object({ id: z.string().trim().regex(CHECK_RULE_ID_PATTERN, '无效规则编号') });
  const calParams = z.object({ id: z.string().trim().min(1).max(80) });

  app.get('/api/automation/checks', async () => ({
    snapshot: store.checks.snapshot(),
    suggestedIds: store.checks.nextSuggestedIds(),
  }));

  app.get('/api/automation/checks/:id/history', async request => {
    const { id } = ruleParams.parse(request.params);
    return { items: store.checks.revisions(id) };
  });

  app.post('/api/automation/checks', async (request, reply) => {
    const body = z
      .object({
        rule: z
          .object({
            id: z.string().trim().regex(CHECK_RULE_ID_PATTERN, '规则编号格式应为 R-<类别>-<数字>'),
            title: z.string().trim().min(1).max(200),
            severity: severityEnum,
            trigger: z.string().trim().min(1).max(4000),
            exemptions: z.array(z.string().trim().max(400)).max(50).default([]),
            criterionCap: z.number().min(0).max(100).nullable(),
            viewportCap: z.number().min(0).max(100).nullable(),
            action: z.string().trim().min(1).max(1000),
            scenarios: z.array(scenarioEnum).min(1).max(5),
            scopes: z.array(scopeEnum).min(1).max(2),
            enabled: z.boolean().optional(),
            sourceReportId: z.string().uuid().optional(),
            sourceTaskId: z.string().uuid().optional(),
            sourceSiteUrl: z.string().trim().max(2000).optional(),
            reviewKind: z.enum(['missed-defect', 'false-positive', 'calibration']).optional(),
            rationale: z.string().trim().max(4000).optional(),
          })
          .strict(),
        reason: z.string().trim().min(1).max(1000),
        calibration: calibrationInputSchema.optional(),
      })
      .strict()
      .parse(request.body);

    const { rule, calibration } = store.checks.createRule(
      { ...body.rule, source: 'human-review' },
      body.reason,
      body.calibration,
    );
    return reply.code(201).send({
      rule,
      ...(calibration ? { calibration } : {}),
      snapshot: store.checks.snapshot(),
      suggestedIds: store.checks.nextSuggestedIds(),
    });
  });

  app.put('/api/automation/checks/:id', async request => {
    const { id } = ruleParams.parse(request.params);
    const body = z
      .object({
        revision: z.number().int().positive(),
        reason: z.string().trim().min(1).max(1000),
        title: z.string().trim().min(1).max(200).optional(),
        severity: severityEnum.optional(),
        trigger: z.string().trim().min(1).max(4000).optional(),
        exemptions: z.array(z.string().trim().max(400)).max(50).optional(),
        appendExemption: z.string().trim().min(1).max(400).optional(),
        criterionCap: z.number().min(0).max(100).nullable().optional(),
        viewportCap: z.number().min(0).max(100).nullable().optional(),
        action: z.string().trim().min(1).max(1000).optional(),
        scenarios: z.array(scenarioEnum).min(1).max(5).optional(),
        scopes: z.array(scopeEnum).min(1).max(2).optional(),
        enabled: z.boolean().optional(),
        sourceReportId: z.string().uuid().optional(),
        sourceTaskId: z.string().uuid().optional(),
        sourceSiteUrl: z.string().trim().max(2000).optional(),
        reviewKind: z.enum(['missed-defect', 'false-positive', 'calibration']).optional(),
        rationale: z.string().trim().max(4000).optional(),
        calibration: calibrationInputSchema.optional(),
      })
      .strict()
      .parse(request.body);

    const existing = store.checks.getRule(id);
    if (!existing) throw new Conflict('规则不存在');
    let nextExemptions = body.exemptions;
    if (body.appendExemption) {
      const base = nextExemptions ?? existing.exemptions;
      if (!base.includes(body.appendExemption)) {
        nextExemptions = [...base, body.appendExemption];
      } else {
        nextExemptions = base;
      }
    }

    const { rule, calibration } = store.checks.updateRule(
      id,
      {
        title: body.title,
        severity: body.severity,
        trigger: body.trigger,
        exemptions: nextExemptions,
        criterionCap: body.criterionCap,
        viewportCap: body.viewportCap,
        action: body.action,
        scenarios: body.scenarios,
        scopes: body.scopes,
        enabled: body.enabled,
        sourceReportId: body.sourceReportId,
        sourceTaskId: body.sourceTaskId,
        sourceSiteUrl: body.sourceSiteUrl,
        reviewKind: body.reviewKind,
        rationale: body.rationale,
      },
      body.revision,
      body.reason,
      body.calibration,
    );
    return {
      rule,
      ...(calibration ? { calibration } : {}),
      snapshot: store.checks.snapshot(),
      suggestedIds: store.checks.nextSuggestedIds(),
    };
  });

  app.post('/api/automation/checks/:id/restore', async request => {
    const { id } = ruleParams.parse(request.params);
    const body = z
      .object({
        revision: z.number().int().positive(),
        from: z.number().int().positive(),
        reason: z.string().trim().min(1).max(1000).default('人工恢复历史版本'),
      })
      .strict()
      .parse(request.body);
    const rule = store.checks.restoreRule(id, body.revision, body.from, body.reason);
    return {
      rule,
      snapshot: store.checks.snapshot(),
      suggestedIds: store.checks.nextSuggestedIds(),
    };
  });

  app.post('/api/automation/checks/calibrations', async (request, reply) => {
    const body = z
      .object({
        ruleId: z.string().trim().regex(CHECK_RULE_ID_PATTERN, '无效规则编号'),
      })
      .merge(calibrationInputSchema)
      .strict()
      .parse(request.body);
    const { ruleId, ...calInput } = body;
    const calibration = store.checks.addCalibration(ruleId, calInput);
    return reply.code(201).send({
      calibration,
      snapshot: store.checks.snapshot(),
    });
  });

  app.delete('/api/automation/checks/calibrations/:id', async request => {
    const { id } = calParams.parse(request.params);
    store.checks.deleteCalibration(id);
    return {
      deleted: true,
      snapshot: store.checks.snapshot(),
    };
  });

  app.post('/api/automation/checks/regression', async () =>
    runChecksRegressionSuite(store.checks.listRules(), store.checks.listCalibrations(), directory),
  );
}

