import type { Database } from '../runtime.js';
import { normalizeUsage } from './billing.js';
import { createHash } from 'node:crypto';

export class ModelBudgetExceeded extends Error {
  constructor(message: string) { super(message); this.name = 'ModelBudgetExceeded'; }
}
export interface RequestBudgetPolicy {
  key: string; runKey: string; maxTokens: number; maxRequests: number;
  initialTokens?: number; maxOutputTokens?: number;
}
/** Call only after the owner has stopped. Keep the estimate distinct from actual usage. */
export function retainRequestReservation(db: Database, id: string) {
  return db.prepare("UPDATE auto_model_requests SET state='retained' WHERE id=? AND state IN ('active','unknown')").run(id);
}
/** Missing usage blocks requests until stopped execution is explicitly recovered. */
export class RequestBudget {
  constructor(private db: Database, readonly policy: RequestBudgetPolicy) {
    db.exec(`CREATE TABLE IF NOT EXISTS auto_model_accounts(id TEXT PRIMARY KEY, initial_tokens INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auto_model_requests(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, run_key TEXT NOT NULL, state TEXT NOT NULL, charged INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS auto_model_account_requests ON auto_model_requests(account_id,run_key);`);
    if(!db.prepare('PRAGMA table_info(auto_model_requests)').all().some(r=>r.name==='fingerprint'))db.exec("ALTER TABLE auto_model_requests ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''");
    if (!Number.isSafeInteger(policy.maxTokens) || policy.maxTokens < 1000 || !Number.isSafeInteger(policy.maxRequests) || policy.maxRequests < 1) throw new Error('模型预算配置不合法');
    db.prepare('INSERT OR IGNORE INTO auto_model_accounts VALUES(?,?)').run(policy.key, Math.max(0, policy.initialTokens || 0));
  }
  state() {
    const seed = Number(this.db.prepare('SELECT initial_tokens FROM auto_model_accounts WHERE id=?').get(this.policy.key)!.initial_tokens);
    const row = this.db.prepare("SELECT COALESCE(SUM(charged),0) AS charged,COUNT(CASE WHEN state NOT IN ('complete','retained') THEN 1 END) AS unknown FROM auto_model_requests WHERE account_id=?").get(this.policy.key)!;
    const requests = Number(this.db.prepare('SELECT COUNT(*) AS n FROM auto_model_requests WHERE account_id=? AND run_key=?').get(this.policy.key, this.policy.runKey)!.n);
    return { spent: seed + Number(row.charged), unknown: Number(row.unknown), requests };
  }
  reserve(id: string, raw: Buffer): Buffer {
    return this.db.transaction(() => {
      const state = this.state();
      if (state.unknown) throw new ModelBudgetExceeded('前一模型请求仍在执行或缺少完整 usage，已停止新增请求；请核查用量。');
      if (state.requests >= this.policy.maxRequests) throw new ModelBudgetExceeded('本次 Agent 已达到模型请求次数上限。');
      const remaining = this.policy.maxTokens - state.spent;
      if (remaining <= 0) throw new ModelBudgetExceeded('累计模型 token 已达到预算上限。');
      const body = JSON.parse(raw.toString()) as Record<string, unknown>;
      const fingerprint=createHash('sha256').update(raw).digest('hex');
      if(Number(this.db.prepare('SELECT COUNT(*) n FROM auto_model_requests WHERE account_id=? AND run_key=? AND fingerprint=?').get(this.policy.key,this.policy.runKey,fingerprint).n)>=3)throw new ModelBudgetExceeded('同一 Agent 已重复提交相同模型请求 3 次，已阻止无进展循环。');
      let images = 0;
      const text = JSON.stringify(body, (key, value) => {
        if (typeof value === 'string' && (value.startsWith('data:image/') || key === 'image_url')) { images++; return '[image]'; }
        return value;
      });
      // Admission estimates are not a guarantee about a third-party tokenizer.
      const input = Buffer.byteLength(text) + images * 16384;
      const requested = typeof body.max_output_tokens === 'number' ? body.max_output_tokens : 8192;
      const output = Math.floor(Math.min(requested, this.policy.maxOutputTokens || 8192, remaining - input));
      if (!Number.isFinite(output) || output < 1) throw new ModelBudgetExceeded('剩余预算不足以接收本次上下文；请缩小上下文或显式调整预算。');
      if (!body.__compact) body.max_output_tokens = output;
      else throw new ModelBudgetExceeded('当前提供方压缩接口未支持可验证的输出预算，已阻止压缩调用；请新建会话并复用证据。');
      delete body.__compact;
      this.db.prepare('INSERT INTO auto_model_requests(id,account_id,run_key,state,charged,fingerprint) VALUES(?,?,?,?,?,?)').run(id, this.policy.key, this.policy.runKey, 'active', input + output,fingerprint);
      return Buffer.from(JSON.stringify(body));
    });
  }
  complete(id: string, raw: Record<string, unknown> | null) {
    const tokens = normalizeUsage(raw);
    if (tokens) this.db.prepare("UPDATE auto_model_requests SET state='complete',charged=? WHERE id=? AND account_id=?").run(tokens.input + tokens.output, id, this.policy.key);
    else this.db.prepare("UPDATE auto_model_requests SET state='unknown' WHERE id=? AND account_id=?").run(id, this.policy.key);
  }
}
