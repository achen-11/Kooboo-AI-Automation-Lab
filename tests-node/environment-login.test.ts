import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { defaultDeliveryPolicy } from '../shared/automation.js';

async function fixture(handler: (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) => void | Promise<void>) {
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    response.setHeader('Content-Type', 'application/json');
    await handler(request, response, text ? JSON.parse(text) : {});
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const directory = mkdtempSync(join(tmpdir(), 'environment-login-'));
  const app = await createApp({ directory, serveWeb: false, startWorker: false });
  const session = await app.app.inject({ method: 'POST', url: '/api/login' });
  const headers = { cookie: String(session.headers['set-cookie']).split(';')[0] };
  const connection = { id: randomUUID(), name: '本机', origin: 'https://local.kooboo.test', apiOrigin: origin };
  const credentials = { username: 'colleague', password: 'private-login-password' };
  return { ...app, directory, connection, credentials, headers,
    login: (patch: Record<string, unknown> = {}) => app.app.inject({ method: 'POST', url: '/api/environments/login', headers, payload: { ...connection, ...credentials, ...patch } }),
    async close() { await app.app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('account login validates site access, encrypts only the token and creates an unsaved connection without touching other settings', async () => {
  let loginBody: Record<string, unknown> | undefined, authorization = '';
  const token = 'private-result-access-token';
  const f = await fixture((req, res, body) => {
    if (req.url === '/_api/v2/User/Login') { loginBody = body; res.setHeader('access_token', token); res.end(JSON.stringify({ success: true })); }
    else { assert.equal(req.url, '/_api/v2/Site/List'); authorization = req.headers.authorization || ''; res.end('[{"id":"site"}]'); }
  });
  try {
    const other = { id: randomUUID(), name: '其他连接', origin: 'https://other.test', apiOrigin: 'https://other.test', token: 'retain-other-token', delivery: { ...defaultDeliveryPolicy, enabled: true, token: 'retain-migration-token' } };
    f.vault.update({ ...f.vault.get(), threshold: 73, paused: true, model: { endpoint: '', name: 'retain-model', apiKey: 'retain-model-key' }, environments: [other] });
    const result = await f.login({ username: ' colleague ' });
    assert.equal(result.statusCode, 200); assert.equal(result.json().status, 'connected'); assert.equal(result.json().sites, 1);
    assert.deepEqual(loginBody, { username: 'colleague', password: f.credentials.password, withToken: true });
    assert.equal(authorization, `Bearer ${token}`);
    assert.equal(result.json().environment.hasToken, true);
    assert.ok(!result.body.includes(token)); assert.ok(!result.body.includes(f.credentials.password));
    const saved = f.vault.get(); assert.equal(saved.environments[1].token, token); assert.deepEqual(saved.environments[0], other);
    assert.equal(saved.threshold, 73); assert.equal(saved.paused, true); assert.equal(saved.model.apiKey, 'retain-model-key');
    for (const file of ['settings.enc', 'database.sqlite']) { const bytes = readFileSync(join(f.directory, file)); assert.ok(!bytes.includes(Buffer.from(token))); assert.ok(!bytes.includes(Buffer.from(f.credentials.password))); }
    assert.ok(!JSON.stringify(saved).includes(f.credentials.password));
    assert.equal((await f.app.inject({ url: '/api/settings', headers: f.headers })).json().environments[1].hasToken, true);
    // Reopen the encrypted vault through a second app, as on restart.
    const { Vault } = await import('../server/lib/vault.js');
    assert.equal(new Vault(f.directory).get().environments[1].token, token);
  } finally { await f.close(); }
});

for (const method of ['email', 'tel', 'otp']) test(`account login supports ${method} verification without persisting incomplete credentials`, async () => {
  const f = await fixture((req, res, body) => {
    if (req.url === '/_api/v2/Site/List') { res.end('[]'); return; }
    if (!body.code) { res.statusCode = 500; res.end(JSON.stringify({ messages: [`NeedVerifyCode ${method}`] })); }
    else if (body.code !== '123456') { res.statusCode = 400; res.end(JSON.stringify({ message: 'VerifyCodeError' })); }
    else { res.setHeader('AccessToken', 'verified-token'); res.end('"/_Admin"'); }
  });
  try {
    const challenge = await f.login(); assert.equal(challenge.statusCode, 200); assert.deepEqual(challenge.json(), { status: 'verification-required', method });
    assert.equal(f.vault.get().environments.length, 0);
    const invalid = await f.login({ code: '000000' }); assert.equal(invalid.statusCode, 422); assert.match(invalid.json().error, /验证码/); assert.equal(f.vault.get().environments.length, 0);
    const verified = await f.login({ code: '123456' }); assert.equal(verified.json().status, 'connected'); assert.equal(f.vault.get().environments[0].token, 'verified-token');
  } finally { await f.close(); }
});

test('failed login, missing token and denied site access retain existing credentials and never echo upstream secrets', async () => {
  let mode = 'invalid';
  const f = await fixture((req, res) => {
    if (req.url === '/_api/v2/Site/List') { res.statusCode = 401; res.end('private-result-access-token'); return; }
    if (mode === 'invalid') { res.statusCode = 401; res.end(JSON.stringify({ error: 'private-login-password private-result-access-token' })); }
    else if (mode === 'missing') res.end('"/_Admin"');
    else if (mode === 'false') { res.setHeader('access_token', 'private-result-access-token'); res.end('{"Success":false}'); }
    else if (mode === 'locked') { res.statusCode = 429; res.end('private-login-password'); }
    else { res.setHeader('access_token', 'private-result-access-token'); res.end('{}'); }
  });
  try {
    f.vault.update({ ...f.vault.get(), environments: [{ ...f.connection, token: 'previous-good-token' }] });
    for (const value of ['invalid', 'missing', 'false', 'locked', 'denied']) {
      mode = value; const result = await f.login(); assert.equal(result.statusCode, 422, value);
      assert.ok(!result.body.includes(f.credentials.password)); assert.ok(!result.body.includes('private-result-access-token'));
      assert.equal(f.vault.get().environments[0].token, 'previous-good-token');
    }
  } finally { await f.close(); }
});

test('cloud environment hints and HTTP redirects never forward passwords or tokens to a returned destination', async () => {
  let mode = 'cloud', requests = 0;
  const f = await fixture((_req, res) => {
    requests++;
    if (mode === 'cloud') { res.setHeader('IsOnlineServer', 'true'); res.setHeader('access_token', `header.${Buffer.from(JSON.stringify({ redirect: 'colleague-hk.kooboo.io' })).toString('base64url')}.signature`); res.end('{}'); }
    else { res.statusCode = 302; res.setHeader('Location', 'https://returned-destination.test'); res.end('{}'); }
  });
  try {
    const result = await f.login(); assert.deepEqual(result.json(), { status: 'environment-mismatch', origin: 'https://colleague-hk.kooboo.io' }); assert.equal(requests, 1); assert.equal(f.vault.get().environments.length, 0);
    mode = 'redirect'; assert.equal((await f.login()).statusCode, 422); assert.equal(requests, 2); assert.equal(f.vault.get().environments.length, 0);
  } finally { await f.close(); }
});

test('only the local management session can log in; bad or duplicate connections make no upstream request', async () => {
  let requests = 0;
  const f = await fixture((_req, res) => { requests++; res.end('{}'); });
  try {
    for (const headers of [{}, { authorization: `Bearer ${f.vault.credentials.readToken}` }, { authorization: `Bearer ${f.vault.credentials.ingestToken}`, origin: 'chrome-extension://fixture' }]) {
      const result = await f.app.inject({ method: 'POST', url: '/api/environments/login', headers, payload: { ...f.connection, ...f.credentials } }); assert.equal(result.statusCode, 401);
    }
    assert.equal((await f.login({ apiOrigin: 'file:///tmp/invalid' })).statusCode, 400);
    assert.equal((await f.login({ password: '' })).statusCode, 400);
    f.vault.update({ ...f.vault.get(), environments: [{ ...f.connection, id: randomUUID(), token: 'existing' }] });
    assert.equal((await f.login()).statusCode, 409); assert.equal(requests, 0);
  } finally { await f.close(); }
});

test('an in-flight login cannot resurrect a removed connection', async () => {
  let arrived!: () => void, release!: () => void;
  const pending = new Promise<void>(resolve => { arrived = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async (req, res) => {
    if (req.url === '/_api/v2/User/Login') { arrived(); await gate; res.setHeader('access_token', 'late-token'); res.end('{}'); }
    else res.end('[]');
  });
  try {
    f.vault.update({ ...f.vault.get(), environments: [{ ...f.connection, token: 'old-token' }] });
    const login = Promise.resolve(f.login()); await pending;
    assert.equal((await f.login()).statusCode, 409);
    f.vault.update({ ...f.vault.get(), environments: [] }); release();
    const result = await login; assert.equal(result.statusCode, 409); assert.equal(f.vault.get().environments.length, 0);
  } finally { release(); await f.close(); }
});
