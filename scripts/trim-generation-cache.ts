import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { generationCacheEntries, trimGenerationBrowserCache } from '../server/automation/generation-cache.js';

const args = process.argv.slice(2), apply = args.includes('--apply');
const option = args.indexOf('--directory');
const directory = resolve(option < 0 ? '.data' : args[option + 1]);
const db = new DatabaseSync(resolve(directory, 'database.sqlite'), { readOnly: true });
try {
  const candidates = db.prepare("SELECT id FROM auto_task_index WHERE kind='generation' AND status IN ('completed','failed','cancelled','interrupted','pending') AND json_extract(json,'$.stopped')=1").all();
  let profiles = 0, cacheEntries = 0;
  for (const row of candidates) {
    if (typeof row.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(row.id)) continue;
    const profile = resolve(directory, 'generation-browsers', row.id), entries = await generationCacheEntries(profile);
    if (!entries.length) continue;
    profiles++;
    // Recheck durable activity immediately before applying. Never remove the profile itself.
    const current = db.prepare("SELECT 1 FROM auto_task_index WHERE id=? AND status NOT IN ('queued','running','following-up','cancelling') AND json_extract(json,'$.stopped')=1").get(row.id);
    if (apply && current) cacheEntries += await trimGenerationBrowserCache(profile);
    else if (!apply) cacheEntries += entries.length;
  }
  console.log(JSON.stringify({ mode: apply ? 'applied' : 'preview', profiles, cacheEntries }));
} finally { db.close(); }
