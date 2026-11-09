import type { CollectionTargetReport } from '../../../shared/collection-target.js';
import type { AutomationStore } from '../store.js';
import { collectionHash } from './runtime.js';

type ReportIdentity = Pick<CollectionTargetReport, 'taskId' | 'verifierVersion' | 'manifestId' | 'manifestRevision' | 'manifestHash'> &
  Partial<Pick<CollectionTargetReport, 'inputVersionId' | 'collectionId' | 'collectionVersionId' | 'generatedSiteId' | 'siteId' | 'siteRevision'>>;
const fields = ['taskId', 'verifierVersion', 'inputVersionId', 'collectionId', 'collectionVersionId', 'manifestId', 'manifestRevision', 'manifestHash', 'generatedSiteId', 'siteId', 'siteRevision'] as const;
const identityKey = (report: ReportIdentity) => collectionHash(JSON.stringify(fields.map(key => report[key] ?? null)));

/** Large immutable reports are hydrated one at a time, through a compact lookup index. */
export class CollectionTargetReports {
  constructor(private store: AutomationStore) {
    const db = store.db;
    db.exec(`CREATE TABLE IF NOT EXISTS auto_collection_target_reports(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,binding TEXT NOT NULL,created_at INTEGER NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auto_collection_target_report_index(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,binding TEXT NOT NULL,lookup_key TEXT NOT NULL,created_at INTEGER NOT NULL,source_order INTEGER NOT NULL,content_hash TEXT);
      CREATE INDEX IF NOT EXISTS auto_collection_target_lookup ON auto_collection_target_report_index(task_id,lookup_key,created_at DESC,source_order DESC);
      CREATE INDEX IF NOT EXISTS auto_collection_target_binding ON auto_collection_target_report_index(binding,created_at DESC,source_order DESC);
      CREATE TRIGGER IF NOT EXISTS auto_collection_target_reindex AFTER UPDATE ON auto_collection_target_reports BEGIN DELETE FROM auto_collection_target_report_index WHERE id=NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS auto_collection_target_unindex AFTER DELETE ON auto_collection_target_reports BEGIN DELETE FROM auto_collection_target_report_index WHERE id=OLD.id; END;`);
    // Legacy/rollback writers are supported. SQL returns metadata, never all report bodies.
    const projection = fields.map(key => `json_extract(r.json,'$.${key}')`).join(',');
    db.transaction(() => {
      const missing = db.prepare(`SELECT r.id,r.task_id,r.binding,r.created_at,r.rowid AS source_order,json_array(${projection}) AS identity
        FROM auto_collection_target_reports r WHERE NOT EXISTS(SELECT 1 FROM auto_collection_target_report_index i WHERE i.id=r.id)`).all();
      for (const row of missing) db.prepare('INSERT OR IGNORE INTO auto_collection_target_report_index VALUES(?,?,?,?,?,?,NULL)').run(
        row.id, row.task_id, row.binding, collectionHash(JSON.stringify(JSON.parse(row.identity))), row.created_at, row.source_order,
      );
    });
  }
  latest(identity: ReportIdentity): CollectionTargetReport | undefined {
    const row = this.store.db.prepare(`SELECT json FROM auto_collection_target_reports WHERE id=(
      SELECT id FROM auto_collection_target_report_index WHERE task_id=? AND lookup_key=? ORDER BY created_at DESC,source_order DESC LIMIT 1
    )`).get(identity.taskId, identityKey(identity));
    return row ? JSON.parse(row.json) : undefined;
  }
  fingerprint(report: CollectionTargetReport) {
    const { id, checkedAt, nextAt, artifacts, summary, ...content } = report;
    return collectionHash(JSON.stringify(this.store.sanitize({ ...content, ...(summary ? { summary: { ...summary, reportId: undefined } } : {}), artifacts: artifacts.filter(file => !file.name.startsWith('collection-target-report-')) })));
  }
  unchanged(report: CollectionTargetReport, hash: string): CollectionTargetReport | undefined {
    const latest = this.store.db.prepare('SELECT id,content_hash FROM auto_collection_target_report_index WHERE binding=? ORDER BY created_at DESC,source_order DESC LIMIT 1').get(report.binding);
    if (!latest || latest.content_hash !== hash) return;
    const row = this.store.db.prepare('SELECT json FROM auto_collection_target_reports WHERE id=?').get(latest.id);
    return row ? { ...JSON.parse(row.json), ...(report.nextAt === undefined ? {} : { nextAt: report.nextAt }) } : undefined;
  }
  save(report: CollectionTargetReport, hash: string) {
    const json = JSON.stringify(this.store.sanitize(report));
    this.store.db.transaction(() => {
      this.store.db.prepare('INSERT INTO auto_collection_target_reports VALUES(?,?,?,?,?)').run(report.id, report.taskId, report.binding, report.checkedAt, json);
      const order = this.store.db.prepare('SELECT rowid AS position FROM auto_collection_target_reports WHERE id=?').get(report.id).position;
      this.store.db.prepare('INSERT INTO auto_collection_target_report_index VALUES(?,?,?,?,?,?,?)').run(report.id, report.taskId, report.binding, identityKey(report), report.checkedAt, order, hash);
    });
  }
}
