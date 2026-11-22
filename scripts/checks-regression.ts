import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  applyBoundedVerdictCaps,
  buildBoundedCheckerPrompt,
  defaultOutOfScope,
} from '../server/automation/bounded-checker-rules.js';
import { createBoundedTurnOutputSchema } from '../server/automation/bounded-evaluator.js';
import {
  CheckerChecksStore,
  runChecksRegressionSuite,
  toAntiPatternRules,
} from '../server/automation/checker-checks.js';
import { codexClient } from '../server/automation/codex-client.js';
import { Database } from '../server/runtime.js';
import { Vault } from '../server/lib/vault.js';
import type { Criterion } from '../shared/automation.js';
import type { CheckerCalibrationCase, CheckerCheckRule } from '../shared/checker-checks.js';

interface CliArgs {
  dataDir: string;
  live: boolean;
  caseId: string;
}

function parseArgs(argv: string[]): CliArgs {
  let dataDir = '.data';
  let live = false;
  let caseId = '';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--live') live = true;
    else if (arg === '--deterministic') live = false;
    else if (arg === '--case' && argv[i + 1]) caseId = argv[++i];
    else if (arg === '--data-dir' && argv[i + 1]) dataDir = argv[++i];
  }
  return { dataDir: resolve(dataDir), live, caseId };
}

function loadRulesAndCalibrations(dataDir: string): {
  rules: CheckerCheckRule[];
  calibrations: CheckerCalibrationCase[];
  sourceLabel: string;
} {
  const dbPath = resolve(dataDir, 'database.sqlite');
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const hasTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auto_checker_checks'")
        .get();
      if (hasTable) {
        const rules = (
          db.prepare('SELECT json FROM auto_checker_checks ORDER BY created_at ASC, id ASC').all() as Array<{
            json: string;
          }>
        ).map(row => JSON.parse(row.json) as CheckerCheckRule);
        const calibrations = (
          db.prepare('SELECT json FROM auto_checker_calibrations ORDER BY created_at ASC, id ASC').all() as Array<{
            json: string;
          }>
        ).map(row => JSON.parse(row.json) as CheckerCalibrationCase);
        if (rules.length > 0) {
          return { rules, calibrations, sourceLabel: dbPath };
        }
      }
    } finally {
      db.close();
    }
  }

  const memDb = new Database(':memory:');
  const seedStore = new CheckerChecksStore(memDb);
  const rules = seedStore.listRules();
  const calibrations = seedStore.listCalibrations();
  memDb.close();
  return { rules, calibrations, sourceLabel: 'builtin-seeds(:memory:)' };
}

async function runLiveCase(
  dataDir: string,
  caseId: string,
  rules: CheckerCheckRule[],
  calibrations: CheckerCalibrationCase[],
): Promise<number> {
  if (!caseId) {
    console.error('请通过 --case <caseId> 指定包含真实截图的标定用例 ID');
    return 1;
  }
  const cal = calibrations.find(c => c.id === caseId);
  if (!cal) {
    console.error(`未找到标定用例：${caseId}`);
    return 1;
  }
  if (!cal.sourceReportId || !cal.evidenceFiles.length) {
    console.error(`用例 ${caseId} 仅包含合成夹具，缺少真实磁盘 PNG 截图；遵循真实图片识图约定，拒绝用假图片运行 --live。`);
    return 1;
  }

  const imageInputs: Array<{ type: 'local_image'; path: string }> = [];
  const manifestLines: string[] = [];
  for (const name of cal.evidenceFiles) {
    const abs = resolve(dataDir, 'automation-runs', cal.sourceReportId, 'evidence', name);
    if (!existsSync(abs)) {
      console.error(`真实截图不存在：${abs}`);
      return 1;
    }
    const header = readFileSync(abs).subarray(0, 8).toString('hex');
    if (header !== '89504e470d0a1a0a') {
      console.error(`文件不是有效 PNG：${abs}`);
      return 1;
    }
    imageInputs.push({ type: 'local_image', path: abs });
    manifestLines.push(`${name} (role=target, viewport=${cal.viewport === 'mobile' ? 'mobile' : 'desktop'})`);
  }

  const dbPath = resolve(dataDir, 'database.sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const vault = new Vault(db, dataDir);
  const automationSettings = vault.automation();
  const runtimeSettings = vault.get();
  const apiKey = runtimeSettings.model.apiKey;
  const endpoint = automationSettings.evaluationEndpoint || runtimeSettings.model.endpoint;
  const modelName = automationSettings.evaluationModel || runtimeSettings.model.name;
  db.close();

  if (!apiKey || !endpoint) {
    console.error('缺少模型配置（endpoint 或 apiKey）');
    return 1;
  }

  const activeRules = toAntiPatternRules(
    rules.filter(r => r.enabled && r.scenarios.includes(cal.scenario) && r.scopes.includes(cal.scope)),
  );
  const criteria: Criterion[] = [
    {
      id: 'hero',
      label: 'Hero 首屏',
      weight: 40,
      instruction: '首屏构图、主体视觉与 CTA 层级。',
      required: false,
      viewports: [cal.viewport === 'mobile' ? 'mobile' : 'desktop'],
      scopes: [cal.scope],
    },
    {
      id: 'structure',
      label: '页面结构',
      weight: 40,
      instruction: '区段顺序与响应式布局。',
      required: false,
      viewports: [cal.viewport === 'mobile' ? 'mobile' : 'desktop'],
      scopes: [cal.scope],
    },
    {
      id: 'sections',
      label: '其他区段',
      weight: 20,
      instruction: '内容展示与配图质感。',
      required: false,
      viewports: [cal.viewport === 'mobile' ? 'mobile' : 'desktop'],
      scopes: [cal.scope],
    },
  ];
  const presetOutOfScope = defaultOutOfScope({
    scenario: cal.scenario,
    scope: cal.scope,
    hasReference: false,
    hasMaterials: cal.scenario === 'materials',
  });
  const prompt = buildBoundedCheckerPrompt({
    scenario: cal.scenario,
    scope: cal.scope,
    siteUrl: cal.sourceSiteUrl || 'https://live-regression.localkooboo.test/',
    description: cal.title,
    criteria,
    presetOutOfScope,
    imageManifestLines: manifestLines,
    hasReference: false,
    viewports: cal.viewport === 'both' ? ['desktop', 'mobile'] : [cal.viewport],
    antiPatternRules: activeRules,
  });

  const turnSchema = createBoundedTurnOutputSchema(activeRules.map(r => r.id));
  const work = resolve(tmpdir(), `checks-live-${Date.now()}`);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  try {
    const client = codexClient(work, endpoint, apiKey);
    const thread = client.startThread({
      model: modelName,
      workingDirectory: work,
      skipGitRepoCheck: true,
      sandboxMode: 'read-only',
      networkAccessEnabled: false,
      approvalPolicy: 'never',
      webSearchMode: 'disabled',
    });
    const turn = await thread.runStreamed(
      [{ type: 'text', text: prompt }, ...imageInputs],
      { outputSchema: z.toJSONSchema(turnSchema) },
    );
    let reply = '';
    for await (const event of turn.events) {
      if (event.type === 'item.completed' && event.item.type === 'agent_message') {
        reply = event.item.text;
      }
    }
    const parsed = turnSchema.parse(JSON.parse(reply));
    const verdict = applyBoundedVerdictCaps({
      assessments: parsed.assessments,
      issues: parsed.issues,
      criteria,
      threshold: 85,
      coverage: parsed.coverage,
      presetOutOfScope,
      humanSummary: parsed.humanSummary,
      antiPatternRules: activeRules,
    });
    const matched = verdict.quality === cal.expected.quality;
    console.log(
      JSON.stringify(
        {
          caseId: cal.id,
          ruleId: cal.ruleId,
          expectedQuality: cal.expected.quality,
          observedQuality: verdict.quality,
          scores: verdict.scores,
          issues: verdict.issues.map(i => `${i.severity} ${i.ruleId || ''}: ${i.title}`),
          capNotes: verdict.capNotes,
          passed: matched,
        },
        null,
        2,
      ),
    );
    return matched ? 0 : 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { rules, calibrations, sourceLabel } = loadRulesAndCalibrations(args.dataDir);
  if (args.live) {
    process.exitCode = await runLiveCase(args.dataDir, args.caseId, rules, calibrations);
    return;
  }

  const report = runChecksRegressionSuite(rules, calibrations, args.dataDir);
  console.log(`[CHECKS 回归验证] 数据源：${sourceLabel}`);
  console.log(`[CHECKS 回归验证] 快照哈希：#${report.checksHash.slice(0, 12)} | 结果：${report.passed}/${report.total} 通过`);
  for (const item of report.results) {
    const mark = item.passed ? 'PASS' : 'FAIL';
    const scores = item.observedScores.map(s => `${s.viewport}:${s.value ?? 'null'}`).join(' ');
    console.log(`- [${mark}] ${item.caseId} (${item.ruleId}, ${item.kind}, evidence=${item.evidenceStatus}) -> ${item.observedQuality} (${scores})`);
    if (!item.passed) {
      for (const a of item.assertions.filter(x => !x.passed)) {
        console.log(`    x ${a.name}: ${a.detail}`);
      }
    }
  }
  process.exitCode = report.failed === 0 ? 0 : 1;
}

await main();
