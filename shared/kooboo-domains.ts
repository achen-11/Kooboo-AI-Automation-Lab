export interface KoobooRootDomain {
  domainName: string;
  sudDomainUseDash: boolean;
}

type SiteNaming = { siteName?: string; subDomain?: string };

export function generationSiteNames(input: SiteNaming, resource: SiteNaming): SiteNaming {
  return {
    siteName: (input.siteName || resource.siteName || input.subDomain || resource.subDomain)?.trim().toLowerCase(),
    subDomain: (input.subDomain || resource.subDomain || input.siteName || resource.siteName)?.trim().toLowerCase(),
  };
}

/** Validate only the supplied name, never a binding host or root-domain suffix. */
export function siteNamingError(value: string, label: string): string {
  if (value.includes('-')) return `${label}不能包含连字符（-），请改用下划线（_）`;
  return /^[a-z0-9_]{1,63}$/i.test(value) ? '' : `${label}只能使用英文字母、数字和下划线（_），最多 63 个字符`;
}

export function normalizeRootDomain(value: string): string {
  return value.trim().replace(/^\./, '').toLowerCase();
}

export function rootDomainLabel(domain: KoobooRootDomain): string {
  if (domain.domainName.startsWith('-')) return domain.domainName;
  return (domain.sudDomainUseDash ? '-' : '.') + domain.domainName;
}

/** Match saved roots with or without Kooboo's leading separator; send the server's value back verbatim. */
export function findRootDomain(domains: KoobooRootDomain[], value: string): KoobooRootDomain | undefined {
  const normalized = normalizeRootDomain(value);
  return domains.find(domain => domain.domainName === normalized)
    || domains.find(domain => domain.domainName.replace(/^-/, '') === normalized.replace(/^-/, ''));
}

export function splitBindingDomain(host: string, domains: KoobooRootDomain[]) {
  const root = [...domains].sort((a, b) => rootDomainLabel(b).length - rootDomainLabel(a).length)
    .find(domain => host.endsWith(rootDomainLabel(domain)) && host.length > rootDomainLabel(domain).length);
  return root ? { root, subDomain: host.slice(0, -rootDomainLabel(root).length) } : undefined;
}

/** Kooboo-generated subdomains must never contain UUID hyphens. */
export function generatedSiteName(taskId: string): string {
  return `auto_${taskId.slice(0, 12).replace(/-/g, '_')}`;
}

export function bindingDomain(subDomain: string, root: KoobooRootDomain): string {
  return subDomain + rootDomainLabel(root);
}

export interface SiteDomainOptions {
  site: { id: string; name: string; url: string };
  domains: KoobooRootDomain[];
  rootDomain: string;
  subDomain: string;
}

/** Retain Kooboo's separator metadata; older environments may return strings. */
export function parseRootDomains(value: unknown): KoobooRootDomain[] {
  if (!Array.isArray(value)) throw new Error('Kooboo 未返回有效的根域名列表，请检查环境连接');
  const domains = new Map<string, KoobooRootDomain>();
  for (const item of value) {
    const raw = typeof item === 'string' ? item : item?.domainName || item?.DomainName || item?.domain || item?.name || item?.rootDomain;
    if (typeof raw !== 'string') continue;
    const domainName = normalizeRootDomain(raw);
    if (!domainName || domains.has(domainName)) continue;
    const explicit = item?.sudDomainUseDash ?? item?.SudDomainUseDash;
    const sudDomainUseDash = domainName.startsWith('-') || (typeof explicit === 'boolean' ? explicit
      : /\.(?:kooboo\.io|kooboo\.cn|kooboo\.dev)$/i.test(domainName));
    domains.set(domainName, { domainName, sudDomainUseDash });
  }
  return [...domains.values()];
}
