export interface KoobooRootDomain {
  domainName: string;
  sudDomainUseDash: boolean;
}

export function normalizeRootDomain(value: string): string {
  return value.trim().replace(/^\./, '').toLowerCase();
}

export function rootDomainLabel(domain: KoobooRootDomain): string {
  return (domain.sudDomainUseDash ? '-' : '.') + domain.domainName;
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
    domains.set(domainName, { domainName, sudDomainUseDash: item?.sudDomainUseDash === true || item?.SudDomainUseDash === true });
  }
  return [...domains.values()];
}
