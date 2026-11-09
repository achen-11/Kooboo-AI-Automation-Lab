import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { package: { type: 'string' }, notes: { type: 'string' }, repo: { type: 'string', default: 'achen-11/Kooboo-AI-Automation-Lab' } } });
if (!values.package || !values.notes) throw new Error('用法：npm run release:publish -- --package /path/version.zip --notes /path/notes.md [--repo owner/repo]');
if (!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(values.repo)) throw new Error('仓库标识不合法');
const archive = resolve(values.package), manifestPath = resolve(dirname(archive), 'UPDATE_MANIFEST.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')), bytes = readFileSync(archive);
if (manifest.product !== 'Kooboo AI Automation Lab' || manifest.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(manifest.version) || manifest.archive.name !== archive.split(/[\\/]/).at(-1) || manifest.archive.size !== bytes.length || manifest.archive.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error('更新包与清单不匹配，请重新制作');
if (!existsSync(values.notes)) throw new Error('请提供已准备的更新说明文件');
function gh(args) {
  const result = spawnSync('gh', [...args, '--repo', values.repo], { stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0) throw new Error('GitHub 发布未完成；如已创建草稿，请在发布页检查附件后再发布，勿覆盖既有正式版本');
}
const tag = `v${manifest.version}`;
function objectAt(path) {
  const result = spawnSync('gh', ['api', path], { encoding: 'utf8', shell: false });
  if (result.error || result.status !== 0) throw new Error('无法读取远端版本标签，请先推送对应标签并检查 gh 登录状态');
  return JSON.parse(result.stdout);
}
let object = objectAt(`repos/${values.repo}/git/ref/tags/${tag}`).object;
for (let i = 0; object.type === 'tag' && i < 5; i++) object = objectAt(`repos/${values.repo}/git/tags/${object.sha}`).object;
if (object.type !== 'commit' || object.sha !== manifest.commit) throw new Error('远端版本标签与更新包基线提交不一致，请重新制作并核对标签');
// --verify-tag prevents silently creating an unreviewed release from the default branch.
gh(['release', 'create', tag, '--verify-tag', '--draft', '--title', tag, '--notes-file', resolve(values.notes)]);
gh(['release', 'upload', tag, archive, manifestPath, `${archive}.sha256`]);
gh(['release', 'edit', tag, '--draft=false', '--latest']);
console.log(`已发布 ${tag}，同事可在平台内检查更新。`);
