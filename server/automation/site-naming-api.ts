import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canAdjustTaskSiteNames } from '../../shared/task-presentation.js';
import { findRootDomain, parseRootDomains, rootDomainValue } from '../../shared/kooboo-domains.js';
import type { AutomationTask } from '../../shared/automation.js';
import { Conflict } from '../lib/store.js';
import type { Vault } from '../lib/vault.js';
import type { AutomationStore } from './store.js';
import { koobooClient } from './kooboo.js';
import { availableSiteNames, taskSiteNaming } from './site-naming.js';
import { retainStoppedFollowupReservations } from './budget-recovery.js';
import { GenerationInputError } from './errors.js';

export function registerTaskNamingApi(app: FastifyInstance, store: AutomationStore, vault: Vault, owns: (id: string) => boolean) {
  function eligible(id: string): AutomationTask {
    const task = store.task(id);
    if (!task || owns(id) || !canAdjustTaskSiteNames(task))
      throw new Conflict('只能调整已停止、尚未发出建站请求的名称冲突任务；建站结果不确定时请先核验原站点');
    if (store.dispositions.get('delivery', task.id) || store.dispositions.get('resource', task.resourceId))
      throw new Conflict('任务或资源已归档，请先移回在列后再继续');
    const root = store.root(task);
    if (root?.optimization && (root.optimization.state === 'completed' || root.id !== task.id && root.optimization.activeTaskId !== task.id))
      throw new Conflict('请操作尚未完成的当前优化轮次');
    return task;
  }

  app.post('/api/automation/tasks/:id/adjust-site-names', async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const original = eligible(id);
    const naming = taskSiteNaming(original, store.version(original.versionId));
    const client = koobooClient(original, vault, AbortSignal.timeout(60000));
    const domains = parseRootDomains(await client.request('Domain/Available'));
    const root = findRootDomain(domains, naming.rootDomain || client.environment.defaultRootDomain || domains[0]?.domainName || '');
    if (!root) throw new Conflict('所选建站根域名已不可用，请先恢复原根域名');
    const selected = await availableSiteNames(naming.siteName!, naming.subDomain!, root, client.request).catch(error => {
      throw new Conflict(error instanceof GenerationInputError ? error.message : '无法检查站点名称或子域名，请确认 Kooboo 环境连接后重试');
    });
    return store.db.transaction(() => {
      const task = eligible(id);
      if (task.updatedAt !== original.updatedAt) throw new Conflict('任务已变化，请刷新后重试');
      retainStoppedFollowupReservations(task, store, owns);
      task.generation = { ...task.generation, ...selected, rootDomain: rootDomainValue(root) };
      task.status = 'queued'; task.stage = 'prepare'; task.error = ''; delete task.interruption;
      if (task.followup) { task.followup.state = 'resolved'; task.followup.executionStopped = true; }
      if (task.autonomy) { delete task.autonomy.stopReason; delete task.autonomy.checkpoint.nextAt; }
      const workflow = store.root(task);
      if (workflow?.optimization) {
        const run = workflow.optimization;
        run.state = workflow.id === task.id ? 'waiting-evaluation' : 'repairing'; run.reason = ''; run.nextSteps = []; delete run.stoppedAt;
        if (workflow.id === task.id) task.optimization = run;
        else store.put(workflow, true);
      }
      store.put(task, true);
      store.event(id, `操作者自动调整名称并继续：站点名称 ${naming.siteName} → ${selected.siteName}；子域名 ${naming.subDomain} → ${selected.subDomain}；保留原输入版本、规则与采集检查点。`);
      return task;
    });
  });
}
