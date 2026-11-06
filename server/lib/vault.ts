import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PublicSettings, RuntimeSettings } from '../../shared/types.js';
import { settingsSchema } from './validation.js';

export class Vault {
  private key: Buffer;
  private file: string;
  private current: RuntimeSettings;
  readonly credentials: PublicSettings['credentials'];
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keyFile = resolve(directory, 'master.key');
    if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = readFileSync(keyFile);
    this.file = resolve(directory, 'settings.enc');
    this.current = { execution: { timeoutSeconds: 300, captureAttempts: 2 }, threshold: 80, paused: false, model: { endpoint: '', name: '', apiKey: '' }, environments: [] };
    this.credentials = { ingestToken: randomUUID() + randomUUID(), readToken: randomUUID() + randomUUID() };
    if (existsSync(this.file)) {
      const packed = readFileSync(this.file);
      const decipher = createDecipheriv('aes-256-gcm', this.key, packed.subarray(0, 12));
      decipher.setAuthTag(packed.subarray(12, 28));
      const saved = JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString());
      this.current = { ...saved.settings, execution: saved.settings.execution || { timeoutSeconds: 300, captureAttempts: 2 } };
      this.credentials = saved.credentials;
    } else this.persist();
    chmodSync(keyFile, 0o600);
  }
  private persist(): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const content = Buffer.concat([cipher.update(JSON.stringify({ settings: this.current, credentials: this.credentials })), cipher.final()]);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, Buffer.concat([iv, cipher.getAuthTag(), content]), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
  private refresh(): void {
    const packed = readFileSync(this.file);
    const decipher = createDecipheriv('aes-256-gcm', this.key, packed.subarray(0, 12));
    decipher.setAuthTag(packed.subarray(12, 28));
    this.current = JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString()).settings;
  }
  get(): RuntimeSettings { this.refresh(); return structuredClone({ ...this.current, execution: this.current.execution || { timeoutSeconds: 300, captureAttempts: 2 } }); }
  public(): PublicSettings {
    this.refresh();
    const { model, environments, ...rest } = this.current;
    return { ...rest, execution: this.current.execution || { timeoutSeconds: 300, captureAttempts: 2 }, model: { endpoint: model.endpoint, name: model.name, hasApiKey: Boolean(model.apiKey) }, environments: environments.map(({ token, ...env }) => ({ ...env, hasToken: Boolean(token) })), credentials: this.credentials };
  }
  importInitial(settings: unknown, credentials: PublicSettings['credentials']): void {
    const input = settingsSchema.parse(settings);
    if (!credentials || ![credentials.ingestToken, credentials.readToken].every(token => typeof token === 'string' && token.length >= 32 && token.length < 201)) throw new Error('迁移令牌不合法');
    if (this.current.model.endpoint || this.current.environments.length) throw new Error('目标已有配置，不能覆盖');
    this.current = { ...input, model: { endpoint: input.model.endpoint, name: input.model.name, apiKey: input.model.apiKey || '' }, environments: input.environments.map(env => ({ id: env.id, name: env.name, origin: env.origin, apiOrigin: env.apiOrigin, token: env.token || '' })) };
    Object.assign(this.credentials, credentials);
    this.persist();
  }
  update(raw: unknown): PublicSettings {
    const input = settingsSchema.parse(raw);
    this.refresh();
    this.current = {
      threshold: input.threshold, paused: input.paused, execution: input.execution,
      model: { endpoint: input.model.endpoint.replace(/\/$/, ''), name: input.model.name, apiKey: input.model.clearKey ? '' : input.model.apiKey || this.current.model.apiKey },
      environments: input.environments.map((env) => ({
        id: env.id, name: env.name, origin: env.origin, apiOrigin: env.apiOrigin,
        token: env.clearToken ? '' : env.token || this.current.environments.find((old) => old.id === env.id)?.token || '',
      })),
    };
    this.persist();
    return this.public();
  }
}
