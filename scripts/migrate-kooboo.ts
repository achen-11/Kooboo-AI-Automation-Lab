import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { importSnapshot, type KoobooSnapshot } from '../server/lib/migration.js';

// Source secrets are read only. Never log the request body, snapshot, keys or tokens.
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} 缺少参数`);
  return args[index + 1];
};
const configuration = parseEnv(readFileSync(option('--source-env', '.env'), 'utf8'));
const destination = resolve(option('--destination', '.data'));
const origin = configuration.KOOBOO_SITE_URL?.replace(/\/$/, '');
const key = configuration.EVALUATOR_VAULT_KEY;
if (!origin || !key || !configuration.KOOBOO_USERNAME || !configuration.KOOBOO_PASSWORD)
  throw new Error('来源配置不完整，请检查源 .env 中的 Kooboo 连接与 vault key');
async function execute() {
  const login = await fetch(`${origin}/_api/v2/user/login`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: configuration.KOOBOO_USERNAME, password: configuration.KOOBOO_PASSWORD, withToken: true }),
  });
  const token = login.headers.get('access_token');
  if (!login.ok || !token) throw new Error('源 Kooboo 登录失败');
  const sitesResponse = await fetch(`${origin}/_api/v2/Site/List`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  if (!sitesResponse.ok) throw new Error('无法确认源站点身份');
  const sites = await sitesResponse.json() as { siteId: string; homePageLink?: string; iFramePreviewUrl?: string }[];
  const matches = sites.filter(site => [site.homePageLink, site.iFramePreviewUrl].some(link => {
    try { return !!link && new URL(link).origin === origin; } catch { return false; }
  }));
  const siteId = option('--site-id', matches.length === 1 ? matches[0].siteId : '');
  if (!siteId) throw new Error('未找到唯一的源站点，请使用 --site-id 明确指定');
  const tables = ['evaluations', 'runs', 'events', 'reviews', 'rule_versions', 'rule_drafts', 'sites', 'evaluator_artifacts'];
  const code = `var tables = ${JSON.stringify(tables)};
var snapshot;
k.DB.sqlite.transaction(function () {
  if (k.DB.sqlite.query("SELECT id FROM runs WHERE status IN ('queued','collecting','scoring') LIMIT 1").length) throw new Error('源站仍有活动任务，迁移前请等待任务结束并暂停队列');
  var vault = JSON.parse(k.security.aesDecrypt(String(k.DB.sqlite.query('SELECT payload FROM evaluator_vault WHERE id=1')[0].payload), ${JSON.stringify(key)}));
  var rows = {};
  for (var n=0;n<tables.length;n++) rows[tables[n]] = Array.from(k.DB.sqlite.query('SELECT * FROM '+tables[n]));
  snapshot = {schemaVersion:1,tables:rows,settings:vault.settings,credentials:vault.credentials};
});
return JSON.stringify(snapshot);`;
  const response = await fetch(`${origin}/_api/v2/AI/CallFunction?SiteId=${encodeURIComponent(siteId)}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'run_kscript', callId: crypto.randomUUID(), arguments: { code } }),
  });
  if (!response.ok) throw new Error(`读取迁移快照失败（HTTP ${response.status}）`);
  const value = await response.json() as { contents?: { result?: unknown }[] };
  let snapshot: unknown = value.contents?.[0]?.result;
  for (let n = 0; n < 3 && typeof snapshot === 'string'; n++) {
    try { snapshot = JSON.parse(snapshot); } catch { throw new Error('源站未返回有效快照，未写入目标'); }
  }
  if (!snapshot || typeof snapshot !== 'object' || !('schemaVersion' in snapshot))
    throw new Error('源站未返回完整快照，请检查源站连接和 vault key；未写入目标');
  const result = importSnapshot(snapshot as KoobooSnapshot, destination);
  console.log(JSON.stringify({ ...result, destination, credentialsPreserved: true }));
}
execute().catch(error => {
  // Do not print native/SDK stack traces that may contain a generated secret-bearing script.
  const safe = error instanceof Error ? error.message : '迁移失败';
  console.error(safe.replaceAll(key || 'missing-key', '[已隐藏]').replaceAll(configuration.KOOBOO_PASSWORD || 'missing-password', '[已隐藏]'));
  process.exitCode = 1;
});
