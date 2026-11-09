import { readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd(), version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const commit = process.env.AUTOMATION_BUILD_COMMIT || spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).stdout?.trim() || '';
mkdirSync(resolve(root, 'dist-server'), { recursive: true });
const target = resolve(root, 'dist-server/build-info.json');
writeFileSync(target + '.tmp', JSON.stringify({ product: 'Kooboo AI Automation Lab', version, commit, builtAt: new Date().toISOString() }) + '\n');
renameSync(target + '.tmp', target);
