import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { bindingDomain, generatedSiteName, parseRootDomains, findRootDomain, splitBindingDomain } from '../../shared/kooboo-domains.js';
import type { GeneratedSite } from '../../shared/automation.js';
import type { AutomationStore } from './store.js';
import type { Vault } from '../lib/vault.js';
import { Conflict } from '../lib/store.js';
import { rootDomainSchema, siteNameSchema } from '../lib/validation.js';
import { koobooClient, siteIdentity } from './kooboo.js';

const params = z.object({ id: z.string().uuid() });
const input = z.object({ rootDomain: rootDomainSchema, subDomain: siteNameSchema }).strict();
const fullName = (binding: any): string => String(binding.fullName || binding.FullName || '').toLowerCase();
const port = (binding: any): number => Number(binding.port ?? binding.Port ?? 0);

async function readBindings(request: ReturnType<typeof koobooClient>['request'], siteId: string) {
  const result = await request('Binding/ListBySite', undefined, siteId);
  if (!Array.isArray(result)) throw new Error('Kooboo 未返回有效的站点绑定列表');
  return result;
}

export function registerSiteDomainApi(app: FastifyInstance, store: AutomationStore, vault: Vault, owns: (id: string) => boolean) {
  const siteFor = (id: string) => { const site = store.site(id); if (!site) throw new Conflict('生成站不存在'); return site; };
  app.get('/api/automation/sites/:id/domains', async request => {
    const site = siteFor(params.parse(request.params).id);
    const client = koobooClient(site, vault, AbortSignal.timeout(60000));
    const [raw, bindings] = await Promise.all([client.request('Domain/Available'), readBindings(client.request, site.siteId)]);
    const domains = parseRootDomains(raw);
    let host = site.preferredDomain || '';
    if (!host && site.url) host = new URL(site.url).hostname.toLowerCase();
    const binding = bindings.find(item => fullName(item) === host && !port(item));
    const parsed = splitBindingDomain(host, domains), root = parsed?.root;
    const sub = binding?.subDomain || binding?.SubDomain || parsed?.subDomain || site.name;
    const suggestion = String(sub).toLowerCase().replace(/-/g, '_');
    return { site: { id: site.id, name: site.name, url: site.url }, domains,
      rootDomain: root?.domainName || domains[0]?.domainName || '',
      subDomain: /^[a-z0-9_]{1,63}$/.test(suggestion) ? suggestion : generatedSiteName(site.id) };
  });
  app.post('/api/automation/sites/:id/domains', async request => {
    const { id } = params.parse(request.params), choice = input.parse(request.body), owner = randomUUID();
    // The executor runs in a separate process: reserve the site in SQLite before any I/O.
    const site = store.db.transaction(() => {
      const site = siteFor(id), tasks = store.headers(id);
      if (store.domainReserved(id) || tasks.some(task => owns(task.id) || !task.stopped || ['following-up', 'cancelling'].includes(task.status) || task.optimization && !['completed', 'stopped'].includes(task.optimization.state) || task.delivery && ['queued', 'running', 'verifying', 'uncertain'].includes(task.delivery.status)))
        throw new Conflict('请先等待或停止此站点的生成、评测、优化及交付，再重新绑定域名');
      if (tasks.some(task => task.kind === 'evaluation' && task.status === 'queued' && store.evaluations.get(task.id))) throw new Conflict('此站点有已保留旧地址证据的待恢复评测，请先取消该评测，再换绑并发起新评测');
      if (store.db.prepare('SELECT site_id FROM auto_migration_read_locks WHERE site_id=? AND expires_at>?').get(id, Date.now())) throw new Conflict('站点正在核验，请稍后重新绑定');
      store.db.prepare('INSERT INTO auto_site_domain_locks VALUES(?,?,?) ON CONFLICT(site_id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at').run(id, owner, Date.now() + 90000);
      return site;
    });
    try {
      const client = koobooClient(site, vault, AbortSignal.timeout(60000));
      const domains = parseRootDomains(await client.request('Domain/Available'));
      const root = findRootDomain(domains, choice.rootDomain);
      if (!root) throw new Conflict('所选根域名已不可用，请重新选择');
      const host = bindingDomain(choice.subDomain, root);
      if (host.length > 253 || host.split('.').some(label => label.length > 63)) throw new Conflict('完整域名过长，请缩短子域名');
      const actual = await client.request('Site/List');
      if (!Array.isArray(actual) || !actual.some(item => siteIdentity(item).toLowerCase() === site.siteId.toLowerCase())) throw new Conflict('原 Kooboo 站点不存在或当前连接无权访问');
      let bindings = await readBindings(client.request, site.siteId);
      let confirmed = bindings.find(item => fullName(item) === host && !port(item));
      if (!confirmed) {
        if (await client.request(`Binding/IsUniqueName?name=${encodeURIComponent(host)}`, undefined, site.siteId) !== true) throw new Conflict('这个域名已被占用，请修改子域名');
        // Post returns void/null. Only a subsequent binding read can confirm success.
        try {
          await client.request('Binding/Post', { rootDomain: root.domainName, subDomain: choice.subDomain }, site.siteId);
        } catch { /* A dropped response can still have committed; reconcile before retrying. */ }
        bindings = await readBindings(client.request, site.siteId);
        confirmed = bindings.find(item => fullName(item) === host && !port(item));
        if (!confirmed) throw new Conflict('域名绑定结果尚未确认，原访问地址已保留；请重试以核对实际绑定');
      }
      const url = new URL(`http://${host}/`);
      if (site.url) url.pathname = new URL(site.url).pathname;
      url.protocol = (confirmed.enableSsl ?? confirmed.EnableSsl) ? 'https:' : 'http:';
      const updated: GeneratedSite = { ...site, url: url.href, preferredDomain: host };
      store.db.transaction(() => {
        const previous = store.site(id)!;
        store.saveSite(updated);
        const changed = previous.url !== updated.url;
        const revision = changed ? randomUUID() : store.siteState(id)?.revision;
        if (changed) store.db.prepare('INSERT INTO auto_site_state VALUES(?,?,NULL) ON CONFLICT(site_id) DO UPDATE SET revision=excluded.revision,report_id=NULL').run(id, revision);
        for (const header of store.headers(id)) {
          const task = store.task(header.id, false)!;
          // Fresh queued reviews have no archived evidence and should score the new address.
          if (changed && task.kind === 'evaluation' && task.status === 'queued') task.siteRevision = revision;
          task.siteUrl = updated.url; store.put(task);
          if (changed) store.event(task.id, `站点域名已绑定：${updated.url}；原地址 ${previous.url || '未确认'}。站点身份与内容保留，历史报告保留，当前地址需重新评测。`);
        }
      });
      return updated;
    } finally {
      store.db.prepare('DELETE FROM auto_site_domain_locks WHERE site_id=? AND owner=?').run(id, owner);
    }
  });
}
