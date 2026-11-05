import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, renameSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
const root = process.cwd();
mkdirSync('.build',{recursive:true});
await build({entryPoints:['backend/entry.ts'],outfile:'.build/evaluator.js',bundle:true,format:'esm',platform:'neutral',target:'es2022',external:['code/evaluator-secret'],minifySyntax:true,minifyIdentifiers:true,legalComments:'none'});
const backend = readFileSync('.build/evaluator.js','utf8');
if (/from ["'](?:node:|zod)/.test(backend) || /\b(?:process|Buffer|fetch|AbortSignal)\./.test(backend)) throw new Error('Backend still requires Node/Web APIs');
await viteBuild({configFile:resolve('frontend/vite.config.ts'),configLoader:'runner'});
const staged = '.build/resources'; rmSync(staged,{recursive:true,force:true});
for (const path of ['page','js/assets','css/assets','code','api','job']) mkdirSync(`${staged}/${path}`,{recursive:true});
const manifest = JSON.parse(readFileSync('frontend/dist/.vite/manifest.json','utf8'));
const entry = Object.values(manifest).find(x => x.isEntry);
if (!entry) throw new Error('Missing SPA manifest entry');
for (const name of readdirSync('frontend/dist/assets')) {
  const type = name.endsWith('.js') ? 'js' : name.endsWith('.css') ? 'css' : null;
  if (!type) throw new Error(`Unmapped static asset ${name}`);
  const declaration = type === 'js' ? `// @k-url /assets/${name}\n` : `/* @k-url /assets/${name} */\n`;
  writeFileSync(`${staged}/${type}/assets/${name}`, declaration + readFileSync(`frontend/dist/assets/${name}`,'utf8'));
}
const html = readFileSync('frontend/dist/index.html','utf8');
if (!html.includes(`/${entry.file}`) || /\/src\/(?:js|css)\//.test(html)) throw new Error('Invalid resource URLs');
writeFileSync(`${staged}/page/app.html`,'<!-- @k-url / -->\n'+html);
writeFileSync(`${staged}/code/evaluator.js`,backend);
// Secret material stays in ignored .env and a non-routable CodeBlock, separately from SQLite.
let env = existsSync('.env') ? readFileSync('.env','utf8') : '';
let key = /^EVALUATOR_VAULT_KEY=(.+)$/m.exec(env)?.[1]?.trim();
if (!key) { key = randomBytes(32).toString('hex'); env += `\nEVALUATOR_VAULT_KEY=${key}\n`; writeFileSync('.env',env,{mode:0o600}); }
chmodSync('.env',0o600);
writeFileSync(`${staged}/code/evaluator-secret.ts`,`export const vaultKey = ${JSON.stringify(key)};\n`,{mode:0o600});
const routes = [
  ['session','/api/session'],['login','/api/login'],['logout','/api/logout'],['health','/api/health'],['settings','/api/settings'],['model/test','/api/model/test'],['migrations/node-v1','/api/migrations/node-v1'],
  ['environments/test','/api/environments/{id}/test'],['rules','/api/rules'],['rule-drafts/index','/api/rule-drafts'],['rule-drafts/item','/api/rule-drafts/{id}'],['rule-drafts/publish','/api/rule-drafts/{id}/publish'],
  ['evaluations/index','/api/evaluations'],['manual-evaluations','/api/manual-evaluations'],['evaluations/item','/api/evaluations/{id}'],['evaluations/runs','/api/evaluations/{id}/runs'],['evaluations/reviews','/api/evaluations/{id}/reviews'],
  ['evaluations/artifact','/api/evaluations/{id}/artifacts/{runId}/{file}'],['sites/latest','/api/sites/{domain}/evaluations/latest'],['sites/history','/api/sites/{domain}/evaluations'],['jobs/latest','/api/jobs/{jobId}/evaluations/latest']
];
for (const [file,url] of routes) {
  const target = `${staged}/api/${file}.ts`; mkdirSync(resolve(target,'..'),{recursive:true});
  writeFileSync(target,`// @k-url ${url}\nimport { dispatch } from 'code/evaluator';\ndispatch();\n`);
}
writeFileSync(`${staged}/job/evaluator.ts`,`/**\n * @jobConfig\n * active: true\n * repeat: true\n * startTime: '2026-11-05T00:00:00Z'\n * frequency: [10, 'second']\n */\nimport { tick } from 'code/evaluator';\ntick();\n`);
// All generated trees are swapped after both builds and URL checks succeeded.
const previous='.build/previous-src'; rmSync(previous,{recursive:true,force:true});
if(existsSync('src'))renameSync('src',previous);
try {renameSync(staged,'src');}catch(error){if(existsSync(previous))renameSync(previous,'src');throw error;}
rmSync(previous,{recursive:true,force:true});
console.log(`Kooboo resources built: ${routes.length} API routes, SPA, evaluator Job`);
