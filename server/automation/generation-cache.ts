import { lstat, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

// Regenerable Chromium caches only. Cookies, local storage, sessions and evidence are retained.
export const generationCachePaths = [
  'Default/Cache', 'Default/Code Cache', 'Default/GPUCache', 'Default/DawnGraphiteCache', 'Default/DawnWebGPUCache',
  'GraphiteDawnCache', 'ShaderCache', 'GrShaderCache', 'BrowserMetrics', 'BrowserMetrics-spare.pma',
] as const;

export async function generationCacheEntries(profile: string) {
  try {
    if ((await lstat(profile)).isSymbolicLink()) return [];
    try { await lstat(resolve(profile, 'SingletonLock')); return []; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const entries: string[] = [];
  for (const relative of generationCachePaths) {
    let path = profile, safe = true;
    for (const part of relative.split('/')) {
      path = resolve(path, part);
      try { if ((await lstat(path)).isSymbolicLink()) { safe = false; break; } }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { safe = false; break; } throw error; }
    }
    if (safe) entries.push(relative);
  }
  return entries;
}

/** Call only after the browser has confirmed closure; locked profiles are still skipped. */
export async function trimGenerationBrowserCache(profile: string) {
  const entries = await generationCacheEntries(profile);
  for (const relative of entries) await rm(resolve(profile, relative), { recursive: true, force: true });
  return entries.length;
}

export async function trimTaskGenerationBrowserCache(directory: string, taskId: string, onError?: () => void) {
  try { return await trimGenerationBrowserCache(resolve(directory, 'generation-browsers', taskId)); }
  catch { onError?.(); return 0; }
}

/** Call only after a task reaches a confirmed terminal state; locked profiles and symlinks are skipped. */
export async function removeGenerationBrowserProfile(profile: string): Promise<boolean> {
  try {
    if ((await lstat(profile)).isSymbolicLink()) return false;
    try { await lstat(resolve(profile, 'SingletonLock')); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  await rm(profile, { recursive: true, force: true });
  return true;
}

export async function removeTaskGenerationBrowserProfile(directory: string, taskId: string, onError?: () => void): Promise<boolean> {
  if (!/^[a-f0-9-]{36}$/i.test(taskId)) return false;
  try { return await removeGenerationBrowserProfile(resolve(directory, 'generation-browsers', taskId)); }
  catch { onError?.(); return false; }
}
