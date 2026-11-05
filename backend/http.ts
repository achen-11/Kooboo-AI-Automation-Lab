import { ZodError } from 'zod';
import { Conflict } from './lib/store.js';
import { sha256 } from './runtime.js';
import type { Vault } from './lib/vault.js';

export type Request = { method: string; url: string; params: Record<string,string>; query: Record<string,string>; headers: Record<string,string>; body: any };
export class Reply {
  status = 200; value: unknown; sent = false; binaryContent: string | null = null;
  binary(value: string) { this.binaryContent = value; return null; }
  code(code: number) { this.status = code; return this; }
  header(key: string, value: string) { k.response.setHeader(key, value); return this; }
  send(value: unknown) { this.value = value; this.sent = true; return value; }
}
type Handler = (req: Request, reply: Reply) => unknown;
export class Router {
  routes: { method: string; path: string; handler: Handler }[] = [];
  get(path: string, handler: Handler) { this.routes.push({ method: 'GET', path, handler }); }
  post(path: string, handler: Handler) { this.routes.push({ method: 'POST', path, handler }); }
  put(path: string, handler: Handler) { this.routes.push({ method: 'PUT', path, handler }); }
}
function administrator() {
  if (!k.account.isLogin) return false;
  const user = k.account.user.current;
  const org = String(k.site.webSite.organizationId);
  return k.account.user.isOfOrganization(org) && (user.isAdmin || String(user.id).toLowerCase() === org.toLowerCase());
}
export function runRouter(router: Router, vault: Vault) {
  const reply = new Reply();
  try {
    k.response.setHeader('Cache-Control','private, no-store');
    k.response.setHeader('X-Content-Type-Options','nosniff');
    const headers: Record<string,string> = {};
    for (const key of ['Origin','Authorization','Idempotency-Key','Sec-Fetch-Site']) headers[key.toLowerCase()] = String(k.request.headers.get(key) || '');
    const origin = headers.origin;
    const extension = /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
    // Host comes from the site's binding; same-origin cookies never authorize a cross-origin write.
    const sameOrigin = !origin || origin === `https://${k.request.host}` || origin === `http://${k.request.host}`;
    if (origin && !sameOrigin && !extension) return write(reply.code(403), { error: '请求来源不受信任' });
    if (origin && (sameOrigin || extension)) {
      k.response.setHeader('Access-Control-Allow-Origin',origin); k.response.setHeader('Vary','Origin');
      if (!extension) k.response.setHeader('Access-Control-Allow-Credentials','true');
    }
    const method = k.request.method.toUpperCase();
    if (method === 'OPTIONS') {
      k.response.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,OPTIONS');
      k.response.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization,Idempotency-Key');
      k.response.statusCode(204); return;
    }
    let url = k.request.url.replace(/^https?:\/\/[^/]+/i,'');
    const path = url.split('?')[0].replace(/\/$/,'');
    if (path === '/api/login' && method === 'POST') {
      if (extension || !sameOrigin || headers['sec-fetch-site'] === 'cross-site') return write(reply.code(403), { error: '请从评分平台登录' });
      const body = parseBody();
      k.DB.sqlite.execute('CREATE TABLE IF NOT EXISTS evaluator_login_limits (ip TEXT PRIMARY KEY, started INTEGER NOT NULL, attempts INTEGER NOT NULL)');
      const ip = sha256(k.request.clientIp || 'unknown'), now = Date.now();
      let allowed = false;
      k.DB.sqlite.transaction(() => {
        k.DB.sqlite.execute('DELETE FROM evaluator_login_limits WHERE started<@start', { start: now - 900000 });
        k.DB.sqlite.execute('INSERT OR IGNORE INTO evaluator_login_limits VALUES (@ip,@now,0)', { ip, now });
        allowed = k.DB.sqlite.execute('UPDATE evaluator_login_limits SET attempts=attempts+1 WHERE ip=@ip AND attempts<10', { ip }) === 1;
      });
      if (!allowed) return write(reply.code(429), { error: '登录尝试过多，请 15 分钟后重试' });
      if (typeof body.username !== 'string' || typeof body.password !== 'string' || body.username.length > 200 || body.password.length > 1000) return write(reply.code(400), { error: '请输入账号和密码' });
      const user = k.account.login(body.username,body.password);
      if (!user || !administrator()) return write(reply.code(401), { error: '登录失败，或此账号不是站点所属组织的管理员' });
      return write(reply,{ ok: true });
    }
    const admin = !extension && sameOrigin && administrator();
    const token = headers.authorization.replace(/^Bearer /i,'');
    const matches = (value: string) => !!token && sha256(token) === sha256(value);
    const ingest = path === '/api/evaluations' && method === 'POST' && matches(vault.credentials.ingestToken);
    const read = method === 'GET' && /^\/api\/(evaluations(?:\/|$)|jobs\/|sites\/|rules$)/.test(path) && matches(vault.credentials.readToken);
    if (!admin && !ingest && !read) return write(reply.code(401), { error: '请使用站点所属组织的 Kooboo 管理员账号登录，或提供此接口对应的令牌' });
    if (path === '/api/logout' && method === 'POST') { k.account.logout(); return write(reply, { ok: true }); }
    if (path === '/api/session' && method === 'GET') return write(reply, { ok: true });
    const query: Record<string,string> = {};
    const search = url.split('?')[1] || '';
    for (const part of search.split('&')) if (part) { const index = part.indexOf('='); query[decodeURIComponent(index < 0 ? part : part.slice(0,index))] = decodeURIComponent(index < 0 ? '' : part.slice(index+1).replace(/\+/g,' ')); }
    for (const route of router.routes) {
      if (route.method !== method) continue;
      const expected = route.path.split('/'), actual = path.split('/');
      if (actual.length !== expected.length || expected.some((p,n) => !p.startsWith(':') && p !== actual[n])) continue;
      const params: Record<string,string> = {};
      expected.forEach((p,n) => { if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(actual[n]); });
      const value = route.handler({ method, url, headers, query, params, body: ['POST','PUT'].includes(method) ? parseBody() : undefined },reply);
      if (reply.binaryContent !== null) { k.response.binary('image/png',k.security.decodeBase64(reply.binaryContent)); return; }
      return write(reply,reply.sent ? reply.value : value);
    }
    return write(reply.code(404),{ error: '接口不存在' });
  } catch (error) {
    if (error instanceof ZodError) return write(reply.code(400), { error: error.issues.map(x => `${x.path.join('.')}: ${x.message}`).join('；') });
    if (error instanceof Conflict) return write(reply.code(409), { error: error.message });
    return write(reply.code(500), { error: '平台处理失败，请检查服务状态；未生成有效结果' });
  }
}
function parseBody() {
  const text = k.request.body || '{}';
  if (text.length > 1024 * 1024) throw new Conflict('请求超过 1 MB 限制');
  return JSON.parse(text);
}
function write(reply: Reply, value: unknown) { k.response.statusCode(reply.status); k.response.json(value); }
