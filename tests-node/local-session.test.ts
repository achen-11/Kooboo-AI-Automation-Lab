import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionFetch } from '../frontend/src/lib/local-session.js';

test('a missing local session connects automatically and retries the original request once', async () => {
  const calls: { url: string; options?: RequestInit }[] = [];
  const responses = [new Response('{}', { status: 401 }), new Response('{}'), new Response('{"saved":true}')];
  const request = createSessionFetch(async (url, options) => { calls.push({ url: String(url), options }); return responses.shift()!; });
  const options = { method: 'PUT', body: '{"enabled":false}', credentials: 'same-origin' as const };
  assert.equal((await request('/api/automation/settings', options)).status, 200);
  assert.deepEqual(calls.map(call => call.url), ['/api/automation/settings', '/api/login', '/api/automation/settings']);
  assert.equal(calls[1].options?.method, 'POST');
  assert.equal(calls[1].options?.credentials, 'same-origin');
  assert.equal(calls[2].options, options);
});

test('simultaneous unauthorized requests share one local session connection', async () => {
  let logins = 0, connected = false;
  const request = createSessionFetch(async url => {
    if (url === '/api/login') { logins++; await new Promise(resolve => setTimeout(resolve, 5)); connected = true; }
    return new Response('{}', { status: connected ? 200 : 401 });
  });
  const responses = await Promise.all([request('/api/settings', {}), request('/api/health', {})]);
  assert.equal(logins, 1);
  assert.ok(responses.every(response => response.ok));
});

test('forbidden origins never trigger automatic session creation', async () => {
  const calls: string[] = [];
  const request = createSessionFetch(async url => { calls.push(String(url)); return new Response('{}', { status: 403 }); });
  assert.equal((await request('/api/settings', {})).status, 403);
  assert.deepEqual(calls, ['/api/settings']);
});

test('session failures do not loop or replay operations indefinitely', async () => {
  for (const loginStatus of [401, 200]) {
    const calls: string[] = [];
    const request = createSessionFetch(async url => { calls.push(String(url)); return new Response('{}', { status: url === '/api/login' ? loginStatus : 401 }); });
    assert.equal((await request('/api/settings', {})).status, 401);
    assert.equal(calls.length, loginStatus === 200 ? 3 : 2);
  }
});
