import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { removeTaskGenerationBrowserProfile, trimGenerationBrowserCache } from '../server/automation/generation-cache.js';

test('closed browser cache cleanup retains session state and skips native locks and symlink boundaries',async()=>{
  const root=mkdtempSync(resolve(tmpdir(),'generation-cache-')),profile=resolve(root,'profile');
  const file=(name:string)=>{const path=resolve(profile,name);mkdirSync(resolve(path,'..'),{recursive:true});writeFileSync(path,'retained');return path;};
  try{
    const cache=file('Default/Cache/data'),code=file('Default/Code Cache/data'),gpu=file('GraphiteDawnCache/data');
    const preserved=['Default/Cookies','Default/Local Storage/state','Default/IndexedDB/state','Default/Sessions/state','evidence/report.json'].map(file);
    const lock=file('SingletonLock');assert.equal(await trimGenerationBrowserCache(profile),0);assert.ok(existsSync(cache));rmSync(lock);
    assert.equal(await trimGenerationBrowserCache(profile),3);
    assert.ok([cache,code,gpu].every(path=>!existsSync(path)));assert.ok(preserved.every(existsSync));
    const outside=resolve(root,'outside');mkdirSync(outside);writeFileSync(resolve(outside,'proof'),'keep');
    symlinkSync(outside,resolve(profile,'Default/Cache'),'dir');assert.equal(await trimGenerationBrowserCache(profile),0);assert.ok(existsSync(resolve(outside,'proof')));
    const other=resolve(root,'other-profile');mkdirSync(other);symlinkSync(outside,resolve(other,'Default'),'dir');
    assert.equal(await trimGenerationBrowserCache(other),0);assert.ok(existsSync(resolve(outside,'proof')));
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('terminal browser profile removal deletes unlocked profiles, skips locks/symlinks, and validates task ids', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'generation-profile-remove-'));
  const taskId = '11111111-2222-4333-8444-555555555555';
  const profile = resolve(root, 'generation-browsers', taskId);
  try {
    mkdirSync(resolve(profile, 'Default'), { recursive: true });
    writeFileSync(resolve(profile, 'Default/Cookies'), 'cookie');
    const lock = resolve(profile, 'SingletonLock');
    writeFileSync(lock, 'locked');
    assert.equal(await removeTaskGenerationBrowserProfile(root, taskId), false);
    assert.ok(existsSync(profile));
    rmSync(lock);
    assert.equal(await removeTaskGenerationBrowserProfile(root, taskId), true);
    assert.equal(existsSync(profile), false);

    const outside = resolve(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(resolve(outside, 'keep'), 'safe');
    const linkedId = '22222222-3333-4444-8555-666666666666';
    symlinkSync(outside, resolve(root, 'generation-browsers', linkedId), 'dir');
    assert.equal(await removeTaskGenerationBrowserProfile(root, linkedId), false);
    assert.ok(existsSync(resolve(outside, 'keep')));

    assert.equal(await removeTaskGenerationBrowserProfile(root, '../escape'), false);
    assert.equal(await removeTaskGenerationBrowserProfile(root, 'not-a-uuid'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
