import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { fork } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const manifestPath = resolve(root, 'DELIVERY_MANIFEST.json');
const managed = !existsSync(resolve(root, '.git')) && existsSync(manifestPath) && JSON.parse(readFileSync(manifestPath, 'utf8')).product === 'Kooboo AI Automation Lab';
if (managed) {
  const { runLauncher } = await import(new URL('../dist-server/server/updates/launcher.js', import.meta.url));
  try { await runLauncher(root); } catch (error) { console.error(error instanceof Error ? error.message : '平台启动失败'); process.exitCode = 1; }
} else {
  const child = fork(resolve(root, 'dist-server/server/main.js'), [], { cwd: root, execArgv: [], stdio: 'inherit' });
  child.on('error', () => { console.error('平台启动失败，请先运行 npm run build'); process.exitCode = 1; });
  for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => { if (!child.killed) child.kill(event); });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
