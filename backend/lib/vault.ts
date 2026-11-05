import { vaultKey } from 'code/evaluator-secret';
import { randomUUID } from '../runtime.js';
import { settingsSchema } from './validation.js';
import { Conflict } from './store.js';
import type { RuntimeSettings, PublicSettings } from '../shared/types.js';

export class Vault {
  constructor() {
    k.DB.sqlite.execute('CREATE TABLE IF NOT EXISTS evaluator_vault (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
    const value = { settings: { threshold: 80, paused: false, model: { endpoint: '', name: '', apiKey: '' }, environments: [] }, credentials: { ingestToken: randomUUID() + randomUUID(), readToken: randomUUID() + randomUUID() } };
    k.DB.sqlite.execute('INSERT OR IGNORE INTO evaluator_vault VALUES (1,@payload)', { payload: k.security.aesEncrypt(JSON.stringify(value), vaultKey) });
  }
  private read(): { settings: RuntimeSettings; credentials: PublicSettings['credentials'] } {
    const row = k.DB.sqlite.query('SELECT payload FROM evaluator_vault WHERE id=1')[0];
    return JSON.parse(k.security.aesDecrypt(String(row.payload), vaultKey));
  }
  get credentials() { return this.read().credentials; }
  get(): RuntimeSettings { return this.read().settings; }
  public(): PublicSettings {
    const { settings, credentials } = this.read();
    return { threshold: settings.threshold, paused: settings.paused, model: { endpoint: settings.model.endpoint, name: settings.model.name, hasApiKey: !!settings.model.apiKey }, environments: settings.environments.map(({ token, ...env }) => ({ ...env, hasToken: !!token })), credentials };
  }
  update(raw: unknown): PublicSettings {
    const input = settingsSchema.parse(raw);
    k.DB.sqlite.transaction(() => {
      const value = this.read();
      const old = value.settings;
      value.settings = { threshold: input.threshold, paused: input.paused,
        model: { endpoint: input.model.endpoint.replace(/\/$/, ''), name: input.model.name, apiKey: input.model.clearKey ? '' : input.model.apiKey || old.model.apiKey },
        environments: input.environments.map(env => ({ id: env.id, name: env.name, origin: env.origin, apiOrigin: env.apiOrigin, token: env.clearToken ? '' : env.token || old.environments.find(x => x.id === env.id)?.token || '' })) };
      k.DB.sqlite.execute('UPDATE evaluator_vault SET payload=@payload WHERE id=1', { payload: k.security.aesEncrypt(JSON.stringify(value), vaultKey) });
    });
    return this.public();
  }
  importInitial(raw: unknown, credentials: PublicSettings['credentials'], migrationId: string) {
    const input = settingsSchema.parse(raw);
    if (!/^[a-f0-9]{64}$/.test(migrationId) || ![credentials.ingestToken,credentials.readToken].every(t => typeof t === 'string' && t.length >= 32 && t.length <= 200)) throw new Conflict('迁移数据格式错误');
    k.DB.sqlite.execute('CREATE TABLE IF NOT EXISTS evaluator_migrations (id INTEGER PRIMARY KEY, source_id TEXT NOT NULL)');
    let duplicate = false;
    k.DB.sqlite.transaction(() => {
      const previous = k.DB.sqlite.query('SELECT source_id FROM evaluator_migrations WHERE id=1')[0];
      if (previous) { if (String(previous.source_id) !== migrationId) throw new Conflict('已完成其他来源的迁移，不能覆盖'); duplicate = true; return; }
      const old = this.get();
      if (old.model.endpoint || old.environments.length || k.DB.sqlite.query('SELECT id FROM evaluations LIMIT 1').length) throw new Conflict('只允许向尚未配置且没有任务的空评分站点导入');
      const settings: RuntimeSettings = { threshold: input.threshold, paused: input.paused, model: { endpoint: input.model.endpoint, name: input.model.name, apiKey: input.model.apiKey || '' }, environments: input.environments.map(e => ({ id:e.id,name:e.name,origin:e.origin,apiOrigin:e.apiOrigin,token:e.token || '' })) };
      k.DB.sqlite.execute('UPDATE evaluator_vault SET payload=@payload WHERE id=1', { payload: k.security.aesEncrypt(JSON.stringify({settings,credentials}),vaultKey) });
      k.DB.sqlite.execute('INSERT INTO evaluator_migrations VALUES (1,@migrationId)',{migrationId});
    });
    return { ok:true, duplicate };
  }
}
