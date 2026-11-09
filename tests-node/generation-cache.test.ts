import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { trimGenerationBrowserCache } from '../server/automation/generation-cache.js';

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
