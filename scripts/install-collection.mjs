#!/usr/bin/env node
// Provision only the project-owned runtime. Never modify global Python packages.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engine = resolve(root, 'engines/site-harvest');
const runtime = resolve(process.env.EVALUATOR_DATA_DIR || resolve(root, '.data'), 'collection-runtime');
const windows = process.platform === 'win32';
const python = resolve(runtime, windows ? 'Scripts/python.exe' : 'bin/python');
const checkOnly = process.argv.includes('--check');
const run = (command, args, options = {}) => spawnSync(command, args, {
  cwd: root, encoding: 'utf8', windowsHide: true, ...options,
});
const probeCode = 'import sys; assert sys.version_info[:2] == (3,12), "Python 3.12 required"; print(sys.executable)';
const candidates = process.env.COLLECTION_PYTHON
  ? [[process.env.COLLECTION_PYTHON, []]]
  : windows ? [['py', ['-3.12']], ['python', []]] : [['python3.12', []], ['python3', []]];

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(python)) {
  if (checkOnly) fail('Collection runtime is missing. Run npm run install:collection with Python 3.12 available.');
  let selected;
  for (const [binary, prefix] of candidates) {
    const result = run(binary, [...prefix, '-c', probeCode]);
    if (result.status === 0) { selected = [binary, prefix]; break; }
  }
  if (!selected) fail('Python 3.12 was not found. Set COLLECTION_PYTHON to a managed Python 3.12 executable and retry.');
  mkdirSync(dirname(runtime), { recursive: true });
  const created = run(selected[0], [...selected[1], '-m', 'venv', runtime], { stdio: 'inherit' });
  if (created.status !== 0) fail('Unable to create the project-owned collection runtime.');
}

const versionCheck = run(python, ['-c', probeCode]);
if (versionCheck.status !== 0) fail('Existing collection runtime is incompatible; preserve task data and provision a compatible runtime separately.');
const dependencyCheck = run(python, ['-c', 'import lxml; assert lxml.__version__ == "6.1.1"']);
if (dependencyCheck.status !== 0) {
  if (checkOnly) fail('Collection dependency mismatch: lxml 6.1.1 is required.');
  const installed = run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:',
    '-r', resolve(engine, 'requirements.lock')], { stdio: 'inherit' });
  if (installed.status !== 0) fail('Collection dependency installation failed; project data and existing configuration were preserved.');
}

const check = run(python, ['-B', resolve(engine, 'bridge.py')], {
  input: JSON.stringify({ protocolVersion: 1, operation: 'selfcheck' }),
});
if (check.status !== 0) fail(check.stderr || 'Collection bridge selfcheck failed.');
const result = JSON.parse(check.stdout);
if (!result.ok || !result.result.runtime.compatible) fail('Collection bridge selfcheck is incompatible.');
const manifest = { ...result.result.runtime, provisionedAt: new Date().toISOString(),
  os: process.platform, architecture: process.arch, runtimeDirectory: runtime };
if (!checkOnly) writeFileSync(resolve(runtime, 'component-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, python, runtime: manifest }, null, 2));
