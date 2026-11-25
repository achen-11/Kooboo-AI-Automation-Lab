import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type { KoobooBrowserLoginStatus, KoobooConnectionInput } from '../../shared/kooboo-auth.js';
import type { RuntimeSettings } from '../../shared/types.js';
import { testEnvironment } from './kooboo.js';
import { Conflict } from './store.js';
import type { Vault } from './vault.js';

export class KoobooBrowserLoginError extends Error {}

export interface BrowserLoginCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
}

export interface BrowserLoginResponse {
  url(): string;
  headers(): Record<string, string>;
}

export interface BrowserLoginPage {
  url(): string;
  goto(url: string, options?: { waitUntil?: 'domcontentloaded' | 'load' | 'commit'; timeout?: number }): Promise<unknown>;
  on(event: 'response', listener: (response: BrowserLoginResponse) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
}

export interface BrowserLoginContext {
  pages(): BrowserLoginPage[];
  newPage(): Promise<BrowserLoginPage>;
  cookies(urls?: string | string[]): Promise<BrowserLoginCookie[]>;
  clearCookies?(options?: { name?: string | RegExp; domain?: string | RegExp; path?: string | RegExp }): Promise<void>;
  on(event: 'page', listener: (page: BrowserLoginPage) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  close(): Promise<void>;
}

export type BrowserChannel = 'chrome' | 'msedge' | 'chromium';

export interface KoobooBrowserLoginDependencies {
  launchContext?: (profileDir: string, channel: BrowserChannel) => Promise<BrowserLoginContext>;
  testEnv?: (environment: RuntimeSettings['environments'][number], signal: AbortSignal) => Promise<number>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  retentionMs?: number;
}

interface ActiveSession {
  id: string;
  connection: KoobooConnectionInput;
  expected?: RuntimeSettings['environments'][number];
  ignoredToken: string;
  browserChannel: string;
  status: KoobooBrowserLoginStatus;
  context?: BrowserLoginContext;
  controller: AbortController;
  rejectedTokens: Set<string>;
  headerCandidates: { token: string; origin: string }[];
  pollTimer?: ReturnType<typeof setInterval>;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  checking: boolean;
  finished: boolean;
}

const BROWSER_CHANNELS: readonly BrowserChannel[] = ['chrome', 'msedge', 'chromium'];

function channelLabel(channel: BrowserChannel): string {
  if (channel === 'chrome') return 'Google Chrome';
  if (channel === 'msedge') return 'Microsoft Edge';
  return 'Chromium';
}

function isMissingExecutableError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /executable doesn't exist|not found|cannot find|failed to launch|distribution .* is not installed|chromium.*install|no usable/i.test(text);
}

function normalizeOrigin(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
  } catch {
    // Ignore non-HTTP URLs such as about:blank or chrome://
  }
  return '';
}

function cookieMatchesOrigin(cookie: BrowserLoginCookie, origin: string): boolean {
  if (cookie.expires && cookie.expires > 0 && cookie.expires * 1000 < Date.now()) return false;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  const domain = cookie.domain.toLowerCase();
  if (domain.startsWith('.')) {
    const base = domain.slice(1);
    return host === base || host.endsWith(`.${base}`);
  }
  return host === domain;
}

function readJwtRedirectOrigin(token: string): string {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return '';
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as { redirect?: unknown };
    if (typeof payload.redirect !== 'string' || !payload.redirect) return '';
    const target = new URL(`https://${payload.redirect}`);
    if (target.username || target.password || target.pathname !== '/' || target.search || target.hash) return '';
    return target.origin;
  } catch {
    return '';
  }
}

async function defaultLaunchContext(profileDir: string, channel: BrowserChannel): Promise<BrowserLoginContext> {
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel,
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  });
  return context as unknown as BrowserLoginContext;
}

export class KoobooBrowserLoginManager {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly launchContext: (profileDir: string, channel: BrowserChannel) => Promise<BrowserLoginContext>;
  private readonly testEnv: (environment: RuntimeSettings['environments'][number], signal: AbortSignal) => Promise<number>;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly retentionMs: number;
  private starting = false;

  constructor(
    private readonly directory: string,
    private readonly vault: Vault,
    private readonly activeCredentialLogins: Set<string>,
    dependencies: KoobooBrowserLoginDependencies = {},
  ) {
    this.launchContext = dependencies.launchContext || defaultLaunchContext;
    this.testEnv = dependencies.testEnv || testEnvironment;
    this.pollIntervalMs = dependencies.pollIntervalMs ?? 800;
    this.timeoutMs = dependencies.timeoutMs ?? 5 * 60_000;
    this.retentionMs = dependencies.retentionMs ?? 2 * 60_000;
  }

  get activeCount(): number {
    let count = this.starting ? 1 : 0;
    for (const session of this.sessions.values()) {
      if (!session.finished) count++;
    }
    return count;
  }

  get(sessionId: string): KoobooBrowserLoginStatus | undefined {
    return this.sessions.get(sessionId)?.status;
  }

  async start(connection: KoobooConnectionInput): Promise<KoobooBrowserLoginStatus> {
    if (this.starting || [...this.sessions.values()].some((item) => !item.finished)) {
      throw new Conflict('已有浏览器登录窗口正在打开，请先完成或取消当前登录');
    }
    if (this.activeCredentialLogins.has(connection.id)) {
      throw new Conflict('此环境正在登录，请等待结果');
    }
    const environments = this.vault.get().environments;
    const expected = environments.find((env) => env.id === connection.id);
    if (environments.some((env) => env.id !== connection.id && env.origin === connection.origin)) {
      throw new Conflict('此环境地址已配置，请在原连接中登录');
    }
    if (!expected && environments.length >= 50) {
      throw new Conflict('最多配置 50 个环境');
    }

    this.starting = true;
    const sessionId = randomUUID();
    const profileDir = resolve(this.directory, 'kooboo-login-profile');
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });

    let context: BrowserLoginContext | undefined;
    let chosenChannel: BrowserChannel | undefined;
    let lastLaunchError: unknown;
    try {
      for (const channel of BROWSER_CHANNELS) {
        try {
          context = await this.launchContext(profileDir, channel);
          chosenChannel = channel;
          break;
        } catch (error) {
          lastLaunchError = error;
          if (!isMissingExecutableError(error)) {
            throw new KoobooBrowserLoginError('无法打开登录浏览器窗口，请检查本机浏览器安装状态');
          }
        }
      }
      if (!context || !chosenChannel) {
        throw new KoobooBrowserLoginError(
          lastLaunchError instanceof Error && /profile|SingletonLock|in use/i.test(lastLaunchError.message)
            ? '登录浏览器配置目录正在被占用，请关闭已打开的登录窗口后重试'
            : '未找到可用的 Chrome、Edge 或 Chromium 浏览器，请先安装 Google Chrome 或执行浏览器安装',
        );
      }
    } finally {
      this.starting = false;
    }

    const browserLabel = channelLabel(chosenChannel);
    const session: ActiveSession = {
      id: sessionId,
      connection: { ...connection },
      expected,
      ignoredToken: expected?.token || '',
      browserChannel: browserLabel,
      status: { sessionId, status: 'waiting', browserChannel: browserLabel },
      context,
      controller: new AbortController(),
      rejectedTokens: new Set<string>(),
      headerCandidates: [],
      checking: false,
      finished: false,
    };
    this.sessions.set(sessionId, session);

    if (expected?.token && typeof context.clearCookies === 'function') {
      const hostnames = new Set([new URL(connection.origin).hostname, new URL(connection.apiOrigin).hostname]);
      for (const domain of hostnames) {
        try {
          await context.clearCookies({ name: 'jwt_token', domain });
        } catch {
          // Non-fatal: ignoredToken still prevents stale re-login loops.
        }
      }
    }

    const attachPage = (page: BrowserLoginPage) => {
      page.on('response', (response) => {
        if (session.finished) return;
        const responseOrigin = normalizeOrigin(response.url());
        if (!responseOrigin) return;
        const headers = response.headers();
        const token = headers['access_token'] || headers['accesstoken'];
        if (!token || token.length > 10000) return;
        if (responseOrigin === connection.origin || responseOrigin === connection.apiOrigin) {
          session.headerCandidates.push({ token, origin: responseOrigin });
          void this.inspectSession(session);
        }
      });
      page.on('close', () => {
        if (session.finished) return;
        // OAuth popups (such as Google login) close automatically when finished;
        // only cancel if every page in the persistent context has been closed.
        setTimeout(() => {
          if (session.finished) return;
          if (context.pages().length === 0) {
            void this.finish(session, { sessionId, status: 'cancelled', error: '登录窗口已关闭，未获取到有效访问凭据' });
          }
        }, 150);
      });
    };

    context.on('close', () => {
      if (!session.finished) {
        void this.finish(session, { sessionId, status: 'cancelled', error: '登录窗口已关闭，未获取到有效访问凭据' });
      }
    });
    context.on('page', attachPage);
    for (const existing of context.pages()) attachPage(existing);

    const primaryPage = context.pages()[0] || (await context.newPage());
    const targetUrl = new URL('/_Admin', connection.origin).href;
    void primaryPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {
      if (!session.finished && session.status.status === 'waiting') {
        session.status = {
          sessionId,
          status: 'waiting',
          browserChannel: browserLabel,
          message: '打开登录页较慢，可在浏览器窗口中手动刷新或完成登录',
        };
      }
    });

    session.pollTimer = setInterval(() => {
      void this.inspectSession(session);
    }, this.pollIntervalMs);
    session.pollTimer.unref?.();

    session.timeoutTimer = setTimeout(() => {
      void this.finish(session, {
        sessionId,
        status: 'failed',
        error: '浏览器登录等待超时，请重试',
      });
    }, this.timeoutMs);
    session.timeoutTimer.unref?.();

    void this.inspectSession(session);
    return session.status;
  }

  async cancel(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (!session.finished) {
      await this.finish(session, { sessionId, status: 'cancelled', error: '已取消浏览器登录' });
    }
    return true;
  }

  async closeAll(): Promise<void> {
    const pending = [...this.sessions.values()].map(async (session) => {
      if (!session.finished) {
        await this.finish(session, { sessionId: session.id, status: 'cancelled', error: '服务关闭，登录已中止' });
      }
      if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    });
    await Promise.allSettled(pending);
    this.sessions.clear();
  }

  private async inspectSession(session: ActiveSession): Promise<void> {
    if (session.finished || session.checking || !session.context) return;
    session.checking = true;
    try {
      const cookies = await session.context.cookies();
      if (session.finished) return;

      const candidate = this.nextCandidate(session, cookies);
      if (!candidate) return;

      if (candidate.originMismatch) {
        await this.finish(session, {
          sessionId: session.id,
          status: 'environment-mismatch',
          origin: candidate.originMismatch,
        });
        return;
      }

      session.status = { sessionId: session.id, status: 'verifying' };
      const probeEnv: RuntimeSettings['environments'][number] = {
        ...session.connection,
        token: candidate.token,
      };
      try {
        const sites = await this.testEnv(probeEnv, session.controller.signal);
        if (session.finished) return;
        const redirectOrigin = readJwtRedirectOrigin(candidate.token);
        if (redirectOrigin && redirectOrigin !== session.connection.origin) {
          await this.finish(session, {
            sessionId: session.id,
            status: 'environment-mismatch',
            origin: redirectOrigin,
          });
          return;
        }
        const saved = this.vault.connectEnvironment(session.connection, candidate.token, session.expected);
        await this.finish(session, {
          sessionId: session.id,
          status: 'connected',
          environment: saved,
          sites,
        });
      } catch (error) {
        if (session.finished) return;
        if (error instanceof Conflict) {
          await this.finish(session, {
            sessionId: session.id,
            status: 'failed',
            error: error.message,
          });
          return;
        }
        session.rejectedTokens.add(candidate.token);
        session.status = {
          sessionId: session.id,
          status: 'waiting',
          browserChannel: session.browserChannel,
          message: '等待在浏览器中完成账号登录…',
        };
      }
    } finally {
      session.checking = false;
    }
  }

  private nextCandidate(
    session: ActiveSession,
    cookies: BrowserLoginCookie[],
  ): { token: string; originMismatch?: string } | undefined {
    const isUsable = (token: string) =>
      Boolean(token) && token.length <= 10000 && token !== session.ignoredToken && !session.rejectedTokens.has(token);

    while (session.headerCandidates.length) {
      const header = session.headerCandidates.shift()!;
      if (isUsable(header.token)) return { token: header.token };
    }

    const primaryCookies = cookies.filter(
      (cookie) =>
        cookie.name.toLowerCase() === 'jwt_token' &&
        (cookieMatchesOrigin(cookie, session.connection.origin) || cookieMatchesOrigin(cookie, session.connection.apiOrigin)) &&
        isUsable(cookie.value),
    );
    if (primaryCookies.length) {
      return { token: primaryCookies[0].value };
    }

    // Check if login redirected the user to another Kooboo workspace origin (e.g. cloud subdomain).
    const pages = session.context?.pages() || [];
    for (const page of pages) {
      const pageOrigin = normalizeOrigin(page.url());
      if (!pageOrigin || pageOrigin === session.connection.origin || pageOrigin === session.connection.apiOrigin) continue;
      const otherCookie = cookies.find(
        (cookie) => cookie.name.toLowerCase() === 'jwt_token' && cookieMatchesOrigin(cookie, pageOrigin) && isUsable(cookie.value),
      );
      if (otherCookie) {
        const redirectOrigin = readJwtRedirectOrigin(otherCookie.value) || pageOrigin;
        return { token: otherCookie.value, originMismatch: redirectOrigin };
      }
    }
    return undefined;
  }

  private async finish(session: ActiveSession, status: KoobooBrowserLoginStatus): Promise<void> {
    if (session.finished) return;
    session.finished = true;
    session.status = status;
    if (session.pollTimer) {
      clearInterval(session.pollTimer);
      session.pollTimer = undefined;
    }
    if (session.timeoutTimer) {
      clearTimeout(session.timeoutTimer);
      session.timeoutTimer = undefined;
    }
    session.controller.abort();
    const context = session.context;
    session.context = undefined;
    if (context) {
      await context.close().catch(() => {});
    }
    session.cleanupTimer = setTimeout(() => {
      this.sessions.delete(session.id);
    }, this.retentionMs);
    session.cleanupTimer.unref?.();
  }
}
