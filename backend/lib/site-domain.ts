import { URL } from '../runtime.js';
/** 完整主机名作为站点键，不合并子域、www 或根域，不使用来源站域名。 */
export function normalizeSiteDomain(value: string): string {
  const input = value.trim();
  const url = new URL(`https://${input}`);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!input || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || !hostname || hostname.length > 253 || (!/^\[[a-f0-9:]+\]$/.test(hostname) && !hostname.split('.').every((label) => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label)))) throw new Error('站点域名格式不合法');
  return hostname;
}

export function siteDomainFromUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('站点访问地址不合法');
  return normalizeSiteDomain(url.hostname);
}
