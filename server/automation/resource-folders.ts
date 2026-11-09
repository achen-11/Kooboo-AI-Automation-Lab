import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ResourceFolder } from '../../shared/resource-library.js';
import { resourceFolderDescendants } from '../../shared/resource-library.js';
import { Conflict } from '../lib/store.js';
import type { Database } from '../runtime.js';

export class ResourceFolders {
  constructor(private db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS auto_resource_folders(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auto_resource_folder_members(resource_id TEXT PRIMARY KEY, folder_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS auto_resource_folder_members_folder ON auto_resource_folder_members(folder_id);`);
    if (!db.prepare('PRAGMA table_info(auto_resource_folders)').all().some(column => column.name === 'parent_id')) db.exec('ALTER TABLE auto_resource_folders ADD COLUMN parent_id TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS auto_resource_folders_parent ON auto_resource_folders(parent_id)');
  }
  list(): ResourceFolder[] {
    return this.db.prepare('SELECT id,name,parent_id AS parentId,created_at AS createdAt FROM auto_resource_folders ORDER BY created_at,id').all();
  }
  assignments(): Map<string, string> {
    return new Map(this.db.prepare('SELECT resource_id,folder_id FROM auto_resource_folder_members').all().map(row => [row.resource_id, row.folder_id]));
  }
  folderId(resourceId: string): string | null {
    return this.db.prepare('SELECT folder_id FROM auto_resource_folder_members WHERE resource_id=?').get(resourceId)?.folder_id ?? null;
  }
  private requireFolder(id: string) {
    if (!this.db.prepare('SELECT id FROM auto_resource_folders WHERE id=?').get(id)) throw new Conflict('文件夹不存在，请刷新后重试');
  }
  save(rawName: string, id?: string, parentId?: string | null): ResourceFolder {
    const name = rawName.trim();
    if (!name || name.length > 100) throw new Conflict('文件夹名称应为 1–100 个字符');
    return this.db.transaction(() => {
      if (id) this.requireFolder(id);
      const folders = this.list();
      const parent = parentId === undefined ? folders.find(folder => folder.id === id)?.parentId || null : parentId;
      if (parent) {
        this.requireFolder(parent);
        if (id && resourceFolderDescendants(folders, id).has(parent)) throw new Conflict('不能将文件夹移入自身或其子文件夹');
      }
      if (folders.some(folder => folder.id !== id && (folder.parentId || null) === parent && folder.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Conflict('当前层级已存在同名文件夹');
      if (id) this.db.prepare('UPDATE auto_resource_folders SET name=?,parent_id=? WHERE id=?').run(name, parent, id);
      else { id = randomUUID(); this.db.prepare('INSERT INTO auto_resource_folders(id,name,created_at,parent_id) VALUES(?,?,?,?)').run(id, name, Date.now(), parent); }
      return this.list().find(folder => folder.id === id)!;
    });
  }
  move(resourceIds: string[], folderId: string | null) {
    return this.db.transaction(() => {
      if (folderId) this.requireFolder(folderId);
      for (const id of resourceIds) if (!this.db.prepare('SELECT id FROM auto_resources WHERE id=?').get(id)) throw new Conflict('资源不存在，请刷新后重试');
      for (const id of resourceIds) {
        if (folderId) this.db.prepare('INSERT INTO auto_resource_folder_members VALUES(?,?) ON CONFLICT(resource_id) DO UPDATE SET folder_id=excluded.folder_id').run(id, folderId);
        else this.db.prepare('DELETE FROM auto_resource_folder_members WHERE resource_id=?').run(id);
      }
    });
  }
  remove(id: string) {
    this.db.transaction(() => {
      this.requireFolder(id);
      for (const folderId of resourceFolderDescendants(this.list(), id)) {
        this.db.prepare('DELETE FROM auto_resource_folder_members WHERE folder_id=?').run(folderId);
        this.db.prepare('DELETE FROM auto_resource_folders WHERE id=?').run(folderId);
      }
    });
  }
}

export function registerResourceFolderApi(app: FastifyInstance, folders: ResourceFolders) {
  const params = z.object({ id: z.string().uuid() });
  const input = z.object({ name: z.string().trim().min(1).max(100), parentId: z.string().uuid().nullable().optional() });
  app.get('/api/automation/resource-folders', async () => ({ items: folders.list() }));
  app.post('/api/automation/resource-folders', async (request, reply) => { const value = input.parse(request.body); return reply.code(201).send(folders.save(value.name, undefined, value.parentId)); });
  app.put('/api/automation/resource-folders/:id', async request => { const value = input.parse(request.body); return folders.save(value.name, params.parse(request.params).id, value.parentId); });
  app.delete('/api/automation/resource-folders/:id', async request => { folders.remove(params.parse(request.params).id); return { ok: true }; });
  app.post('/api/automation/resources/move', async request => {
    const input = z.object({ resourceIds: z.array(z.string().uuid()).min(1).max(1000), folderId: z.string().uuid().nullable() }).parse(request.body);
    folders.move(input.resourceIds, input.folderId);
    return { ok: true };
  });
}
