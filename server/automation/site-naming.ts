import { bindingDomain, generationSiteNames, generatedSiteName, parseRootDomains, rootDomainLabel, siteNamingError, splitBindingDomain, type KoobooRootDomain } from '../../shared/kooboo-domains.js';
import type { AutomationTask, GeneratedSite, InputVersion } from '../../shared/automation.js';
import { GenerationInputError } from './errors.js';

type AvailabilityRequest = (path: string) => Promise<unknown>;

/** Project saved identity first; older unstarted tasks can derive the same defaults as creation. */
export function taskSiteNaming(task: AutomationTask, version?: InputVersion, site?: GeneratedSite, knownRoots: string[] = []) {
  const generation = task.generation;
  const names = generationSiteNames(generation || {}, version || {});
  const rootDomain = generation?.rootDomain || version?.rootDomain;
  let parsed: ReturnType<typeof splitBindingDomain>;
  if (site) {
    try { parsed = splitBindingDomain(site.preferredDomain || new URL(site.url).hostname, parseRootDomains([...(rootDomain ? [rootDomain] : []), ...knownRoots])); }
    catch { /* A missing or invalid historical URL cannot establish its subdomain. */ }
  }
  const pendingName = generation?.createAttempted ? `auto-${task.id.slice(0, 12)}` : generatedSiteName(task.id);
  const siteName = site?.name || generation?.siteName || (!task.generatedSiteId ? generation?.createAttempted ? pendingName : names.siteName || pendingName : undefined);
  const subDomain = parsed?.subDomain || generation?.subDomain || (!task.generatedSiteId ? generation?.createAttempted ? siteName : names.subDomain || siteName : undefined);
  return { siteName, subDomain, rootDomain: parsed?.root.domainName || rootDomain };
}

function suffixedName(base: string, index: number, limit: number) {
  if (!index) return base;
  const suffix = `_${index}`;
  if (limit <= suffix.length) throw new GenerationInputError('根域名过长，无法添加子域名后缀');
  return base.slice(0, limit - suffix.length) + suffix;
}

export function assertSiteNaming(siteName: string, subDomain: string, root: KoobooRootDomain) {
  for (const [value, label] of [[subDomain, '子域名'], [siteName, '站点名称']] as const) {
    const error = siteNamingError(value, label);
    if (error) throw new GenerationInputError(error);
  }
  const host = bindingDomain(subDomain, root);
  if (host.length > 253 || host.split('.').some(label => label.length > 63))
    throw new GenerationInputError('完整域名过长，请缩短子域名');
}

/** Only explicit false means occupied. Unknown availability must never trigger creation. */
export async function availableSiteNames(siteName: string, subDomain: string, root: KoobooRootDomain, request: AvailabilityRequest) {
  const suffix = rootDomainLabel(root);
  const domainLimit = Math.min(63 - suffix.split('.')[0]!.length, 253 - suffix.length);
  let nameIndex = 0, domainIndex = 0;
  for (let attempt = 0; attempt < 100; attempt++) {
    const name = suffixedName(siteName, nameIndex, 63);
    const domain = suffixedName(subDomain, domainIndex, domainLimit);
    assertSiteNaming(name, domain, root);
    const [nameFree, domainFree] = await Promise.all([
      request(`Site/IsUniqueName?SiteName=${encodeURIComponent(name)}`),
      request(`Site/IsSubdomainAvailable?RootDomain=${encodeURIComponent(root.domainName)}&SubDomain=${encodeURIComponent(domain)}`),
    ]);
    if (typeof nameFree !== 'boolean' || typeof domainFree !== 'boolean')
      throw new GenerationInputError('无法确认站点名称或子域名是否可用，请稍后重试');
    if (nameFree && domainFree) return { siteName: name, subDomain: domain };
    if (!nameFree) nameIndex++;
    if (!domainFree) domainIndex++;
  }
  throw new GenerationInputError('站点名称或子域名连续 100 次被占用，请更换名称后新建任务');
}
