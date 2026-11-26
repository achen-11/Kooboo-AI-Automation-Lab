import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { generationCacheEntries, removeGenerationBrowserProfile, trimGenerationBrowserCache } from '../server/automation/generation-cache.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const args = process.argv.slice(2), apply = args.includes('--apply');
const option = args.indexOf('--directory');
const directory = resolve(option < 0 ? '.data' : args[option + 1]);
const browsersRoot = resolve(directory, 'generation-browsers');
const db = new DatabaseSync(resolve(directory, 'database.sqlite'), { readOnly: true });
try {
  const candidates = db.prepare("SELECT id, status FROM auto_task_index WHERE status IN ('completed','failed','cancelled','interrupted','pending') AND json_extract(json,'$.stopped')=1").all() as { id: string; status: string }[];
  const dbRows = new Map(candidates.filter(row => typeof row.id === 'string' && uuid.test(row.id)).map(row => [row.id, row.status]));
  const allDiskIds = (() => {
    try { return readdirSync(browsersRoot, { withFileTypes: true }).filter(e => e.isDirectory() && !e.isSymbolicLink() && uuid.test(e.name)).map(e => e.name); }
    catch { return []; }
  })();

  let removedProfiles = 0, trimmedProfiles = 0, cacheEntries = 0;

  for (const id of new Set([...dbRows.keys(), ...allDiskIds])) {
    const profile = resolve(browsersRoot, id);
    const inDb = db.prepare('SELECT status, json_extract(json,\'$.stopped\') AS stopped FROM auto_task_index WHERE id=?').get(id) as { status: string; stopped: number | null } | undefined;
    const isOrphan = !inDb;
    const isTerminalStopped = Boolean(inDb && (inDb.status === 'completed' || inDb.status === 'cancelled') && inDb.stopped === 1);
    const isNonTerminalStopped = Boolean(inDb && ['failed', 'interrupted', 'pending'].includes(inDb.status) && inDb.stopped === 1);

    if (isOrphan || isTerminalStopped) {
      if (apply) {
        const current = db.prepare("SELECT 1 FROM auto_task_index WHERE id=? AND (status IN ('queued','running','following-up','cancelling') OR json_extract(json,'$.stopped')!=1)").get(id);
        if (!current && await removeGenerationBrowserProfile(profile)) removedProfiles++;
      } else {
        const entries = await generationCacheEntries(profile);
        // Count unlocked existing profiles (generationCacheEntries returns [] if locked/missing/symlink, or check existence via lstat if empty of caches).
        if (entries.length || await (async () => { try { const { lstat } = await import('node:fs/promises'); if ((await lstat(profile)).isSymbolicLink()) return false; try { await lstat(resolve(profile, 'SingletonLock')); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT'; } } catch { return false; } })()) {
          removedProfiles++;
        }
      }
      continue;
    }

    if (isNonTerminalStopped) {
      const entries = await generationCacheEntries(profile);
      if (!entries.length) continue;
      trimmedProfiles++;
      const current = db.prepare("SELECT 1 FROM auto_task_index WHERE id=? AND status NOT IN ('queued','running','following-up','cancelling') AND json_extract(json,'$.stopped')=1").get(id);
      if (apply && current) cacheEntries += await trimGenerationBrowserCache(profile);
      else if (!apply) cacheEntries += entries.length;
    }
  }
  console.log(JSON.stringify({ mode: apply ? 'applied' : 'preview', removedProfiles, trimmedProfiles, cacheEntries }));
} finally { db.close(); }
