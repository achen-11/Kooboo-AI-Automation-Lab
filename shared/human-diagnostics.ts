export type DiagnosticCategory =
  | 'source-access'
  | 'target-auth'
  | 'template-source'
  | 'ai-model'
  | 'environment'
  | 'site-collision'
  | 'need-human-input'
  | 'runtime';

export const diagnosticCategoryLabels: Record<DiagnosticCategory, string> = {
  'source-access': '原站抓取异常',
  'target-auth': 'Kooboo 登录/权限失效',
  'template-source': '模板源异常',
  'ai-model': 'AI 模型或额度异常',
  'environment': '运行环境异常',
  'site-collision': '站点名称冲突',
  'need-human-input': '等待人工确认/补充资料',
  'runtime': '系统执行异常',
};

export interface HumanNotice {
  headline: string;
  category: DiagnosticCategory;
  explanation: string;
  userActions: string[];
}

export type EvaluationVerdict = 'ready' | 'needs-fixes' | 'blocked' | 'incomplete-check';

export const evaluationVerdictLabels: Record<EvaluationVerdict, string> = {
  ready: '可交付 / 已达标',
  'needs-fixes': '建议修改后再交付',
  blocked: '暂不可交付（需修复关键问题）',
  'incomplete-check': '存在未核验范围（待补全或复核）',
};

export interface EvaluationHumanSummary {
  verdict: EvaluationVerdict;
  headline: string;
  highlights: string[];
  topFixes: string[];
  unverifiedNote?: string;
}

const VALID_CATEGORIES = new Set<DiagnosticCategory>(Object.keys(diagnosticCategoryLabels) as DiagnosticCategory[]);
const VALID_VERDICTS = new Set<EvaluationVerdict>(Object.keys(evaluationVerdictLabels) as EvaluationVerdict[]);

/** Strip UUIDs, internal field names, raw API paths and numeric timestamps so non-developers read clean Chinese. */
export function sanitizeHumanText(input: string, maxLength = 320): string {
  const cleaned = String(input || '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
    .replace(/\b(?:ev|req|run|del|msg|task|conv)_[a-z0-9_-]+\b/gi, '')
    .replace(/\b(?:target|reference|content)-(?:desktop|mobile)-[a-z0-9_.-]+\.png\b/gi, '')
    .replace(/\b(?:transferTaskId|sourceSandbox|referenceTemplateSandbox|ask_user_input|deliveryState|previousRunId|createdAt|updatedAt)\b/g, '')
    .replace(/(?:AISandbox|Transfer|Automation)\/[A-Za-z0-9_/?=&-]+/g, '')
    .replace(/\b1[6-9]\d{11}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,，;；:：、-]+|[\s,，;；:：]+$/g, '')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength - 1).trimEnd() + '…' : cleaned;
}

export function normalizeHumanNotice(raw?: Partial<HumanNotice> | null): HumanNotice | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const headline = sanitizeHumanText(raw.headline || '', 80);
  const explanation = sanitizeHumanText(raw.explanation || '', 400);
  if (!headline || !explanation) return undefined;
  const category = VALID_CATEGORIES.has(raw.category as DiagnosticCategory)
    ? (raw.category as DiagnosticCategory)
    : 'runtime';
  const userActions = Array.isArray(raw.userActions)
    ? raw.userActions.map(item => sanitizeHumanText(String(item || ''), 160)).filter(Boolean).slice(0, 6)
    : [];
  return {
    headline,
    category,
    explanation,
    userActions: userActions.length
      ? userActions
      : ['请先核查上述问题并完成调整，然后点击本页的「恢复执行」继续。'],
  };
}

export function deriveHumanNotice(input: {
  reason?: string;
  error?: string;
  stage?: string;
  scenario?: string;
  generatedSiteId?: string | null;
  evidence?: string[];
  nextSteps?: string[];
  userSummary?: Partial<HumanNotice> | null;
  lastAction?: {
    action?: string;
    reason?: string;
    nextSteps?: string[];
    userSummary?: Partial<HumanNotice> | null;
  } | null;
}): HumanNotice {
  const explicit = normalizeHumanNotice(input.userSummary || input.lastAction?.userSummary);
  if (explicit) return explicit;

  const combined = [
    input.reason,
    input.error,
    input.lastAction?.reason,
    ...(input.nextSteps || []),
    ...(input.lastAction?.nextSteps || []),
    ...(input.evidence || []),
  ]
    .filter(Boolean)
    .join('\n');

  const keepSiteSentence = input.generatedSiteId
    ? '当前目标站点和已保存进度都会保留，处理完后无需从头建站。'
    : '本次尚未生成完整目标站点，可在处理问题后直接恢复继续。';

  if (/同名|已存在|占用|subDomain|siteName|站点名.*冲突|命名冲突/i.test(combined)) {
    return {
      headline: '目标站点名称或域名已被占用',
      category: 'site-collision',
      explanation: `当前准备创建的站点名称或子域名与 Kooboo 环境中已有站点冲突，因此任务暂停以避免覆盖线上站点。${keepSiteSentence}`,
      userActions: [
        '在下方站点命名区更换一个新的站点名、子域名或根域名。',
        '修改完成后，直接点击重新生成或恢复继续即可。',
      ],
    };
  }

  if (/ask_user_input|待输入|kind=upload|上传.*截图|上传.*文件|视觉取证失败|等待人工决策|请上传|放弃参考站|是否由\s*AI\s*自由设计|参考站取证失败/i.test(combined)) {
    const cleanNext = (input.nextSteps || input.lastAction?.nextSteps || [])
      .map(s => sanitizeHumanText(s, 150))
      .filter(s => s && !/^[0-9a-z_-]{16,}$/i.test(s));
    return {
      headline: 'AI 需要人工确认或补充资料后才能继续',
      category: 'need-human-input',
      explanation: `Kooboo AI 在执行过程中停下来等待人工协助（例如无法获取参考画面截图、需要补充文件或明确选择）。为保证成站质量，系统已拦截自动代答并交由您处理。${keepSiteSentence}`,
      userActions: cleanNext.length
        ? cleanNext.slice(0, 4)
        : [
            '点击打开对应的 Kooboo 会话或查看当前任务详情，确认 AI 具体请求的内容。',
            '补充所需截图/文件，或在界面确认答案后点击「恢复执行」。',
          ],
    };
  }

  if (/暂不支持模板 Sandbox|接口不存在（目标 Kooboo 环境版本过低|目标 Kooboo 环境版本过低|Api method Not Found|找不到\s*API\s*方法/i.test(combined)) {
    return {
      headline: '目标 Kooboo 环境版本暂不支持所选模板模式',
      category: 'environment',
      explanation: `当前所选 Kooboo 环境尚未更新模板 Sandbox 相关后端接口，无法执行角色对调升级或模板参考 Sandbox 模式。${keepSiteSentence}`,
      userActions: [
        '将该资源的参考站来源改回「外部参考站 URL」（可填入模板预览地址），再新建任务。',
        '或切换至已升级最新版本的 Kooboo 环境后重新发起任务。',
        '若是旧站升级并已有离线资料，可通过「补充资料」跳过原站克隆后恢复执行。',
      ],
    };
  }

  if (/ImportFromTemplate|UseTemplate|模板.*失败|模板市场|模板.*不存在|referenceTemplateSandbox/i.test(combined)) {
    return {
      headline: '选定的 Kooboo 模板未能成功导入',
      category: 'template-source',
      explanation: `系统尝试从 Kooboo 模板市场导入参考模板或初始化站点，但未能拿到完整的模板资源。${keepSiteSentence}`,
      userActions: [
        '核对对应 Kooboo 环境的模板市场是否能正常预览和打开该模板。',
        '如有需要，请在资料设置中更换另一个可用模板，再点击「恢复执行」。',
      ],
    };
  }

  if (/401|403|unauthorized|forbidden|token.*过期|登录.*失效|认证失败|凭据|授权失败/i.test(combined)) {
    return {
      headline: 'Kooboo 账号登录已失效或无操作权限',
      category: 'target-auth',
      explanation: `当前配置的 Kooboo 环境账号可能已过期，或没有权限访问目标站点与 Sandbox，自动化无法继续读写站点。${keepSiteSentence}`,
      userActions: [
        '前往左侧「设置 → Kooboo 环境」，重新登录或更新该环境的授权凭据。',
        '确认当前账号对该环境有建站和编辑权限后，回到本任务点击「恢复执行」。',
      ],
    };
  }

  if (/无法获取参考站|参考站预检|参考站.*(?:反爬|拦截|白屏|超时|不可达)/i.test(combined)) {
    return {
      headline: '无法获取参考站页面，已暂停等待决策',
      category: 'source-access',
      explanation: `系统在建站前预检参考站时未能拿到有效可渲染画面（可能超时、返回错误状态、被防火墙拦截或为空壳页）。为避免在缺少参考站的情况下烧 token 自由发挥，已提前暂停等待您的决定。${keepSiteSentence}`,
      userActions: [
        '点击「补充资料」，更换可公开访问的参考站 URL 后重新预检。',
        '或在「补充资料」手动上传参考站截图，并勾选「跳过外链预检并按截图还原」。',
        '如确认无需参考站，可在「补充资料」勾选「放弃参考站，授权 AI 自由设计」后恢复执行。',
      ],
    };
  }

  if (/pages\s*=\s*0|0\s*页|未确认有页面导入|内容站克隆|克隆未返回任务标识|Transfer\/|transferTaskId|sourceSandbox|无法抓取|抓取不到|反爬|验证码|登录墙|只读源站.*Sandbox|源站.*无法/i.test(combined)) {
    const roleSwapHint = /源站.*Sandbox|sourceSandbox/i.test(combined)
      ? '目标站点上的 Kooboo 模板本身不受影响，但供 AI 读取内容的只读源站没有拉取到任何页面。'
      : '系统自动访问原网站进行页面克隆后，未获取到任何可用页面，可能是原网址有误、站点暂不可访问或触发了防抓取限制。';
    return {
      headline: '无法从原网站抓取到页面，请核查源网址或手动导入',
      category: 'source-access',
      explanation: `${roleSwapHint}${keepSiteSentence}`,
      userActions: [
        '在浏览器中打开填入的原网址，确认页面能公开访问、没有验证码或登录拦截。',
        '如果原站开启了防抓取限制，可先手动把原站页面导入对应站点，再回来点击「恢复执行」。',
        '如果网址填写有误或原站已下线，请更换可访问的原站地址或改用上传资料文件后重新执行。',
      ],
    };
  }

  if (/Codex|api[_ ]?key|quota|insufficient|rate.?limit|余额|配额|429|模型.*无效|模型.*超时|Responses/i.test(combined)) {
    return {
      headline: 'AI 模型调用失败或账户额度不足',
      category: 'ai-model',
      explanation: `本地跟进/评测模型或 Kooboo AI 在调用模型服务时遇到配额、密钥或响应异常，任务已安全暂停。${keepSiteSentence}`,
      userActions: [
        '前往「设置」检查 AI 模型名称、接口地址与 API Key 是否有效且余额充足。',
        '确认模型服务恢复正常后，回到本任务点击「恢复执行」。',
      ],
    };
  }

  if (/环境.*不存在|环境.*不可用|连接.*失败|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|network/i.test(combined)) {
    return {
      headline: '网络或目标 Kooboo 环境暂时不可达',
      category: 'environment',
      explanation: `Automation Lab 在访问目标 Kooboo 服务或外部页面时发生网络连接失败或超时。${keepSiteSentence}`,
      userActions: [
        '检查当前网络及目标 Kooboo 环境服务是否正常运行。',
        '在「设置 → 环境测试」确认连接正常后，回到本任务点击「恢复执行」。',
      ],
    };
  }

  const stageMap: Record<string, string> = {
    prepare: '准备资料与输入阶段',
    generation: '站点生成阶段',
    handoff: '生成完成并准备交接评测',
    evaluation: '独立评测阶段',
    delivery: '跨环境交付阶段',
    optimization: '持续优化决策阶段',
  };
  const stageLabel = stageMap[input.stage || ''] || '执行过程';
  const cleanSummary = sanitizeHumanText(input.reason || input.error || '', 180);
  const explanation = cleanSummary
    ? `任务在${stageLabel}暂停，原因：${cleanSummary}。${keepSiteSentence}`
    : `任务在${stageLabel}遇到未完成的异常或等待人工确认，系统已自动暂停以避免无效消耗。${keepSiteSentence}`;

  const cleanSteps = (input.nextSteps || input.lastAction?.nextSteps || [])
    .map(step => sanitizeHumanText(step, 150))
    .filter(step => step.length >= 4);

  return {
    headline: cleanSummary ? `任务在${stageLabel}暂停：${sanitizeHumanText(cleanSummary, 48)}` : `任务在${stageLabel}暂停，需要人工介入`,
    category: 'runtime',
    explanation,
    userActions: cleanSteps.length
      ? cleanSteps.slice(0, 4)
      : [
          '如需要了解具体技术线索，可展开下方的「技术排障详情」查看最近操作和报错。',
          '确认站点或环境状态正常后，点击「恢复执行」继续当前阶段。',
        ],
  };
}

export function deriveEvaluationHumanSummary(report: {
  summary?: string;
  quality?: 'passed' | 'failed' | 'unverified';
  scores?: { viewport: string; value: number | null }[];
  issues?: { severity: 'critical' | 'major' | 'minor'; title: string; detail: string }[];
  coverage?: { verified?: string[]; unverified?: string[]; outOfScope?: string[] };
  assessments?: { criterionId: string; viewport: string; score: number | null; reason: string; passed: boolean | null }[];
  humanSummary?: EvaluationHumanSummary | null;
}): EvaluationHumanSummary {
  const existing = report.humanSummary;
  if (existing && VALID_VERDICTS.has(existing.verdict) && sanitizeHumanText(existing.headline, 120)) {
    return {
      verdict: existing.verdict,
      headline: sanitizeHumanText(existing.headline, 120),
      highlights: (existing.highlights || []).map(h => sanitizeHumanText(h, 160)).filter(Boolean).slice(0, 5),
      topFixes: (existing.topFixes || []).map(f => sanitizeHumanText(f, 180)).filter(Boolean).slice(0, 5),
      ...(existing.unverifiedNote ? { unverifiedNote: sanitizeHumanText(existing.unverifiedNote, 240) } : {}),
    };
  }

  const issues = report.issues || [];
  const criticalCount = issues.filter(i => i.severity === 'critical').length;
  const majorCount = issues.filter(i => i.severity === 'major').length;
  const minorCount = issues.filter(i => i.severity === 'minor').length;
  const numericScores = (report.scores || []).map(s => s.value).filter((v): v is number => typeof v === 'number');
  const minScore = numericScores.length ? Math.min(...numericScores) : null;
  const avgScore = numericScores.length
    ? Math.round((numericScores.reduce((a, b) => a + b, 0) / numericScores.length) * 10) / 10
    : null;
  const unverified = (report.coverage?.unverified || []).map(u => sanitizeHumanText(u, 140)).filter(Boolean);

  let verdict: EvaluationVerdict;
  if (criticalCount >= 2 || (report.quality === 'failed' && minScore !== null && minScore < 55)) {
    verdict = 'blocked';
  } else if (criticalCount > 0 || majorCount > 0 || report.quality === 'failed') {
    verdict = 'needs-fixes';
  } else if (report.quality === 'unverified') {
    verdict = 'incomplete-check';
  } else {
    verdict = 'ready';
  }

  const scorePhrase = avgScore !== null ? `（均分 ${avgScore}）` : '';
  let headline = '';
  if (verdict === 'ready') {
    headline = issues.length
      ? `整站核心效果已达标${scorePhrase}，仅有 ${minorCount} 处细节可顺手优化`
      : `整站页面、视觉与交互已通过独立评测${scorePhrase}，可直接用于展示或交付`;
  } else if (verdict === 'incomplete-check') {
    headline = `已核验的页面表现${avgScore !== null && avgScore >= 80 ? '良好' : '基本到位'}${scorePhrase}，但仍有 ${unverified.length || '部分'} 项未能验证`;
  } else if (verdict === 'needs-fixes') {
    headline = `站点主体已成型${scorePhrase}，建议优先解决 ${criticalCount + majorCount} 个明显问题后再交付`;
  } else {
    headline = `当前版本存在严重问题${scorePhrase}，暂不建议直接对外交付`;
  }

  const highlights: string[] = [];
  for (const s of report.scores || []) {
    if (typeof s.value === 'number' && s.value >= 80) {
      const label = s.viewport === 'desktop' ? '电脑端整体页面' : s.viewport === 'mobile' ? '手机端适配' : '业务功能';
      highlights.push(`${label}表现较好（${s.value} 分）`);
    }
  }
  const passedReasons = (report.assessments || [])
    .filter(a => a.passed === true && (a.score === null || a.score >= 85))
    .map(a => sanitizeHumanText(a.reason, 110))
    .filter(Boolean);
  for (const reason of passedReasons) {
    if (highlights.length >= 3) break;
    if (!highlights.includes(reason)) highlights.push(reason);
  }
  if (!highlights.length && report.summary) {
    const cleanSummary = sanitizeHumanText(report.summary, 140);
    if (cleanSummary) highlights.push(cleanSummary);
  }

  const severityOrder: Record<'critical' | 'major' | 'minor', number> = { critical: 0, major: 1, minor: 2 };
  const topFixes = [...issues]
    .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])
    .slice(0, 4)
    .map(issue => {
      const tag = issue.severity === 'critical' ? '严重' : issue.severity === 'major' ? '重要' : '细节';
      const title = sanitizeHumanText(issue.title, 70);
      const detail = sanitizeHumanText(issue.detail, 110);
      return detail && detail !== title ? `【${tag}】${title}：${detail}` : `【${tag}】${title}`;
    })
    .filter(Boolean);

  const unverifiedNote = unverified.length
    ? `本次共有 ${unverified.length} 项未完整核验（例如：${unverified.slice(0, 2).join('；')}），交付前请人工打开对应页面确认。`
    : undefined;

  return { verdict, headline, highlights, topFixes, ...(unverifiedNote ? { unverifiedNote } : {}) };
}
