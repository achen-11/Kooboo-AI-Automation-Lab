import type { KoobooConnectionInput, KoobooLoginResult } from '../../shared/kooboo-auth.js';
import { testEnvironment } from './kooboo.js';

export class KoobooLoginError extends Error {}
type LoginOutcome = Exclude<KoobooLoginResult, { status: 'connected' }> | { status: 'authenticated'; token: string; sites: number };

function responseMessages(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(item => typeof item === 'string' ? [item] : []);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return ['messages', 'Messages', 'message', 'Message', 'error', 'Error'].flatMap(key =>
    typeof record[key] === 'string' ? [record[key] as string] : Array.isArray(record[key]) ? (record[key] as unknown[]).filter((item): item is string => typeof item === 'string') : []);
}

/** Never forward an upstream error body: it can contain submitted passwords or tokens. */
export async function loginKooboo(connection: KoobooConnectionInput, credentials: { username: string; password: string; code?: string }): Promise<LoginOutcome> {
  const signal = AbortSignal.timeout(25000);
  let response: Response, body: unknown;
  try {
    response = await fetch(`${connection.apiOrigin}/_api/v2/User/Login`, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({ username: credentials.username, password: credentials.password, withToken: true, ...(credentials.code ? { code: credentials.code } : {}) }),
      redirect: 'manual', signal,
    });
    const text = await response.text();
    if (text.length > 100000) throw new Error('oversized response');
    try { body = JSON.parse(text); } catch { body = text; }
  } catch { throw new KoobooLoginError('无法连接 Kooboo，请检查平台访问地址与服务状态'); }

  const messages = responseMessages(body);
  const method = messages.map(text => /^NeedVerifyCode\s+(email|tel|otp)\b/.exec(text.trim())?.[1]).find(Boolean);
  if (method) return { status: 'verification-required', method: method as 'email' | 'tel' | 'otp' };
  if (messages.some(text => text.trim() === 'VerifyCodeError')) throw new KoobooLoginError('验证码不正确或已过期，请重新输入');
  if (response.status === 429 || messages.some(text => /temporarily lockout|temporarily locked|尝试过于频繁|暂时锁定/i.test(text))) throw new KoobooLoginError('登录尝试过于频繁，请稍后再试');
  if (response.status >= 300 && response.status < 400) throw new KoobooLoginError('登录接口发生跳转，请填写 Kooboo 实际环境地址后重试');
  const failed = body && typeof body === 'object' && ('success' in body && body.success === false || 'Success' in body && body.Success === false);
  if (!response.ok || failed) throw new KoobooLoginError('登录失败，请检查账号、密码以及该账号的环境访问权限');
  const token = response.headers.get('access_token') || response.headers.get('accesstoken');
  if (!token || token.length > 10000) throw new KoobooLoginError('Kooboo 未返回访问令牌，请确认该环境支持账号登录，或使用手动令牌连接');

  // Cloud login may belong to another Kooboo server. Ask the operator to choose it;
  // never forward a password/token to a destination supplied by a remote response.
  if (response.headers.get('IsOnlineServer')?.toLowerCase() === 'true') {
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      if (typeof payload.redirect === 'string' && payload.redirect) {
        const target = new URL(`https://${payload.redirect}`);
        if (target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('invalid redirect');
        if (target.hostname !== new URL(connection.origin).hostname) return { status: 'environment-mismatch', origin: target.origin };
      }
    } catch { /* Tokens without redirect claims use the explicitly configured connection. */ }
  }
  try {
    const sites = await testEnvironment({ ...connection, token }, signal);
    return { status: 'authenticated', token, sites };
  } catch { throw new KoobooLoginError('已取得登录凭据，但无法读取此环境的站点；请检查平台访问地址和账号权限'); }
}
