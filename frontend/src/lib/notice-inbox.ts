import { computed, ref } from 'vue';
import type { CompactNotice, NoticePage } from '../../../shared/task-presentation.js';

export const NOTICE_PAGE_SIZE = 10;
export type NoticeResponse = NoticePage | { items: CompactNotice[] };

function normalizePage(response: NoticeResponse, requestedPage: number) {
  const fields = ['page', 'pages', 'pageSize', 'total', 'unread'] as const;
  if (!Array.isArray(response.items)) throw new Error('Invalid notification list');
  if (fields.some(key => key in response)) {
    const value = response as NoticePage;
    if (!fields.every(key => Number.isSafeInteger(value[key])) || value.page < 1 || value.pages < 1 || value.page > value.pages || value.pageSize < 1 || value.total < value.items.length || value.unread < 0 || value.unread > value.total) throw new Error('Invalid notification pagination');
    return { result: value, legacy: null };
  }
  // Older running services return the entire available list without pagination metadata.
  const total = response.items.length, pages = Math.max(1, Math.ceil(total / NOTICE_PAGE_SIZE));
  const page = Math.min(Math.max(1, requestedPage), pages);
  return { result: { items: response.items.slice((page - 1) * NOTICE_PAGE_SIZE, page * NOTICE_PAGE_SIZE), total,
    unread: response.items.filter(item => item.readAt === null).length, page, pages, pageSize: NOTICE_PAGE_SIZE }, legacy: response.items };
}

function readTimestamp(value: { readAt?: number }): number {
  return typeof value.readAt === 'number' && Number.isFinite(value.readAt) ? value.readAt : Date.now();
}

interface InboxServices {
  fetchPage: (page: number) => Promise<NoticeResponse>;
  markRead: (id: string) => Promise<{ readAt?: number }>;
  markAllRead: () => Promise<{ readAt?: number }>;
  announce: (item: CompactNotice) => void;
  reportError: (message: string) => void;
}

export function createNoticeInbox(services: InboxServices) {
  const items = ref<CompactNotice[]>([]), page = ref(1), pages = ref(1), total = ref(0), unread = ref(0);
  const loading = ref(false), marking = ref(false), error = ref('');
  const busy = computed(() => loading.value || marking.value);
  const seen = new Set<string>();
  let legacyItems: CompactNotice[] | null = null;
  let initialized = false, disposed = false, requestId = 0;

  async function load(target = page.value): Promise<void> {
    if (disposed || marking.value) return;
    const id = ++requestId;
    loading.value = true;
    try {
      // Only the latest page announces arrivals; browsing history must never create new alerts.
      const [latestResponse, currentResponse] = await Promise.all([
        services.fetchPage(1), target === 1 ? Promise.resolve(null) : services.fetchPage(target),
      ]);
      if (disposed || id !== requestId) return;
      const { result: latest, legacy } = normalizePage(latestResponse, 1);
      const result = currentResponse ? normalizePage(currentResponse, target).result : latest;
      for (const item of latest.items) {
        if (initialized && !seen.has(item.id) && item.readAt === null) services.announce(item);
        seen.add(item.id);
      }
      initialized = true;
      legacyItems = legacy;
      items.value = result.items; page.value = result.page; pages.value = result.pages;
      total.value = result.total; unread.value = result.unread; error.value = '';
    } catch {
      if (!disposed && id === requestId) error.value = '通知暂时无法更新，请重试';
    } finally {
      if (id === requestId) loading.value = false;
    }
  }

  async function refresh(): Promise<void> { if (!busy.value) await load(); }

  function beginRead(): void {
    marking.value = true;
    // Discard requests started before this mutation so they cannot restore stale unread state.
    requestId++; loading.value = false;
  }

  function applyRead(item: CompactNotice, readAt: number): void {
    item.readAt = readAt;
    const current = items.value.find(value => value.id === item.id);
    if (current) current.readAt = readAt;
    const legacy = legacyItems?.find(value => value.id === item.id);
    if (legacy) legacy.readAt = readAt;
  }

  async function read(item: CompactNotice): Promise<boolean> {
    if (item.readAt !== null) return true;
    if (disposed || marking.value) return false;
    beginRead();
    try {
      const readAt = readTimestamp(await services.markRead(item.id));
      if (disposed) return false;
      applyRead(item, readAt);
      unread.value = legacyItems ? legacyItems.filter(value => value.readAt === null).length : Math.max(0, unread.value - 1);
      return true;
    } catch {
      if (!disposed) services.reportError('通知暂未标记已读，请重试');
      return false;
    } finally { marking.value = false; }
  }

  async function readAll(): Promise<boolean> {
    if (disposed || marking.value || !unread.value) return false;
    beginRead();
    try {
      if (legacyItems) {
        const pending = legacyItems.filter(item => item.readAt === null);
        let failed = false;
        // The legacy service also lacks the bulk-read endpoint; retain its durable per-item writes.
        for (let offset = 0; offset < pending.length; offset += NOTICE_PAGE_SIZE) {
          const batch = pending.slice(offset, offset + NOTICE_PAGE_SIZE);
          const results = await Promise.allSettled(batch.map(item => services.markRead(item.id)));
          if (disposed) return false;
          results.forEach((result, index) => {
            if (result.status === 'fulfilled') applyRead(batch[index], readTimestamp(result.value));
            else failed = true;
          });
          unread.value = legacyItems.filter(item => item.readAt === null).length;
        }
        if (failed) services.reportError('部分通知未能标记已读，请重试');
        return !failed;
      }
      const readAt = readTimestamp(await services.markAllRead());
      if (disposed) return false;
      for (const item of items.value) if (item.readAt === null) item.readAt = readAt;
      unread.value = 0;
      return true;
    } catch {
      if (!disposed) services.reportError('通知暂未全部标记已读，请重试');
      return false;
    } finally { marking.value = false; }
  }

  return { items, page, pages, total, unread, loading, marking, busy, error, load, refresh, read, readAll,
    dispose() { disposed = true; requestId++; } };
}
