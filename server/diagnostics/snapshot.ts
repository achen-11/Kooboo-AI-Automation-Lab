import type { AutomationTask, GeneratedSite, InputVersion } from '../../shared/automation.js';
import type { AutomationStore } from '../automation/store.js';
import { Conflict } from '../lib/store.js';

export interface DiagnosticSnapshot {
  at: number; focus: AutomationTask; site?: GeneratedSite; siteState: unknown;
  tasks: AutomationTask[]; versions: InputVersion[];
  records: Record<string, any[]>;
}
/** Read the persisted records, not compact UI projections or live mutable task objects. */
export function diagnosticSnapshot(store: AutomationStore, taskId: string): DiagnosticSnapshot {
  return store.db.transaction(() => {
    const at = Date.now(), all = store.db.prepare('SELECT json FROM auto_tasks ORDER BY created_at,id').all().map(r => JSON.parse(r.json) as AutomationTask);
    const focus = all.find(task => task.id === taskId); if (!focus) throw new Conflict('任务不存在');
    const ids = new Set(all.filter(task => task.id === taskId || focus.generatedSiteId && task.generatedSiteId === focus.generatedSiteId).map(task => task.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of all) {
        // Follow explicit links only, never infer identity from names or URLs.
        const linked = ids.has(task.id) || task.parentId && ids.has(task.parentId) || all.some(t => ids.has(t.id) && (t.parentId === task.id || t.evaluationTaskId === task.id || t.optimizationRootId === task.id));
        if (linked && (!task.generatedSiteId || task.generatedSiteId === focus.generatedSiteId) && !ids.has(task.id)) { ids.add(task.id); changed = true; }
      }
    }
    const tasks = all.filter(task => ids.has(task.id)), args = [...ids], marks = args.map(() => '?').join(',');
    const exists = (table: string) => !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    const select = (table: string, where = '', values: unknown[] = []) => exists(table) ? store.db.prepare(`SELECT * FROM ${table}${where ? ' WHERE ' + where : ''}`).all(...values) : [];
    const json = (rows: any[]) => rows.map(row => JSON.parse(row.json));
    const versions = [...new Set(tasks.map(task => task.versionId))].flatMap(id => json(select('auto_versions', 'id=?', [id]))) as InputVersion[];
    const manifests = json(select('auto_requirement_manifests')).filter(row => ids.has(row.taskId) || tasks.some(task => task.requirementsId === row.id));
    const learning = json(select('auto_learning_runs')).filter(row => ids.has(row.taskId) || ids.has(row.workflowId));
    const experienceIds = new Set<string>(learning.flatMap(run => [...(run.adoptions || []).map((a: any) => a.experienceId), ...(run.produced || []), ...(run.outcomes || []).map((a: any) => a.experienceId)]));
    const clocks = new Set([...ids].flatMap(id => [id, 'manifest-' + id])); for (const run of learning) clocks.add(run.id);
    const budgetIds = new Set<string>([...ids].flatMap(id => ['planning:' + id, 'experience:' + id]));
    for (const task of tasks) if (task.followup?.budgetId) budgetIds.add('followup:' + task.followup.budgetId);
    for (const run of learning) if (run.budgetId) budgetIds.add(run.budgetId);
    const usage = json(select('auto_usage', `task_id IN (${marks})`, args));
    const priceIds = new Set(usage.flatMap(row => row.price?.id ? [row.price.id] : []));
    const sourceTasks = new Set<string>(manifests.flatMap(m => (m.sourceEvidence || []).map((e: any) => e.taskId)));
    const site = focus.generatedSiteId ? json(select('auto_sites', 'id=?', [focus.generatedSiteId]))[0] : undefined;
    const records: Record<string, any[]> = {
      resources: json(select('auto_resources')).filter(row => versions.some(v => v.resourceId === row.id) || tasks.some(task => task.resourceId === row.id)),
      events: select('auto_events', `task_id IN (${marks})`, args).sort((a, b) => a.seq - b.seq),
      notifications: json(select('auto_notifications', `task_id IN (${marks})`, args)),
      manifests,
      sourceArtifacts: select('auto_manifest_artifacts').filter(row => ids.has(row.task_id) || sourceTasks.has(row.task_id)),
      migrationProfiles: json(select('auto_migration_profiles')).filter(row => ids.has(row.workflowId)),
      migrationChecks: json(select('auto_migration_checks', `task_id IN (${marks}) OR workflow_id IN (${marks})`, [...args, ...args])),
      learning,
      experienceRevisions: json(select('auto_experience_revisions')).filter(row => experienceIds.has(row.experience?.id)),
      usage, prices: json(select('auto_prices')).filter(row => priceIds.has(row.id)),
      budgetAccounts: select('auto_model_accounts').filter(row => budgetIds.has(row.id)),
      budgetRequests: select('auto_model_requests').filter(row => budgetIds.has(row.account_id)),
      decisionClocks: select('auto_decision_clock').filter(row => clocks.has(row.id)),
    };
    return { at, focus, site, siteState: focus.generatedSiteId ? select('auto_site_state', 'site_id=?', [focus.generatedSiteId])[0] || null : null, tasks, versions, records };
  });
}
