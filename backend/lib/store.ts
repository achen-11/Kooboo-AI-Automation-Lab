import { Database as DatabaseSync } from '../runtime.js';
import { createHash, randomUUID } from '../runtime.js';
import type { Evaluation, Report, RuleDraft, RuleSet, Run, Submission } from '../shared/types.js';
import { hashRule, parseRule } from './rules.js';
import { normalizeSiteDomain, siteDomainFromUrl } from './site-domain.js';

export class Conflict extends Error {}
export class LostLease extends Error {}
export class Store {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS evaluations (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
        job_id TEXT NOT NULL, occurred_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
        submission TEXT NOT NULL, target_url TEXT, payload_hash TEXT NOT NULL,
        current_run_id TEXT NOT NULL, UNIQUE(project_id, attempt_id)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, evaluation_id TEXT NOT NULL REFERENCES evaluations(id),
        status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        error TEXT, report TEXT, evidence TEXT, snapshot TEXT,
        lease_owner TEXT, lease_until INTEGER, claims INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS queue_status ON runs(status, created_at);
      CREATE INDEX IF NOT EXISTS evaluation_job ON evaluations(project_id, job_id, occurred_at);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
        occurred_at INTEGER NOT NULL, message TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), decision TEXT NOT NULL,
        note TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rule_versions (version TEXT PRIMARY KEY, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rule_drafts (
        id TEXT PRIMARY KEY, rule_json TEXT NOT NULL, revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, published_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS sites (
        project_id TEXT NOT NULL, domain TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(project_id, domain)
      );
    `);
    if (!this.db.prepare('PRAGMA table_info(rule_versions)').all().some((column) => column.name === 'rule_json')) this.db.exec('ALTER TABLE rule_versions ADD COLUMN rule_json TEXT');
    this.tx(() => {
      if (!this.db.prepare('PRAGMA table_info(evaluations)').all().some((column) => column.name === 'site_domain')) {
        this.db.exec('ALTER TABLE evaluations ADD COLUMN site_domain TEXT');
        const legacy = this.db.prepare('SELECT e.id,e.target_url,r.evidence FROM evaluations e JOIN runs r ON e.current_run_id=r.id').all();
        for (const row of legacy) {
          try {
            const url = row.target_url || (row.evidence ? JSON.parse(String(row.evidence)).targetUrl : null);
            if (typeof url === 'string') this.assignSite(String(row.id), siteDomainFromUrl(url));
          } catch { /* 缺少可验证访问地址的旧任务保持待解析，不使用来源或环境域名补齐。 */ }
        }
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS evaluation_site ON evaluations(project_id,site_domain,occurred_at); PRAGMA user_version=3;');
    });
  }
  close(): void { this.db.close(); }
  private tx<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  registerRule(version: string, hash: string, rule?: RuleSet): void {
    const found = this.db.prepare('SELECT hash FROM rule_versions WHERE version=?').get(version);
    if (found && found.hash !== hash) throw new Conflict('规则版本内容已变化，请发布新版本；历史规则不能原地覆盖');
    if (rule && (rule.version !== version || hashRule(rule) !== hash)) throw new Conflict('规则内容与版本指纹不匹配');
    this.db.prepare('INSERT OR IGNORE INTO rule_versions (version,hash,rule_json) VALUES (?,?,?)').run(version, hash, rule ? JSON.stringify(rule) : null);
    if (rule) this.db.prepare('UPDATE rule_versions SET rule_json=? WHERE version=? AND rule_json IS NULL').run(JSON.stringify(rule), version);
  }
  getRule(version: string): { rule: RuleSet; hash: string } | null {
    const row = this.db.prepare('SELECT hash,rule_json FROM rule_versions WHERE version=?').get(version);
    return row?.rule_json ? { rule: JSON.parse(String(row.rule_json)), hash: String(row.hash) } : null;
  }
  rules(): { rule: RuleSet; hash: string }[] {
    return this.db.prepare('SELECT version FROM rule_versions WHERE rule_json IS NOT NULL ORDER BY rowid').all().map((row) => this.getRule(String(row.version))!);
  }
  private decodeDraft(row: Record<string, unknown>): RuleDraft {
    return { id: String(row.id), rule: JSON.parse(String(row.rule_json)), revision: Number(row.revision), updatedAt: Number(row.updated_at), publishedAt: row.published_at == null ? null : Number(row.published_at) };
  }
  draft(id: string): RuleDraft | null {
    const row = this.db.prepare('SELECT * FROM rule_drafts WHERE id=?').get(id);
    return row ? this.decodeDraft(row) : null;
  }
  drafts(): RuleDraft[] {
    return this.db.prepare('SELECT * FROM rule_drafts WHERE published_at IS NULL ORDER BY updated_at DESC,rowid DESC').all().map((row) => this.decodeDraft(row));
  }
  createDraft(rule: RuleSet): RuleDraft {
    const parsed = parseRule(rule, false), id = randomUUID();
    this.db.prepare('INSERT INTO rule_drafts VALUES (?,?,1,?,NULL)').run(id, JSON.stringify(parsed), Date.now());
    return this.draft(id)!;
  }
  saveDraft(id: string, revision: number, rule: RuleSet): RuleDraft {
    const parsed = parseRule(rule, false);
    const result = this.db.prepare('UPDATE rule_drafts SET rule_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND published_at IS NULL').run(JSON.stringify(parsed), Date.now(), id, revision);
    if (!result.changes) throw new Conflict('草稿已更新或发布，请重新载入后编辑');
    return this.draft(id)!;
  }
  publishDraft(id: string, revision: number): { rule: RuleSet; hash: string } {
    return this.tx(() => {
      const draft = this.draft(id);
      if (!draft || draft.publishedAt !== null || draft.revision !== revision) throw new Conflict('草稿已更新或发布，请重新载入后编辑');
      const rule = parseRule(draft.rule), hash = hashRule(rule);
      if (this.db.prepare('SELECT version FROM rule_versions WHERE version=?').get(rule.version)) throw new Conflict('该版本已发布，请更换新版本号');
      this.registerRule(rule.version, hash, rule);
      this.db.prepare('UPDATE rule_drafts SET published_at=?,revision=revision+1 WHERE id=?').run(Date.now(), id);
      return { rule, hash };
    });
  }
  accept(submission: Submission, targetUrl: string | null = null, projectId = 'local'): { evaluationId: string; duplicate: boolean } {
    const hash = createHash('sha256').update(JSON.stringify({ submission, targetUrl })).digest('hex');
    return this.tx(() => {
      const old = this.db.prepare('SELECT id,payload_hash FROM evaluations WHERE project_id=? AND attempt_id=?').get(projectId, submission.attemptId);
      if (old) {
        if (old.payload_hash !== hash) throw new Conflict('相同 attemptId 携带了不同的任务内容');
        return { evaluationId: String(old.id), duplicate: true };
      }
      const id = randomUUID(), runId = randomUUID(), now = Date.now();
      this.db.prepare('INSERT INTO evaluations (id,project_id,attempt_id,job_id,occurred_at,created_at,submission,target_url,payload_hash,current_run_id) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, projectId, submission.attemptId, submission.jobId, submission.occurredAt, now, JSON.stringify(submission), targetUrl, hash, runId);
      this.db.prepare('INSERT INTO runs (id,evaluation_id,status,created_at,updated_at) VALUES (?,?,?,?,?)').run(runId, id, 'queued', now, now);
      if (targetUrl) this.assignSite(id, siteDomainFromUrl(targetUrl));
      this.event(runId, '任务已持久化，等待执行');
      return { evaluationId: id, duplicate: false };
    });
  }
  private assignSite(id: string, domain: string): void {
    const row = this.db.prepare('SELECT project_id,site_domain FROM evaluations WHERE id=?').get(id);
    if (!row) throw new Conflict('评测不存在');
    if (row.site_domain && row.site_domain !== domain) throw new Conflict('生成站域名已变化，请为新域名创建评测，原报告继续保留');
    this.db.prepare('INSERT OR IGNORE INTO sites VALUES (?,?,?)').run(row.project_id!, domain, Date.now());
    this.db.prepare('UPDATE evaluations SET site_domain=? WHERE id=?').run(domain, id);
  }
  bindSite(id: string, domain: string, runId: string, owner: string): void {
    const canonical = normalizeSiteDomain(domain);
    this.tx(() => {
      const lease = this.db.prepare('SELECT r.id FROM runs r JOIN evaluations e ON e.current_run_id=r.id WHERE e.id=? AND r.id=? AND r.lease_owner=? AND r.lease_until>?').get(id, runId, owner, Date.now());
      if (!lease) throw new LostLease('执行租约已失效');
      this.assignSite(id, canonical);
    });
  }
  private decodeRun(row: Record<string, unknown>): Run {
    return {
      id: String(row.id), evaluationId: String(row.evaluation_id), status: row.status as Run['status'],
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), error: row.error as string | null,
      report: row.report ? JSON.parse(String(row.report)) : null,
      evidence: row.evidence ? JSON.parse(String(row.evidence)) : null,
      snapshot: row.snapshot ? JSON.parse(String(row.snapshot)) : null,
    };
  }
  get(id: string, threshold = 80, projectId = 'local'): Evaluation | null {
    const row = this.db.prepare('SELECT * FROM evaluations WHERE id=? AND project_id=?').get(id, projectId);
    if (!row) return null;
    const runRow = this.db.prepare('SELECT * FROM runs WHERE id=?').get(String(row.current_run_id))!;
    const run = this.decodeRun(runRow);
    const reviewRow = this.db.prepare('SELECT * FROM reviews WHERE run_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(run.id);
    const review: Evaluation['review'] = reviewRow ? { decision: reviewRow.decision as 'accepted' | 'rework', note: String(reviewRow.note), createdAt: Number(reviewRow.created_at), runId: run.id } : null;
    return {
      id: String(row.id), projectId, siteDomain: row.site_domain as string | null, submission: JSON.parse(String(row.submission)),
      targetUrl: row.target_url as string | null, createdAt: Number(row.created_at), run, review,
      needsReview: review?.decision === 'rework' || (review?.decision !== 'accepted' && requiresReview(run.report, run.status, threshold)),
    };
  }
  list(threshold = 80, latestPerSite = false): Evaluation[] {
    const items = this.db.prepare('SELECT id FROM evaluations WHERE project_id=? ORDER BY occurred_at DESC, created_at DESC,id DESC').all('local').map((row) => {
      const item = this.get(String(row.id), threshold)!;
      item.run.evidence = null;
      return item;
    });
    if (!latestPerSite) return items;
    const seen = new Set<string>();
    return items.filter((item) => {
      if (!item.siteDomain) return true;
      if (seen.has(item.siteDomain)) return false;
      seen.add(item.siteDomain); return true;
    });
  }
  siteHistory(domain: string, threshold = 80, projectId = 'local'): Evaluation[] {
    const canonical = normalizeSiteDomain(domain);
    return this.db.prepare('SELECT id FROM evaluations WHERE project_id=? AND site_domain=? ORDER BY occurred_at DESC,created_at DESC,id DESC').all(projectId, canonical).map((row) => {
      const item = this.get(String(row.id), threshold, projectId)!; item.run.evidence = null; return item;
    });
  }
  latest(jobId: string, threshold = 80, projectId = 'local'): Evaluation | null {
    const row = this.db.prepare('SELECT id FROM evaluations WHERE job_id=? AND project_id=? ORDER BY occurred_at DESC,created_at DESC,id DESC LIMIT 1').get(jobId, projectId);
    return row ? this.get(String(row.id), threshold, projectId) : null;
  }
  history(id: string): Run[] {
    return this.db.prepare('SELECT * FROM runs WHERE evaluation_id=? ORDER BY created_at DESC,rowid DESC').all(id).map((row) => this.decodeRun(row));
  }
  events(runId: string): { seq: number; occurredAt: number; message: string }[] {
    return this.db.prepare('SELECT seq,occurred_at,message FROM events WHERE run_id=? ORDER BY seq').all(runId).map((row) => ({ seq: Number(row.seq), occurredAt: Number(row.occurred_at), message: String(row.message) }));
  }
  event(runId: string, message: string): void {
    this.db.prepare('INSERT INTO events (run_id,occurred_at,message) VALUES (?,?,?)').run(runId, Date.now(), message);
  }
  claim(owner: string, now = Date.now()): { evaluation: Evaluation; run: Run } | null {
    return this.tx(() => {
      const expired = this.db.prepare("SELECT id,claims FROM runs WHERE status IN ('collecting','scoring') AND lease_until<=?").all(now);
      for (const row of expired) {
        const exhausted = Number(row.claims) >= 3;
        this.db.prepare('UPDATE runs SET status=?,error=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?').run(exhausted ? 'failed' : 'queued', exhausted ? '任务连续三次失去执行租约，请检查运行环境后重评' : null, now, row.id!);
        this.event(String(row.id), exhausted ? '多次执行中断，已停止自动恢复' : '执行租约过期，任务重新排队');
      }
      if (this.db.prepare("SELECT id FROM runs WHERE status IN ('collecting','scoring') AND lease_until>?").get(now)) return null;
      const row = this.db.prepare("SELECT r.* FROM runs r JOIN evaluations e ON e.current_run_id=r.id WHERE r.status='queued' ORDER BY r.created_at,r.rowid LIMIT 1").get();
      if (!row) return null;
      this.db.prepare("UPDATE runs SET status='collecting',lease_owner=?,lease_until=?,claims=claims+1,updated_at=? WHERE id=?").run(owner, now + 300000, now, row.id!);
      this.event(String(row.id), '开始采集证据');
      const evaluation = this.get(String(row.evaluation_id))!;
      return { evaluation, run: evaluation.run };
    });
  }
  heartbeat(runId: string, owner: string): boolean {
    const now = Date.now();
    return this.db.prepare('UPDATE runs SET lease_until=? WHERE id=? AND lease_owner=? AND lease_until>?').run(now + 300000, runId, owner, now).changes === 1;
  }
  update(runId: string, owner: string, changes: Partial<Pick<Run, 'status' | 'error' | 'report' | 'evidence' | 'snapshot'>>): void {
    const columns = Object.keys(changes) as (keyof typeof changes)[];
    if (!columns.length) return;
    const values = columns.map((key) => changes[key] === null ? null : typeof changes[key] === 'object' ? JSON.stringify(changes[key]) : String(changes[key]));
    const terminal = changes.status === 'completed' || changes.status === 'failed' || changes.status === 'queued';
    const result = this.db.prepare(`UPDATE runs SET ${columns.map((key) => `${key}=?`).join(',')},updated_at=?${terminal ? ',lease_owner=NULL,lease_until=NULL' : ''}${changes.status === 'queued' ? ',claims=0' : ''} WHERE id=? AND lease_owner=? AND lease_until>?`).run(...values, Date.now(), runId, owner, Date.now());
    if (!result.changes) throw new LostLease('执行租约已失效');
  }
  rerun(id: string): string {
    return this.tx(() => {
      const current = this.get(id);
      if (!current) throw new Conflict('任务不存在');
      if (!['failed', 'completed'].includes(current.run.status)) throw new Conflict('当前任务仍在执行或排队');
      const runId = randomUUID(), now = Date.now();
      this.db.prepare('INSERT INTO runs (id,evaluation_id,status,created_at,updated_at) VALUES (?,?,?,?,?)').run(runId, id, 'queued', now, now);
      this.db.prepare('UPDATE evaluations SET current_run_id=? WHERE id=?').run(runId, id);
      this.event(runId, '已创建新一轮评测，保留历史报告');
      return runId;
    });
  }
  review(id: string, decision: 'accepted' | 'rework', note: string, runId: string): void {
    this.tx(() => {
      const current = this.get(id);
      if (!current || current.run.id !== runId) throw new Conflict('评测已更新，请刷新后复核');
      if (!['failed', 'completed'].includes(current.run.status)) throw new Conflict('等待本轮执行结束后再复核');
      this.db.prepare('INSERT INTO reviews VALUES (?,?,?,?,?)').run(randomUUID(), runId, decision, note, Date.now());
      this.event(runId, decision === 'accepted' ? `人工复核通过：${note || '无备注'}` : `人工标记需返工：${note || '无备注'}`);
    });
  }
}

export function requiresReview(report: Report | null, status: Run['status'], threshold: number): boolean {
  if (status === 'queued' || status === 'collecting' || status === 'scoring') return false;
  return status === 'failed' || !report || report.fidelityScore === null || report.fidelityScore < threshold || report.confidence === 'low' || report.health === 'critical' || !report.coverage.complete || !report.stable || report.issues.some((issue) => issue.severity === 'critical');
}
