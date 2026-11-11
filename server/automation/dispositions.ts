import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  DispositionState,
  DispositionTargetKind,
  ItemDisposition,
} from '../../shared/dispositions.js';
import { Conflict } from '../lib/store.js';
import type { Database } from '../runtime.js';
import { stopOptimization } from './optimization.js';
import { siteDeliveries } from './site-delivery.js';
import type { AutomationStore } from './store.js';
import type { TaskHeader } from './task-index.js';

export class Dispositions {
  constructor(
    private db: Database,
    private redact: (value: string) => string = value => value,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS auto_dispositions(
      kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      state TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(kind, target_id)
    );
    CREATE INDEX IF NOT EXISTS auto_dispositions_kind_state ON auto_dispositions(kind, state);`);
  }

  map(kind: DispositionTargetKind): Map<string, ItemDisposition> {
    const rows = this.db
      .prepare('SELECT target_id,state,note,updated_at FROM auto_dispositions WHERE kind=?')
      .all(kind) as { target_id: string; state: 'completed' | 'discarded'; note: string; updated_at: number }[];
    return new Map(
      rows.map(row => [
        row.target_id,
        { state: row.state, note: row.note, updatedAt: row.updated_at },
      ]),
    );
  }

  get(kind: DispositionTargetKind, id?: string | null): ItemDisposition | undefined {
    if (!id) return undefined;
    const row = this.db
      .prepare('SELECT state,note,updated_at FROM auto_dispositions WHERE kind=? AND target_id=?')
      .get(kind, id) as { state: 'completed' | 'discarded'; note: string; updated_at: number } | undefined;
    return row ? { state: row.state, note: row.note, updatedAt: row.updated_at } : undefined;
  }

  set(
    kind: DispositionTargetKind,
    ids: readonly string[],
    state: DispositionState,
    note = '',
    now = Date.now(),
  ) {
    if (!ids.length) return;
    if (state === 'active') {
      const del = this.db.prepare('DELETE FROM auto_dispositions WHERE kind=? AND target_id=?');
      for (const id of ids) del.run(kind, id);
      return;
    }
    const cleanNote = this.redact(note.trim()).slice(0, 500);
    const upsert = this.db.prepare(
      'INSERT INTO auto_dispositions(kind,target_id,state,note,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(kind,target_id) DO UPDATE SET state=excluded.state,note=excluded.note,updated_at=excluded.updated_at',
    );
    for (const id of ids) upsert.run(kind, id, state, cleanNote, now);
  }
}

interface ResolvedDeliveryUnit {
  id: string;
  siteId: string | null;
  resourceId: string;
  members: TaskHeader[];
}

function resolveDeliveryUnit(store: AutomationStore, id: string, headersBySite?: Map<string, TaskHeader[]>): ResolvedDeliveryUnit {
  const site = store.site(id);
  if (site) {
    const members = headersBySite ? headersBySite.get(id) || [] : store.headers(id);
    return { id, siteId: site.id, resourceId: site.resourceId, members };
  }
  const header = store.header(id);
  if (header && !header.generatedSiteId) {
    return { id, siteId: null, resourceId: header.resourceId, members: [header] };
  }
  throw new Conflict('生成站或任务不存在，请刷新后重试');
}

function deliveryBusyState(unit: ResolvedDeliveryUnit, store: AutomationStore, owns: (id: string) => boolean) {
  const locked =
    store.domainReserved(unit.siteId) ||
    unit.members.some(task => store.migrationReadReserved(task));
  const runningOrUnconfirmed =
    locked ||
    unit.members.some(
      task =>
        !task.stopped ||
        owns(task.id) ||
        ['running', 'cancelling', 'following-up'].includes(task.status) ||
        Boolean(
          task.delivery &&
            (task.delivery.stopped === false ||
              ['running', 'verifying'].includes(task.delivery.status)),
        ),
    );
  const queued = unit.members.some(
    task => task.status === 'queued' || task.delivery?.status === 'queued',
  );
  const optimizing = unit.members.some(task =>
    Boolean(task.optimization && !['completed', 'stopped'].includes(task.optimization.state)),
  );
  const uncertainDelivery = unit.members.some(task => task.delivery?.status === 'uncertain');
  return {
    runningOrUnconfirmed,
    queued,
    optimizing,
    uncertainDelivery,
    anyInFlight: runningOrUnconfirmed || queued || optimizing || uncertainDelivery,
  };
}

function settleQueuedBeforeDiscard(
  unit: ResolvedDeliveryUnit,
  store: AutomationStore,
  cancel: (id: string) => void,
) {
  for (const member of unit.members) {
    if (member.status === 'queued') {
      const full = store.task(member.id, false);
      if (full && full.status === 'queued') {
        full.status = 'cancelled';
        store.put(full);
        store.event(full.id, '任务随舍弃归档自动取消出队');
        cancel(full.id);
      }
    }
    if (member.delivery?.status === 'queued') {
      const full = store.task(member.id, false);
      if (full?.delivery?.status === 'queued') {
        full.delivery.status = 'failed';
        full.delivery.stopped = true;
        full.delivery.error = '交付排队随舍弃归档取消。';
        store.put(full);
        store.event(full.id, '交付排队随舍弃归档自动取消');
      }
    }
  }
  for (const member of unit.members) {
    if (member.optimization && !['completed', 'stopped'].includes(member.optimization.state)) {
      const root = store.task(member.id, false);
      if (root?.optimization && !['completed', 'stopped'].includes(root.optimization.state)) {
        stopOptimization(root, store, '任务已舍弃归档，自动停止优化流程。', []);
      }
    }
  }
}

function resourceUnits(
  store: AutomationStore,
  resourceId: string,
  allHeaders: TaskHeader[],
  headersBySite: Map<string, TaskHeader[]>,
): ResolvedDeliveryUnit[] {
  const sites = store.sites(resourceId).map(site => ({
    id: site.id,
    siteId: site.id,
    resourceId,
    members: headersBySite.get(site.id) || [],
  }));
  const pendingRoots = allHeaders
    .filter(header => !header.generatedSiteId && header.resourceId === resourceId)
    .map(header => ({ id: header.id, siteId: null, resourceId, members: [header] }));
  return [...sites, ...pendingRoots];
}

const updateSchema = z.object({
  kind: z.enum(['resource', 'delivery']),
  ids: z
    .array(z.string().uuid())
    .min(1)
    .max(1000)
    .refine(ids => new Set(ids).size === ids.length, '项目不能重复'),
  state: z.enum(['active', 'completed', 'discarded']),
  note: z.string().trim().max(500).default(''),
  cascadeResources: z.boolean().optional(),
  cascadeDeliveries: z.boolean().optional(),
});

export function registerDispositionApi(
  app: FastifyInstance,
  store: AutomationStore,
  threshold: () => number,
  cancel: (id: string) => void,
  owns: (id: string) => boolean,
) {
  app.post('/api/automation/dispositions', async request => {
    const input = updateSchema.parse(request.body);
    return store.db.transaction(() => {
      const now = Date.now();
      const allHeaders = store.headers();
      const headersBySite = new Map<string, TaskHeader[]>();
      for (const header of allHeaders) {
        if (!header.generatedSiteId) continue;
        const list = headersBySite.get(header.generatedSiteId) || [];
        list.push(header);
        headersBySite.set(header.generatedSiteId, list);
      }

      if (input.kind === 'delivery') {
        const units = input.ids.map(id => resolveDeliveryUnit(store, id, headersBySite));
        const selectedSet = new Set(input.ids);

        if (input.state === 'completed') {
          for (const unit of units) {
            if (deliveryBusyState(unit, store, owns).anyInFlight) {
              throw new Conflict('包含正在执行、排队或待核查的任务，请先等待结束或停止后再标记为已完成');
            }
          }
          const readTaskIds = units.flatMap(unit => unit.members.map(member => member.id));
          if (input.cascadeResources) {
            const resourceIds = [...new Set(units.map(unit => unit.resourceId))];
            const siblingDiscardIds: string[] = [];
            for (const resourceId of resourceIds) {
              if (!store.resource(resourceId)) throw new Conflict('关联资源不存在，请刷新后重试');
              const siblings = resourceUnits(store, resourceId, allHeaders, headersBySite).filter(
                unit => !selectedSet.has(unit.id),
              );
              for (const sibling of siblings) {
                if (deliveryBusyState(sibling, store, owns).anyInFlight) {
                  throw new Conflict('所属资源下仍有正在执行或排队的其他任务，请先处理后再同步完成资源');
                }
                if (!store.dispositions.get('delivery', sibling.id)) {
                  siblingDiscardIds.push(sibling.id);
                  readTaskIds.push(...sibling.members.map(member => member.id));
                }
              }
            }
            if (siblingDiscardIds.length) {
              store.dispositions.set(
                'delivery',
                siblingDiscardIds,
                'discarded',
                '同资源其他生成站已验收完成，自动收起旧尝试',
                now,
              );
            }
            store.dispositions.set('resource', resourceIds, 'completed', input.note, now);
          }
          store.dispositions.set('delivery', input.ids, 'completed', input.note, now);
          store.readTaskNotices(readTaskIds);
          return { ok: true, updated: input.ids.length };
        }

        if (input.state === 'discarded') {
          for (const unit of units) {
            if (deliveryBusyState(unit, store, owns).runningOrUnconfirmed) {
              throw new Conflict('包含正在执行或尚未确认停止的任务，请先停止并确认执行结束后再舍弃');
            }
          }
          for (const unit of units) settleQueuedBeforeDiscard(unit, store, cancel);
          store.dispositions.set('delivery', input.ids, 'discarded', input.note, now);
          store.readTaskNotices(units.flatMap(unit => unit.members.map(member => member.id)));
          return { ok: true, updated: input.ids.length };
        }

        store.dispositions.set('delivery', input.ids, 'active');
        if (input.cascadeResources) {
          const resourceIds = [...new Set(units.map(unit => unit.resourceId))];
          store.dispositions.set('resource', resourceIds, 'active');
        }
        return { ok: true, updated: input.ids.length };
      }

      // input.kind === 'resource'
      for (const id of input.ids) {
        if (!store.resource(id)) throw new Conflict('资源不存在，请刷新后重试');
      }

      if (input.state === 'discarded') {
        const cascade = input.cascadeDeliveries !== false;
        const discardDeliveryIds: string[] = [];
        const readTaskIds: string[] = [];
        for (const resourceId of input.ids) {
          const units = resourceUnits(store, resourceId, allHeaders, headersBySite);
          for (const unit of units) {
            if (deliveryBusyState(unit, store, owns).runningOrUnconfirmed) {
              throw new Conflict('所选资源下包含正在执行或尚未确认停止的任务，请先停止并确认后再舍弃');
            }
          }
          if (cascade) {
            for (const unit of units) {
              if (!store.dispositions.get('delivery', unit.id)) {
                settleQueuedBeforeDiscard(unit, store, cancel);
                discardDeliveryIds.push(unit.id);
                readTaskIds.push(...unit.members.map(member => member.id));
              }
            }
          }
        }
        if (discardDeliveryIds.length) {
          store.dispositions.set(
            'delivery',
            discardDeliveryIds,
            'discarded',
            input.note || '随所属资源一并舍弃',
            now,
          );
          store.readTaskNotices(readTaskIds);
        }
        store.dispositions.set('resource', input.ids, 'discarded', input.note, now);
        return { ok: true, updated: input.ids.length };
      }

      if (input.state === 'completed') {
        const completeDeliveryIds: string[] = [];
        const discardDeliveryIds: string[] = [];
        const readTaskIds: string[] = [];
        const summaries = input.cascadeDeliveries
          ? new Map(siteDeliveries(store, threshold()).map(row => [row.id, row]))
          : undefined;
        for (const resourceId of input.ids) {
          const units = resourceUnits(store, resourceId, allHeaders, headersBySite);
          for (const unit of units) {
            if (deliveryBusyState(unit, store, owns).anyInFlight) {
              throw new Conflict('所选资源下仍有正在执行、排队或待核查的任务，请先等待结束或停止后再标记为已完成');
            }
          }
          if (input.cascadeDeliveries) {
            const activeUnits = units.filter(unit => !store.dispositions.get('delivery', unit.id));
            if (activeUnits.length === 1) {
              completeDeliveryIds.push(activeUnits[0].id);
              readTaskIds.push(...activeUnits[0].members.map(member => member.id));
            } else if (activeUnits.length > 1) {
              const readyUnits = activeUnits.filter(unit => summaries?.get(unit.id)?.state === 'ready');
              if (readyUnits.length === 1) {
                completeDeliveryIds.push(readyUnits[0].id);
                readTaskIds.push(...readyUnits[0].members.map(member => member.id));
                for (const other of activeUnits) {
                  if (other.id === readyUnits[0].id) continue;
                  discardDeliveryIds.push(other.id);
                  readTaskIds.push(...other.members.map(member => member.id));
                }
              } else {
                throw new Conflict('资源下存在多个未归档生成站，请先在任务中心对最终保留的生成站标记为已完成');
              }
            }
          }
        }
        if (completeDeliveryIds.length) {
          store.dispositions.set('delivery', completeDeliveryIds, 'completed', input.note, now);
        }
        if (discardDeliveryIds.length) {
          store.dispositions.set(
            'delivery',
            discardDeliveryIds,
            'discarded',
            '同资源其他生成站已验收完成，自动收起旧尝试',
            now,
          );
        }
        if (readTaskIds.length) store.readTaskNotices(readTaskIds);
        store.dispositions.set('resource', input.ids, 'completed', input.note, now);
        return { ok: true, updated: input.ids.length };
      }

      // input.kind === 'resource', input.state === 'active'
      store.dispositions.set('resource', input.ids, 'active');
      if (input.cascadeDeliveries) {
        const restoreDeliveryIds: string[] = [];
        for (const resourceId of input.ids) {
          for (const unit of resourceUnits(store, resourceId, allHeaders, headersBySite)) {
            if (store.dispositions.get('delivery', unit.id)?.state === 'completed') {
              restoreDeliveryIds.push(unit.id);
            }
          }
        }
        if (restoreDeliveryIds.length) store.dispositions.set('delivery', restoreDeliveryIds, 'active');
      }
      return { ok: true, updated: input.ids.length };
    });
  });
}
