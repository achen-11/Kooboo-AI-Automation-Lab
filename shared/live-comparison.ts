import type { MaterialFile, Scenario } from './automation.js';

export type LiveComparisonSourceKey = 'reference' | 'content';

export interface LiveComparisonSource {
  key: LiveComparisonSourceKey;
  label: string;
  url: string;
  screenshotRoles: ('reference' | 'content')[];
}

export type LiveComparisonEmbedStatus = 'allowed' | 'blocked' | 'unreachable';

export interface LiveEmbedCheck {
  url: string;
  status: LiveComparisonEmbedStatus;
  embeddable: boolean;
  reason?: string;
  finalUrl?: string;
  checkedAt: number;
}

export interface LiveComparisonFallback {
  reportTaskId: string | null;
  historical: boolean;
  items: MaterialFile[];
}

export interface LiveComparisonPayload {
  taskId: string;
  resourceName: string;
  scenario: Scenario;
  referenceUrl: string;
  contentUrl: string;
  targetUrl: string;
  sources: LiveComparisonSource[];
  embedChecks: Record<string, LiveEmbedCheck>;
  fallbackScreenshots: LiveComparisonFallback;
}

export function resolveComparisonSources(input: {
  scenario: Scenario;
  referenceUrl: string;
  contentUrl: string;
}): LiveComparisonSource[] {
  const referenceUrl = input.referenceUrl.trim();
  const contentUrl = input.contentUrl.trim();
  if (referenceUrl && contentUrl && referenceUrl !== contentUrl) {
    return [
      { key: 'reference', label: '参考站', url: referenceUrl, screenshotRoles: ['reference'] },
      { key: 'content', label: '内容站', url: contentUrl, screenshotRoles: ['content'] },
    ];
  }
  if (referenceUrl) {
    return [{ key: 'reference', label: '参考站', url: referenceUrl, screenshotRoles: ['reference', 'content'] }];
  }
  if (contentUrl) {
    const asReference = input.scenario === 'site-template' || input.scenario === 'migration';
    return [{
      key: asReference ? 'reference' : 'content',
      label: asReference ? '参考站' : '内容站',
      url: contentUrl,
      screenshotRoles: ['reference', 'content'],
    }];
  }
  return [];
}

function defaultPort(protocol: string): string {
  return protocol === 'https:' ? '443' : '80';
}

function schemeAllows(sourceScheme: string, parentProtocol: string): boolean {
  const normalized = sourceScheme.toLowerCase().replace(/:$/, '') + ':';
  const actual = parentProtocol.toLowerCase();
  if (normalized === actual) return true;
  // Per W3C CSP3 §6.7.2.1, an http: source expression also matches upgraded https: origins.
  return normalized === 'http:' && actual === 'https:';
}

function matchesCspAncestorToken(rawToken: string, parentUrl: URL, targetUrl: URL): boolean {
  const token = rawToken.trim();
  if (!token) return false;
  const lower = token.toLowerCase();
  if (lower === "'none'") return false;
  if (lower === '*') return parentUrl.protocol === 'http:' || parentUrl.protocol === 'https:';
  if (lower === "'self'") return parentUrl.origin === targetUrl.origin;

  // Scheme-source (e.g. "https:" or "http:")
  if (/^[a-z][a-z0-9+.-]*:$/i.test(token)) {
    return schemeAllows(token, parentUrl.protocol);
  }

  // Host-source: [scheme://]host[:port][/path]
  const match = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.[a-z0-9.-]+|\*|[a-z0-9.-]+|\[[a-f0-9:]+\])(?::(\*|\d+))?(?:\/.*)?$/i.exec(token);
  if (!match) return false;
  const [, schemePart, hostPart, portPart] = match;

  if (schemePart && !schemeAllows(schemePart, parentUrl.protocol)) return false;

  const expectedHost = hostPart.toLowerCase();
  const actualHost = parentUrl.hostname.toLowerCase();
  if (expectedHost === '*') {
    // wildcard host matches any hostname
  } else if (expectedHost.startsWith('*.')) {
    const suffix = expectedHost.slice(1); // ".example.com"
    if (!actualHost.endsWith(suffix) || actualHost.length <= suffix.length) return false;
  } else if (actualHost !== expectedHost) {
    return false;
  }

  const actualPort = parentUrl.port || defaultPort(parentUrl.protocol);
  if (portPart === '*') return true;
  if (portPart) return actualPort === portPart;

  // When port is omitted in CSP host-source, only the scheme's default port matches
  // (or upgraded 443 when http: matched an https: ancestor).
  if (schemePart) {
    const normalizedScheme = schemePart.toLowerCase() + ':';
    if (actualPort === defaultPort(normalizedScheme)) return true;
    return normalizedScheme === 'http:' && parentUrl.protocol === 'https:' && actualPort === '443';
  }
  return actualPort === defaultPort(parentUrl.protocol);
}

function headerList(value?: string | readonly string[] | null): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [value as string];
}

export function evaluateFrameHeaders(
  headers: {
    xFrameOptions?: string | readonly string[] | null;
    contentSecurityPolicy?: string | readonly string[] | null;
  },
  responseUrl: string,
  parentOrigin: string,
): { status: 'allowed' | 'blocked'; embeddable: boolean; reason?: string } {
  let targetUrl: URL;
  let parentUrl: URL;
  try {
    targetUrl = new URL(responseUrl);
    parentUrl = new URL(parentOrigin);
  } catch {
    return { status: 'allowed', embeddable: true };
  }

  const cspPolicies = headerList(headers.contentSecurityPolicy)
    .flatMap(raw => raw.split(','))
    .map(policy => policy.trim())
    .filter(Boolean);

  const frameAncestorsDirectives: string[] = [];
  for (const policy of cspPolicies) {
    for (const directive of policy.split(';')) {
      const trimmed = directive.trim();
      const match = /^frame-ancestors(?:\s+([\s\S]*))?$/i.exec(trimmed);
      if (match) frameAncestorsDirectives.push((match[1] || '').trim());
    }
  }

  // Per W3C CSP Level 2+, any enforced frame-ancestors directive supersedes X-Frame-Options.
  if (frameAncestorsDirectives.length > 0) {
    const allAllow = frameAncestorsDirectives.every(sourceList => {
      const tokens = sourceList.split(/\s+/).filter(Boolean);
      if (!tokens.length || tokens.some(token => token.toLowerCase() === "'none'")) return false;
      return tokens.some(token => matchesCspAncestorToken(token, parentUrl, targetUrl));
    });
    return allAllow
      ? { status: 'allowed', embeddable: true }
      : { status: 'blocked', embeddable: false, reason: '该站点设置了 CSP frame-ancestors 安全策略，禁止在当前平台通过 iframe 嵌入。' };
  }

  const xfoTokens = headerList(headers.xFrameOptions)
    .flatMap(raw => raw.split(','))
    .map(token => token.trim().toUpperCase())
    .filter(Boolean);

  if (xfoTokens.includes('DENY')) {
    return { status: 'blocked', embeddable: false, reason: '该站点设置了 X-Frame-Options: DENY，禁止通过 iframe 嵌入。' };
  }
  if (xfoTokens.includes('SAMEORIGIN') && parentUrl.origin !== targetUrl.origin) {
    return { status: 'blocked', embeddable: false, reason: '该站点设置了 X-Frame-Options: SAMEORIGIN，仅允许同源页面嵌入。' };
  }

  return { status: 'allowed', embeddable: true };
}

export function detectKoobooAdminRedirect(requestedUrl: string, finalUrl?: string): boolean {
  if (!requestedUrl || !finalUrl) return false;
  try {
    const initialPath = new URL(requestedUrl).pathname;
    const finalPath = new URL(finalUrl).pathname;
    return !/^\/_Admin(?:\/|$)/i.test(initialPath) && /^\/_Admin(?:\/|$)/i.test(finalPath);
  } catch {
    return false;
  }
}
