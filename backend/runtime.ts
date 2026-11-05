/** Node-free bindings. One instance belongs to one Kooboo request/job context. */
export const randomUUID = () => {
  const value = k.security.newGuid().replace(/-/g, '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(value)) throw new Error('服务器未生成有效任务标识');
  return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
};
export const sha256 = (value: string) => k.security.sha256(value).toLowerCase();
export const createHash = (_algorithm: string) => ({ update: (value: string) => ({ digest: (_format: string) => sha256(value) }) });

// Jint has no Web URL global. Delegate authority/IDN parsing to Kooboo's URI implementation.
export class URL {
  protocol: string; username: string; password: string; hostname: string; port: string;
  pathname: string; search: string; hash: string; origin: string;
  constructor(value: string) {
    if (!/^https?:\/\//i.test(value) || /[\s\\\u0000-\u001f]/.test(value)) throw new Error('地址不合法');
    const uri = k.utils.uri.parse(value);
    this.protocol = `${uri.scheme.toLowerCase()}:`;
    this.username = uri.userName || ''; this.password = uri.password || '';
    this.hostname = uri.host.toLowerCase();
    this.port = uri.port === (this.protocol === 'https:' ? 443 : 80) ? '' : String(uri.port);
    this.pathname = uri.path || '/'; this.search = uri.query || '';
    this.hash = value.includes('#') ? value.slice(value.indexOf('#')) : '';
    this.origin = `${this.protocol}//${this.hostname}${this.port ? ':' + this.port : ''}`;
  }
  toString() { return this.origin + this.pathname + this.search + this.hash; }
}

/** Translate positional placeholders without touching SQL string literals. */
export function parameters(sql: string, values: unknown[]) {
  let quoted = false, index = 0, output = '';
  const params: Record<string, unknown> = {};
  for (let n = 0; n < sql.length; n++) {
    const c = sql[n];
    if (c === "'") {
      output += c;
      if (quoted && sql[n + 1] === "'") { output += sql[++n]; continue; }
      quoted = !quoted; continue;
    }
    if (!quoted && c === '?') {
      const name = `p${index}`; params[name] = values[index++]; output += '@' + name;
    } else output += c;
  }
  if (index !== values.length) throw new Error('SQL 参数数量不匹配');
  return { sql: output, params };
}
export class Database {
  constructor(_file?: string) {}
  exec(sql: string) { k.DB.sqlite.execute(sql); }
  prepare(sql: string) {
    const all = (...values: unknown[]): any[] => {
      const query = parameters(sql, values);
      return Array.from(k.DB.sqlite.query(query.sql, query.params));
    };
    return { all, get: (...values: unknown[]) => all(...values)[0], run: (...values: unknown[]) => {
      const query = parameters(sql, values);
      return { changes: k.DB.sqlite.execute(query.sql, query.params) };
    } };
  }
  transaction<T>(fn: () => T): T {
    let result!: T;
    // A JS exception escapes this callback so Kooboo disposes the transaction without commit.
    k.DB.sqlite.transaction(() => { result = fn(); });
    return result;
  }
  close() {}
}

export function httpJson(url: string, method: string, body?: unknown, headers: Record<string, string> = {}, seconds = 20): any {
  let response: NativeHttpResponse;
  try {
    response = k.net.httpClient.send(url, method, body === undefined ? undefined : k.net.httpClient.createJsonContent(body), headers, seconds);
  } catch { throw new Error('无法连接接口，请检查地址、网络或请求时限'); }
  if (!response.success) throw new Error(`接口请求失败（HTTP ${response.statusCode}），请检查接口地址、权限及额度`);
  try { return JSON.parse(response.bodyString()); } catch { throw new Error('接口未返回有效 JSON'); }
}
