import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const files = readdirSync('tests-node').filter(name => /\.test\.(?:ts|mjs)$/.test(name)).map(name => `tests-node/${name}`);
const result = spawnSync(process.execPath, ['--import','tsx','--test',...files], {stdio:'inherit',env:{...process.env,TSX_TSCONFIG_PATH:'tsconfig.server.json'}});
process.exitCode = result.status ?? 1;
