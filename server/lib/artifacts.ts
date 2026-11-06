import type { Database } from '../runtime.js';
import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export class Artifacts {
  constructor(private db: Database, private directory?: string) {
    db.exec('CREATE TABLE IF NOT EXISTS evaluator_artifacts (evaluation_id TEXT NOT NULL, run_id TEXT NOT NULL, file TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY(evaluation_id,run_id,file))');
  }
  save(evaluationId: string, runId: string, file: string, content: string) {
    if (this.directory && file.endsWith('.png')) {
      const bytes = Buffer.from(content, 'base64');
      const hash = createHash('sha256').update(bytes).digest('hex');
      const path = this.path(evaluationId, runId, file);
      mkdirSync(dirname(path), { recursive: true });
      const temporary = path + '.' + randomUUID() + '.tmp';
      writeFileSync(temporary, bytes);
      renameSync(temporary, path);
      content = '@disk:' + hash;
    }
    this.db.prepare('INSERT OR REPLACE INTO evaluator_artifacts VALUES (?,?,?,?)').run(evaluationId,runId,file,content);
  }
  get(evaluationId: string, runId: string, file: string): string | null {
    const row = this.db.prepare('SELECT content FROM evaluator_artifacts WHERE evaluation_id=? AND run_id=? AND file=?').get(evaluationId,runId,file);
    if (!row) return null;
    const content = String(row.content);
    if (!content.startsWith('@disk:')) return content;
    if (!this.directory) return null;
    try {
      const bytes = readFileSync(this.path(evaluationId, runId, file));
      return createHash('sha256').update(bytes).digest('hex') === content.slice(6) ? bytes.toString('base64') : null;
    } catch { return null; }
  }
  private path(evaluationId: string, runId: string, file: string) {
    if (![evaluationId, runId].every(value => /^[a-zA-Z0-9_-]{1,150}$/.test(value)) || !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,200}$/.test(file)) throw new Error('产物标识不合法');
    return resolve(this.directory!, evaluationId, runId, file);
  }
}
