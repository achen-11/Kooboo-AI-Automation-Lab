import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { AutomationTask, MaterialFile, ResourceInput } from '../shared/automation.js';
import type { PriceSnapshot } from '../shared/billing.js';
import {
  applyBoundedVerdictCaps,
  buildBoundedCheckerPrompt,
  defaultOutOfScope,
  type BoundedIssue,
} from '../server/automation/bounded-checker-rules.js';
import { calculateUsage, initialPrice } from '../server/automation/billing.js';
import { codexClient } from '../server/automation/codex-client.js';

interface CliArgs {
  task: string;
  dataDir: string;
  maxImages: number;
  live: boolean;
}

interface ObservationMeta {
  action?: string;
  role?: string;
  viewport?: string;
  url?: string;
  capturedAt?: number;
  position?: { scrollY?: number; viewportWidth?: number; viewportHeight?: number; documentHeight?: number };
}

export interface SelectedImage {
  name: string;
  absPath: string;
  role: 'target' | 'reference';
  viewport: 'desktop' | 'mobile';
  sizeBytes: number;
  width: number | null;
  height: number | null;
  scrollY: number | null;
  action: string;
  url: string;
}

interface HistoricalMetrics {
  taskId: string;
  resourceName: string;
  scenario: string;
  scope: string;
  evalReqs: number;
  evalCny: number;
  evalMissingCny: number;
  evalModelMins: number;
  evalSpanMins: number;
  totalReqs: number;
  totalCny: number;
  totalSpanMins: number;
  quality: string;
  scores: { viewport: string; value: number | null }[];
  issueCount: number;
  verdict: string;
  heroDesktopScore: number | null;
  heroMobileScore: number | null;
  unverifiedCount: number;
}

const boundedIssueSchema = z
  .object({
    severity: z.enum(['critical', 'major', 'minor']),
    ruleId: z.enum(['R-VISUAL-01', 'R-VISUAL-02', 'R-LAYOUT-03', 'R-COVER-04']).nullable(),
    viewport: z.enum(['desktop', 'mobile', 'both']),
    criterionId: z.string().min(1).nullable(),
    title: z.string().min(1).max(200),
    detail: z.string().min(1).max(2000),
    evidence: z.array(z.string().min(1)).min(1).max(20),
  })
  .strict();

const boundedOutputSchema = z
  .object({
    summary: z.string().min(1).max(4000),
    assessments: z
      .array(
        z
          .object({
            criterionId: z.string().min(1),
            viewport: z.enum(['desktop', 'mobile', 'business']),
            score: z.number().min(0).max(100).nullable(),
            reason: z.string().min(1).max(1500),
            evidence: z.array(z.string().min(1)),
            passed: z.boolean().nullable(),
          })
          .strict(),
      )
      .max(30),
    issues: z.array(boundedIssueSchema).max(60),
    coverage: z
      .object({
        verified: z.array(z.string()),
        unverified: z.array(z.string()),
        outOfScope: z.array(z.string()),
      })
      .strict(),
    humanSummary: z
      .object({
        verdict: z.enum(['ready', 'needs-fixes', 'blocked', 'incomplete-check']),
        headline: z.string().min(1).max(300),
        highlights: z.array(z.string().min(1).max(300)).max(6),
        topFixes: z.array(z.string().min(1).max(400)).max(6),
        unverifiedNote: z.string().max(500).nullable(),
      })
      .strict(),
  })
  .strict();

function parseArgs(argv: string[]): CliArgs {
  let task = '';
  let dataDir = '.data';
  let maxImages = 8;
  let live = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--task' && argv[i + 1]) {
      task = argv[++i];
    } else if (arg === '--data-dir' && argv[i + 1]) {
      dataDir = argv[++i];
    } else if (arg === '--max-images' && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 24) throw new Error('--max-images must be integer 1..24');
      maxImages = n;
    } else if (arg === '--live') {
      live = true;
    } else if (arg === '--dry-run') {
      live = false;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node --import tsx scripts/phase0-bounded-checker-bench.ts --task <idOrPrefix> [--data-dir .data] [--max-images 8] [--dry-run | --live]',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete flag: ${arg}`);
    }
  }
  if (!task) throw new Error('Missing required --task <idOrPrefix>');
  return { task, dataDir: resolve(dataDir), maxImages, live };
}

export function readPngDimensions(filePath: string): { width: number; height: number } | null {
  const fd = openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(24);
    const bytesRead = readSync(fd, header, 0, 24, 0);
    if (bytesRead < 24) return null;
    if (
      header.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      header.subarray(12, 16).toString('ascii') !== 'IHDR'
    ) {
      return null;
    }
    return {
      width: header.readUInt32BE(16),
      height: header.readUInt32BE(20),
    };
  } finally {
    closeSync(fd);
  }
}

function unionMinutes(intervals: [number, number][]): number {
  if (!intervals.length) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [a, b] = sorted[i];
    if (a <= curEnd) curEnd = Math.max(curEnd, b);
    else {
      total += curEnd - curStart;
      curStart = a;
      curEnd = b;
    }
  }
  return Math.round(((total + (curEnd - curStart)) / 60000) * 10) / 10;
}

function resolveRunDirectory(dataDir: string, prefix: string): { taskId: string; runDir: string } {
  const runsRoot = resolve(dataDir, 'automation-runs');
  const entries = readdirSync(runsRoot, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith(prefix))
    .map(e => e.name);
  if (entries.length === 0) throw new Error(`No run directory matching prefix "${prefix}" under ${runsRoot}`);
  if (entries.length > 1) {
    const exact = entries.find(e => e === prefix);
    if (!exact) throw new Error(`Ambiguous prefix "${prefix}": matched ${entries.join(', ')}`);
    return { taskId: exact, runDir: resolve(runsRoot, exact) };
  }
  return { taskId: entries[0], runDir: resolve(runsRoot, entries[0]) };
}

function selectRepresentativeImages(runDir: string, maxImages: number): SelectedImage[] {
  const manifestPath = resolve(runDir, 'evidence-manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`Missing evidence-manifest.json at ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as MaterialFile[];
  const evidenceDir = resolve(runDir, 'evidence');

  const seenHashes = new Set<string>();
  const buckets = new Map<string, (SelectedImage & { capturedAt: number; priority: number })[]>();

  for (const file of manifest) {
    if (file.type !== 'image/png') continue;
    if (file.role !== 'target' && file.role !== 'reference') continue;
    if (file.viewport !== 'desktop' && file.viewport !== 'mobile') continue;
    if (seenHashes.has(file.sha256)) continue;
    const absPath = resolve(evidenceDir, file.name);
    if (!existsSync(absPath)) continue;
    seenHashes.add(file.sha256);

    let obs: ObservationMeta = {};
    const obsPath = resolve(evidenceDir, file.name.replace(/\.png$/, '.json'));
    if (existsSync(obsPath)) {
      try {
        obs = JSON.parse(readFileSync(obsPath, 'utf8')) as ObservationMeta;
      } catch {
        obs = {};
      }
    }

    const dims = readPngDimensions(absPath);
    const stat = statSync(absPath);
    const action = obs.action || 'unknown';
    const scrollY = typeof obs.position?.scrollY === 'number' ? obs.position.scrollY : null;
    const capturedAt = typeof obs.capturedAt === 'number' ? obs.capturedAt : 0;
    const priority = action === 'take_page_screenshots' ? 0 : action === 'snapshot' || action === 'screenshot' ? 1 : 2;
    const key = `${file.role}:${file.viewport}`;
    const list = buckets.get(key) || [];
    list.push({
      name: file.name,
      absPath,
      role: file.role,
      viewport: file.viewport,
      sizeBytes: stat.size,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      scrollY,
      action,
      url: obs.url || '',
      capturedAt,
      priority,
    });
    buckets.set(key, list);
  }

  const orderedKeys = (['target:desktop', 'target:mobile', 'reference:desktop', 'reference:mobile'] as const).filter(
    k => (buckets.get(k)?.length || 0) > 0,
  );
  if (!orderedKeys.length) return [];

  const baseQuota = Math.floor(maxImages / orderedKeys.length);
  let remainder = maxImages % orderedKeys.length;
  const quotas = new Map<string, number>();
  for (const k of orderedKeys) {
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder--;
    quotas.set(k, baseQuota + extra);
  }

  const selected: SelectedImage[] = [];
  for (const k of orderedKeys) {
    const items = buckets.get(k)!;
    const quota = quotas.get(k) || 0;
    if (quota <= 0) continue;

    // Prefer take_page_screenshots when present; otherwise use chronological capture order.
    const paged = items.filter(i => i.action === 'take_page_screenshots');
    const pool = paged.length >= Math.min(2, items.length) ? paged : items;
    pool.sort((a, b) => {
      if (a.scrollY !== null && b.scrollY !== null && a.scrollY !== b.scrollY) return a.scrollY - b.scrollY;
      return a.capturedAt - b.capturedAt || a.name.localeCompare(b.name);
    });

    if (pool.length <= quota) {
      for (const item of pool) selected.push(stripMeta(item));
    } else if (quota === 1) {
      selected.push(stripMeta(pool[0]));
    } else {
      const pickedIndices = new Set<number>([0, pool.length - 1]);
      for (let slot = 1; slot < quota - 1; slot++) {
        const idx = Math.round((slot * (pool.length - 1)) / (quota - 1));
        pickedIndices.add(idx);
      }
      for (let i = 0; i < pool.length && pickedIndices.size < quota; i++) pickedIndices.add(i);
      for (const idx of [...pickedIndices].sort((a, b) => a - b)) {
        selected.push(stripMeta(pool[idx]));
      }
    }
  }
  return selected;
}

function stripMeta(item: SelectedImage & { capturedAt: number; priority: number }): SelectedImage {
  const { capturedAt: _c, priority: _p, ...clean } = item;
  return clean;
}

function loadHistoricalMetrics(dataDir: string, taskId: string, taskJsonTask: AutomationTask): HistoricalMetrics {
  const dbPath = resolve(dataDir, 'database.sqlite');
  let dbTask: AutomationTask | undefined;
  let evalReqs = 0;
  let evalCny = 0;
  let evalMissingCny = 0;
  let totalReqs = 0;
  let totalCny = 0;
  const evalIntervals: [number, number][] = [];
  const evalSpanIntervals: [number, number][] = [];
  const allSpanIntervals: [number, number][] = [];

  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const taskRow = db.prepare('SELECT json FROM auto_tasks WHERE id = ?').get(taskId) as
        | { json: string }
        | undefined;
      if (taskRow) dbTask = JSON.parse(taskRow.json) as AutomationTask;

      const usageRows = db.prepare('SELECT json FROM auto_usage WHERE task_id = ?').all(taskId) as { json: string }[];
      for (const row of usageRows) {
        const u = JSON.parse(row.json) as {
          stage?: string;
          cny?: number | null;
          startedAt?: number;
          endedAt?: number;
        };
        totalReqs++;
        if (typeof u.cny === 'number') totalCny += u.cny;
        if (u.stage === 'evaluation') {
          evalReqs++;
          if (typeof u.cny === 'number') evalCny += u.cny;
          else evalMissingCny++;
          if (u.startedAt && u.endedAt && u.endedAt >= u.startedAt) {
            evalIntervals.push([u.startedAt, u.endedAt]);
          }
        }
      }

      const spanRows = db
        .prepare('SELECT stage, started_at, ended_at, heartbeat FROM auto_timing_spans WHERE task_id = ?')
        .all(taskId) as { stage: string; started_at: number; ended_at: number | null; heartbeat: number }[];
      for (const s of spanRows) {
        const end = s.ended_at ?? s.heartbeat;
        if (s.started_at && end && end >= s.started_at) {
          allSpanIntervals.push([s.started_at, end]);
          if (s.stage === 'evaluation') evalSpanIntervals.push([s.started_at, end]);
        }
      }
    } finally {
      db.close();
    }
  }

  const effective = dbTask || taskJsonTask;
  const rep = effective.report;
  const heroDesktopScore =
    rep?.assessments.find(a => a.criterionId === 'hero' && a.viewport === 'desktop')?.score ?? null;
  const heroMobileScore =
    rep?.assessments.find(a => a.criterionId === 'hero' && a.viewport === 'mobile')?.score ?? null;

  return {
    taskId,
    resourceName: effective.resourceName,
    scenario: effective.scenario,
    scope: effective.scope,
    evalReqs,
    evalCny: Math.round(evalCny * 10000) / 10000,
    evalMissingCny,
    evalModelMins: unionMinutes(evalIntervals),
    evalSpanMins: unionMinutes(evalSpanIntervals),
    totalReqs,
    totalCny: Math.round(totalCny * 10000) / 10000,
    totalSpanMins: unionMinutes(allSpanIntervals),
    quality: rep?.quality || 'none',
    scores: rep?.scores || [],
    issueCount: rep?.issues.length ?? 0,
    verdict: rep?.humanSummary?.verdict || 'none',
    heroDesktopScore,
    heroMobileScore,
    unverifiedCount: rep?.coverage.unverified.length ?? 0,
  };
}

function loadPriceSnapshots(dataDir: string): PriceSnapshot[] {
  const dbPath = resolve(dataDir, 'database.sqlite');
  if (!existsSync(dbPath)) return [initialPrice];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT json FROM auto_prices ORDER BY rowid').all() as { json: string }[];
    return rows.length ? rows.map(r => JSON.parse(r.json) as PriceSnapshot) : [initialPrice];
  } catch {
    return [initialPrice];
  } finally {
    db.close();
  }
}

function formatScoreMap(scores: { viewport: string; value: number | null }[]): string {
  return scores.map(s => `${s.viewport}=${s.value ?? 'null'}`).join(', ') || 'none';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { taskId, runDir } = resolveRunDirectory(args.dataDir, args.task);
  const taskFile = JSON.parse(readFileSync(resolve(runDir, 'task.json'), 'utf8')) as {
    task: AutomationTask;
    input: ResourceInput;
  };
  const task = taskFile.task;
  const input = taskFile.input;
  const criteria = task.rule?.criteria || [];
  if (!criteria.length) throw new Error(`Task ${taskId} has no frozen rule criteria in task.json`);

  const hasReference = Boolean(input.referenceUrl?.trim() || input.referenceTemplateId?.trim());
  const hasMaterials = Boolean(input.files?.length);
  const presetOutOfScope = defaultOutOfScope({
    scenario: task.scenario,
    scope: task.scope,
    hasReference,
    hasMaterials,
    hasBackendAccess: false,
  });

  const selectedImages = selectRepresentativeImages(runDir, args.maxImages);
  if (!selectedImages.length) throw new Error(`No selectable target/reference PNGs found in ${runDir}`);

  const imageManifestLines = selectedImages.map(
    img =>
      `${img.name} (role=${img.role}, viewport=${img.viewport}, ${img.width ?? '?'}x${img.height ?? '?'}, action=${img.action}${
        img.scrollY !== null ? `, scrollY=${img.scrollY}` : ''
      })`,
  );

  const prompt = buildBoundedCheckerPrompt({
    scenario: task.scenario,
    scope: task.scope,
    siteUrl: task.siteUrl,
    description: input.description || task.message || '',
    criteria,
    presetOutOfScope,
    precheckDigest: '（Phase 0A 离线历史盘面模式：未提供实时 DOM 预检摘要，请直接严格审视下方附带的真实 PNG 截图！）',
    imageManifestLines,
    hasReference,
  });

  const hist = loadHistoricalMetrics(args.dataDir, taskId, task);
  const jsonSchema = z.toJSONSchema(boundedOutputSchema);

  console.log(`\n=== Phase 0A Bounded Checker Bench [${args.live ? 'LIVE' : 'DRY-RUN'}] ===`);
  console.log(`Task: ${hist.taskId} | ${hist.resourceName} | ${hist.scenario}/${hist.scope}`);
  console.log(
    `Historical Baseline -> quality=${hist.quality}, verdict=${hist.verdict}, scores=[${formatScoreMap(
      hist.scores,
    )}], hero(D/M)=${hist.heroDesktopScore}/${hist.heroMobileScore}, issues=${hist.issueCount}, unverified=${
      hist.unverifiedCount
    }`,
  );
  console.log(
    `Historical Cost/Eff -> evalOnly: ${hist.evalReqs} req, ¥${hist.evalCny.toFixed(4)} (miss=${
      hist.evalMissingCny
    }), modelTime=${hist.evalModelMins}m, spanTime=${hist.evalSpanMins}m | wholeTask: ${hist.totalReqs} req, ¥${hist.totalCny.toFixed(
      4,
    )}, spanTime=${hist.totalSpanMins}m`,
  );
  console.log(`\nSelected PNGs (${selectedImages.length}/${args.maxImages}):`);
  for (const img of selectedImages) {
    console.log(
      `  - ${img.name} | ${img.role}/${img.viewport} | ${img.width ?? '?'}x${img.height ?? '?'} | ${(
        img.sizeBytes / 1024
      ).toFixed(1)} KB | ${img.action}${img.scrollY !== null ? ` y=${img.scrollY}` : ''}`,
    );
  }
  console.log(`\nAssembled Prompt: ${prompt.length} chars (~${Math.ceil(prompt.length / 2)} rough tokens)`);
  console.log(`Strict outputSchema properties: ${Object.keys((jsonSchema as { properties?: object }).properties || {}).join(', ')}`);

  if (!args.live) {
    console.log('\n[DRY-RUN] Skipped Vault decryption and Codex API call. Pass --live to execute real-image check.');
    return;
  }

  // Dynamically load Vault only in --live mode so --dry-run never touches encrypted credentials.
  const { Vault } = await import('../server/lib/vault.js');
  const vault = new Vault(args.dataDir);
  const settings = vault.automation();
  const runtime = vault.get();
  const modelName = task.model?.name || settings.evaluationModel;
  const endpoint = task.model?.endpoint || settings.evaluationEndpoint || runtime.model.endpoint;
  if (!endpoint) throw new Error('Missing evaluation endpoint in Vault/task settings');

  const tmpWork = resolve(tmpdir(), `phase0-bench-${Date.now()}`);
  mkdirSync(tmpWork, { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  let turnUsage: Record<string, unknown> | null = null;
  let finalText = '';
  let streamError: Error | undefined;

  try {
    const client = codexClient(vault, args.dataDir, {}, { name: modelName, endpoint });
    const thread = client.startThread({
      model: modelName,
      workingDirectory: tmpWork,
      skipGitRepoCheck: true,
      sandboxMode: 'read-only',
      networkAccessEnabled: false,
      approvalPolicy: 'never',
      webSearchMode: 'disabled',
    });

    const userInputs = [
      { type: 'text' as const, text: prompt },
      ...selectedImages.map(img => ({ type: 'local_image' as const, path: img.absPath })),
    ];

    const stream = await thread.runStreamed(userInputs, {
      outputSchema: jsonSchema,
      signal: AbortSignal.timeout(180000),
    });

    for await (const event of stream.events) {
      if (event.type === 'turn.completed') {
        turnUsage = event.usage as unknown as Record<string, unknown>;
      } else if (event.type === 'turn.failed') {
        streamError = new Error(event.error.message);
      } else if (event.type === 'error') {
        streamError = new Error(event.message);
      } else if (event.type === 'item.completed' && event.item.type === 'agent_message') {
        finalText = event.item.text;
      }
    }
  } finally {
    rmSync(tmpWork, { recursive: true, force: true });
  }

  const endedAt = Date.now();
  if (streamError) throw streamError;
  if (!finalText) throw new Error('Model returned empty agent_message');

  const parsed = boundedOutputSchema.parse(JSON.parse(finalText));
  const selectedNames = new Set(selectedImages.map(i => i.name));
  const sanitizeEvidence = (ev: string[]) => {
    const kept = ev.filter(name => selectedNames.has(name));
    return kept.length ? kept : [selectedImages[0].name];
  };

  const threshold = task.rule?.criteria.length ? vault.get().threshold : 80;
  const verdict = applyBoundedVerdictCaps({
    assessments: parsed.assessments.map(a => ({ ...a, evidence: sanitizeEvidence(a.evidence) })),
    issues: parsed.issues.map(i => ({ ...i, evidence: sanitizeEvidence(i.evidence) }) as BoundedIssue),
    criteria,
    threshold,
    coverage: parsed.coverage,
    presetOutOfScope,
    humanSummary: {
      verdict: parsed.humanSummary.verdict,
      headline: parsed.humanSummary.headline,
      highlights: parsed.humanSummary.highlights,
      topFixes: parsed.humanSummary.topFixes,
      ...(parsed.humanSummary.unverifiedNote ? { unverifiedNote: parsed.humanSummary.unverifiedNote } : {}),
    },
  });

  const prices = loadPriceSnapshots(args.dataDir);
  const matchedPrice = prices.find(p => p.models.includes(modelName)) || null;
  const usageEntry = calculateUsage(
    {
      id: `phase0-${Date.now()}`,
      source: 'codex',
      stage: 'evaluation',
      model: modelName,
      endpoint,
      startedAt,
      endedAt,
      status: 'completed',
      basis: 'sdk-turn',
      raw: turnUsage,
    },
    taskId,
    matchedPrice,
  );

  const elapsedSec = Math.round(((endedAt - startedAt) / 1000) * 10) / 10;
  const outDir = resolve(args.dataDir, 'visual-experiments');
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const outPath = resolve(outDir, `phase0-${taskId.slice(0, 8)}-${Date.now()}.json`);
  const artifact = {
    mode: 'live',
    model: modelName,
    elapsedSec,
    usage: usageEntry,
    selectedImages: selectedImages.map(({ absPath: _abs, ...rest }) => rest),
    historicalBaseline: hist,
    rawModelOutput: parsed,
    boundedVerdict: verdict,
  };
  writeFileSync(outPath, JSON.stringify(artifact, null, 2), { mode: 0o600 });

  const newHeroD = verdict.assessments.find(a => a.criterionId === 'hero' && a.viewport === 'desktop')?.score ?? null;
  const newHeroM = verdict.assessments.find(a => a.criterionId === 'hero' && a.viewport === 'mobile')?.score ?? null;

  console.log('\n=== A/B Comparison Result ===');
  console.log(`Model: ${modelName} | Elapsed: ${elapsedSec}s | Estimated Cost: ${usageEntry.cny !== null ? `¥${usageEntry.cny.toFixed(4)}` : 'unpriced'}`);
  if (usageEntry.tokens) {
    console.log(
      `Tokens: input=${usageEntry.tokens.input} (cached=${usageEntry.tokens.cached ?? '?'}), output=${usageEntry.tokens.output} (reasoning=${usageEntry.tokens.reasoning ?? '?'})`,
    );
  }
  console.log(`Old -> quality=${hist.quality} | verdict=${hist.verdict} | scores=[${formatScoreMap(hist.scores)}] | hero(D/M)=${hist.heroDesktopScore}/${hist.heroMobileScore} | req=${hist.evalReqs} | time=${hist.evalSpanMins}m | cost=¥${hist.evalCny.toFixed(4)}`);
  console.log(`New -> quality=${verdict.quality} | verdict=${verdict.humanSummary?.verdict} | scores=[${formatScoreMap(verdict.scores)}] (raw: ${formatScoreMap(verdict.rawScores)}) | hero(D/M)=${newHeroD}/${newHeroM} | turn=1 | time=${elapsedSec}s | cost=${usageEntry.cny !== null ? `¥${usageEntry.cny.toFixed(4)}` : 'unpriced'}`);
  if (verdict.capNotes.length) {
    console.log('Host Caps Applied:');
    for (const note of verdict.capNotes) console.log(`  - ${note}`);
  }
  console.log(`Issues (${verdict.issues.length}):`);
  for (const iss of verdict.issues) {
    console.log(`  - [${iss.severity}${iss.ruleId ? '/' + iss.ruleId : ''}] (${iss.viewport}) ${iss.title}`);
  }
  console.log(`Saved full JSON to ${outPath}`);
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isEntrypoint) {
  main().catch(err => {
    console.error('[phase0-bench error]', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
