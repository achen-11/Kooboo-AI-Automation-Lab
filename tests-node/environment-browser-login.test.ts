import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import type {
  BrowserChannel,
  BrowserLoginContext,
  BrowserLoginCookie,
  BrowserLoginPage,
  BrowserLoginResponse,
  KoobooBrowserLoginDependencies,
} from '../server/lib/kooboo-browser-login.js';

class FakePage implements BrowserLoginPage {
  currentUrl = 'about:blank';
  private listeners: { response: Array<(r: BrowserLoginResponse) => void>; close: Array<() => void> } = {
    response: [],
    close: [],
  };
  constructor(private readonly owner: FakeContext) {}
  url() { return this.currentUrl; }
  async goto(url: string) {
    this.currentUrl = url;
    return null;
  }
  on(event: 'response' | 'close', listener: ((r: BrowserLoginResponse) => void) | (() => void)) {
    if (event === 'response') this.listeners.response.push(listener as (r: BrowserLoginResponse) => void);
    else this.listeners.close.push(listener as () => void);
  }
  emitClose() {
    this.owner.removePage(this);
    for (const cb of [...this.listeners.close]) cb();
  }
}

class FakeContext implements BrowserLoginContext {
  readonly openPages: FakePage[] = [];
  cookiesList: BrowserLoginCookie[] = [];
  closed = false;
  clearedRequests: Array<{ name?: string | RegExp; domain?: string | RegExp }> = [];
  private listeners: { page: Array<(p: BrowserLoginPage) => void>; close: Array<() => void> } = { page: [], close: [] };

  constructor() {
    this.openPages.push(new FakePage(this));
  }
  pages() { return this.openPages; }
  async newPage() {
    const page = new FakePage(this);
    this.openPages.push(page);
    for (const cb of [...this.listeners.page]) cb(page);
    return page;
  }
  openPopup(url = 'https://accounts.google.com/o/oauth2/auth') {
    const popup = new FakePage(this);
    popup.currentUrl = url;
    this.openPages.push(popup);
    for (const cb of [...this.listeners.page]) cb(popup);
    return popup;
  }
  removePage(page: FakePage) {
    const index = this.openPages.indexOf(page);
    if (index >= 0) this.openPages.splice(index, 1);
  }
  async cookies() { return [...this.cookiesList]; }
  async clearCookies(options?: { name?: string | RegExp; domain?: string | RegExp; path?: string | RegExp }) {
    if (options) this.clearedRequests.push({ name: options.name, domain: options.domain });
    this.cookiesList = this.cookiesList.filter((cookie) => {
      if (options?.name && cookie.name !== options.name) return true;
      if (options?.domain && cookie.domain !== options.domain) return true;
      return false;
    });
  }
  on(event: 'page' | 'close', listener: ((p: BrowserLoginPage) => void) | (() => void)) {
    if (event === 'page') this.listeners.page.push(listener as (p: BrowserLoginPage) => void);
    else this.listeners.close.push(listener as () => void);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.openPages.length = 0;
    for (const cb of [...this.listeners.close]) cb();
  }
}

async function setup(deps: KoobooBrowserLoginDependencies) {
  const directory = mkdtempSync(join(tmpdir(), 'browser-login-'));
  const app = await createApp({ directory, serveWeb: false, startWorker: false, browserLoginDependencies: deps });
  const login = await app.app.inject({ method: 'POST', url: '/api/login' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };
  const connection = { id: randomUUID(), name: 'Google SSO Kooboo', origin: 'https://hk.kooboo.test', apiOrigin: 'https://hk.kooboo.test' };
  return {
    ...app,
    directory,
    headers,
    connection,
    async close() {
      await app.app.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('browser login falls back browser channels, tolerates OAuth popups, verifies jwt_token, and encrypts without leaking', async () => {
  const context = new FakeContext();
  const attemptedChannels: BrowserChannel[] = [];
  const validToken = 'google-sso-jwt-token-value';
  const expiredToken = 'stale-invalid-jwt-token';

  const f = await setup({
    pollIntervalMs: 30,
    launchContext: async (_dir, channel) => {
      attemptedChannels.push(channel);
      if (channel === 'chrome') throw new Error("Executable doesn't exist at /Applications/Google Chrome.app");
      return context;
    },
    testEnv: async (env) => {
      if (env.token === validToken) return 7;
      throw new Error('Unauthorized');
    },
  });

  try {
    const otherId = randomUUID();
    f.vault.update({
      threshold: 75,
      paused: true,
      model: { endpoint: '', name: 'deepseek-flash' },
      environments: [{ id: otherId, name: '其他环境', origin: 'https://other.test', apiOrigin: 'https://other.test', token: 'keep-other' }],
    });

    const started = await f.app.inject({
      method: 'POST',
      url: '/api/environments/browser-login/start',
      headers: f.headers,
      payload: f.connection,
    });
    assert.equal(started.statusCode, 200);
    const init = started.json();
    assert.equal(init.status, 'waiting');
    assert.equal(init.browserChannel, 'Microsoft Edge');
    assert.deepEqual(attemptedChannels, ['chrome', 'msedge']);

    // Concurrent start is blocked while session is active
    const concurrent = await f.app.inject({
      method: 'POST',
      url: '/api/environments/browser-login/start',
      headers: f.headers,
      payload: { ...f.connection, id: randomUUID(), origin: 'https://another.test', apiOrigin: 'https://another.test' },
    });
    assert.equal(concurrent.statusCode, 409);

    // Invalid cookie is rejected without ending the session
    context.cookiesList.push({ name: 'jwt_token', value: expiredToken, domain: 'hk.kooboo.test' });
    await new Promise(resolve => setTimeout(resolve, 80));
    const afterInvalid = await f.app.inject({
      method: 'GET',
      url: `/api/environments/browser-login/${init.sessionId}`,
      headers: f.headers,
    });
    assert.equal(afterInvalid.statusCode, 200);
    assert.equal(afterInvalid.json().status, 'waiting');
    assert.equal(context.closed, false);

    // Opening and closing an OAuth popup does NOT cancel the session
    const popup = context.openPopup();
    popup.emitClose();
    await new Promise(resolve => setTimeout(resolve, 200));
    const afterPopup = await f.app.inject({
      method: 'GET',
      url: `/api/environments/browser-login/${init.sessionId}`,
      headers: f.headers,
    });
    assert.equal(afterPopup.json().status, 'waiting');

    // Valid jwt_token cookie arrives after Google login completes
    context.cookiesList = [{ name: 'jwt_token', value: validToken, domain: '.kooboo.test' }];
    let finalState: Record<string, unknown> | undefined;
    for (let i = 0; i < 20; i++) {
      const res = await f.app.inject({
        method: 'GET',
        url: `/api/environments/browser-login/${init.sessionId}`,
        headers: f.headers,
      });
      finalState = res.json();
      if (finalState?.status === 'connected') break;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.equal(finalState?.status, 'connected');
    assert.equal(finalState?.sites, 7);
    assert.ok(!JSON.stringify(finalState).includes(validToken));
    assert.equal(context.closed, true);

    const saved = f.vault.get();
    assert.equal(saved.environments.length, 2);
    assert.equal(saved.environments[0].token, 'keep-other');
    assert.equal(saved.environments[1].token, validToken);
    for (const file of ['settings.enc', 'database.sqlite']) {
      assert.ok(!readFileSync(join(f.directory, file)).includes(Buffer.from(validToken)));
    }
  } finally {
    await f.close();
  }
});

test('browser login clears stale saved jwt_token on re-login and detects environment mismatch', async () => {
  const context = new FakeContext();
  context.cookiesList = [{ name: 'jwt_token', value: 'old-saved-token', domain: 'hk.kooboo.test' }];

  const f = await setup({
    pollIntervalMs: 30,
    launchContext: async () => context,
    testEnv: async () => 3,
  });

  try {
    f.vault.update({
      threshold: 80,
      paused: true,
      model: { endpoint: '', name: '' },
      environments: [{ ...f.connection, token: 'old-saved-token' }],
    });

    const started = await f.app.inject({
      method: 'POST',
      url: '/api/environments/browser-login/start',
      headers: f.headers,
      payload: f.connection,
    });
    const init = started.json();
    assert.equal(init.status, 'waiting');
    assert.ok(context.clearedRequests.some(req => req.name === 'jwt_token' && req.domain === 'hk.kooboo.test'));

    // User lands on another Kooboo workspace origin with jwt_token
    context.openPages[0].currentUrl = 'https://team-de.kooboo.io/_Admin/Sites';
    context.cookiesList = [{ name: 'jwt_token', value: 'de-workspace-token', domain: 'team-de.kooboo.io' }];

    let mismatch: Record<string, unknown> | undefined;
    for (let i = 0; i < 20; i++) {
      const res = await f.app.inject({
        method: 'GET',
        url: `/api/environments/browser-login/${init.sessionId}`,
        headers: f.headers,
      });
      mismatch = res.json();
      if (mismatch?.status === 'environment-mismatch') break;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.equal(mismatch?.status, 'environment-mismatch');
    assert.equal(mismatch?.origin, 'https://team-de.kooboo.io');
    assert.equal(context.closed, true);
    assert.equal(f.vault.get().environments[0].token, 'old-saved-token');
  } finally {
    await f.close();
  }
});

test('browser login requires local session and supports explicit cancel', async () => {
  const context = new FakeContext();
  const f = await setup({
    pollIntervalMs: 50,
    launchContext: async () => context,
    testEnv: async () => 1,
  });

  try {
    for (const headers of [
      {},
      { authorization: `Bearer ${f.vault.credentials.readToken}` },
      { authorization: `Bearer ${f.vault.credentials.ingestToken}`, origin: 'chrome-extension://fixture' },
    ]) {
      const denied = await f.app.inject({
        method: 'POST',
        url: '/api/environments/browser-login/start',
        headers,
        payload: f.connection,
      });
      assert.equal(denied.statusCode, 401);
    }

    const started = await f.app.inject({
      method: 'POST',
      url: '/api/environments/browser-login/start',
      headers: f.headers,
      payload: f.connection,
    });
    const init = started.json();
    assert.equal(init.status, 'waiting');

    const cancelled = await f.app.inject({
      method: 'POST',
      url: `/api/environments/browser-login/${init.sessionId}/cancel`,
      headers: f.headers,
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(context.closed, true);

    const status = await f.app.inject({
      method: 'GET',
      url: `/api/environments/browser-login/${init.sessionId}`,
      headers: f.headers,
    });
    assert.equal(status.json().status, 'cancelled');
  } finally {
    await f.close();
  }
});
