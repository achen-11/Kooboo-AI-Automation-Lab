#!/usr/bin/env python3
"""Build source + ready-to-load extension handoff; never copy runtime data."""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--plugin', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
plugin = args.plugin.resolve()
output = args.output.resolve()
if output == root or root in output.parents or output == plugin or plugin in output.parents:
    raise SystemExit('输出目录须在两个源码目录之外')
if subprocess.check_output(['git', 'status', '--porcelain'], cwd=root).strip():
    raise SystemExit('请先提交评分平台源码，确保交付版本可追溯')
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
version = json.loads((root / 'package.json').read_text())['version']
plugin_version = json.loads((plugin / 'package.json').read_text())['version']
manifest = json.loads((plugin / 'dist/manifest.json').read_text())
if manifest['version'] != plugin_version:
    raise SystemExit('插件 dist 版本不匹配，请先 npm run build')
digest = hashlib.sha256(base64.b64decode(manifest['key'])).hexdigest()[:32]
extension_id = ''.join(chr(ord('a') + int(char, 16)) for char in digest)
if extension_id != 'phcioeopemeogfbnnoelagoepnhhhldb':
    raise SystemExit('插件固定 ID 发生变化')

def add_tree(files, directory, prefix):
    if not directory.is_dir():
        raise SystemExit(f'缺少目录：{directory}')
    for path in sorted(directory.rglob('*')):
        if path.is_symlink():
            raise SystemExit(f'不打包符号链接：{path}')
        if path.is_file() and path.name != '.DS_Store':
            files[f'{prefix}/{path.relative_to(directory).as_posix()}'] = path.read_bytes()

def validate(files):
    for name in files:
        path = Path(name)
        if any(part in {'.git', '.data', 'node_modules', '.private', '__pycache__'} for part in path.parts):
            raise SystemExit(f'禁止交付目录：{name}')
        if (path.name.startswith('.env') and path.name != '.env.example') or path.name in {'master.key', 'settings.enc'} or path.suffix in {'.sqlite', '.db', '.log'}:
            raise SystemExit(f'禁止交付运行文件：{name}')

platform_files = {}
archive = subprocess.check_output(['git', 'archive', '--format=zip', 'HEAD'], cwd=root)
with zipfile.ZipFile(io.BytesIO(archive)) as source:
    for item in source.infolist():
        if not item.is_dir():
            platform_files[f'evaluator/{item.filename}'] = source.read(item)
for directory in ['dist', 'dist-server']:
    add_tree(platform_files, root / directory, f'evaluator/{directory}')
for required in ['dist/index.html', 'dist-server/server/main.js']:
    if not (root / required).is_file():
        raise SystemExit(f'缺少构建产物：{required}')

plugin_files = {}
add_tree(plugin_files, plugin / 'dist', 'plugin/dist')
for directory in ['src', 'public', 'scripts', 'tests', 'examples', 'docs']:
    add_tree(plugin_files, plugin / directory, f'plugin/source/{directory}')
for name in ['package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', '.gitignore', 'popup.html', 'builder.html', 'runner.html', 'README.md', 'ADMIN_INTEGRATION.md', 'EVALUATION_INTEGRATION.md', 'BATCH_EVALUATION_SOP.md']:
    plugin_files[f'plugin/source/{name}'] = (plugin / name).read_bytes()
for name in ['USER_GUIDE.md', 'CODEX_INTEGRATION.md']:
    plugin_files[f'plugin/docs/{name}'] = (plugin / 'docs' / name).read_bytes()
for name in ['README.md', 'ADMIN_INTEGRATION.md', 'EVALUATION_INTEGRATION.md', 'BATCH_EVALUATION_SOP.md']:
    plugin_files[f'plugin/{name}'] = (plugin / name).read_bytes()

readme = '''# Kooboo 团队交付包

- 安装插件：Chrome 扩展管理页打开开发者模式，加载 plugin/dist。
- 插件使用：plugin/docs/USER_GUIDE.md。
- 启动评分平台：进入 evaluator，安装 Node.js 24+，依次执行 npm ci、npm run install:browser、npm run install:collection、npm run build、npm start。
- 评分平台使用/部署/Git 更新：evaluator/docs/HANDOFF.md。
- Admin 查询协议：evaluator/docs/PUBLIC_API.md；可运行示例：evaluator/examples/admin-query.mjs。
- Admin 发起建站：plugin/ADMIN_INTEGRATION.md。
- 同事的 Codex：plugin/docs/CODEX_INTEGRATION.md 和 evaluator/docs/CODEX_INTEGRATION.md。

源码和构建产物已提供，仍需自行安装依赖、Chromium 和 Python 3.12，配置模型与 Kooboo 环境；内置采集引擎与 SOP 不依赖个人 skill，Python 本体未打包，代码隔离修复当前仅支持 macOS。包内没有交付者的运行数据库、模型 Key、Chrome 登录或目录授权；Launch 定制凭证属于插件实现，仅限授权团队内部分享。迁移不会自动改变评分平台的站点身份。

ZIP 不带 Git 元数据。远程仓库建立后优先 clone；已有 ZIP 安装的数据按 HANDOFF.md 停机转移，之后 git pull --ff-only、npm ci、安装浏览器、构建并重启。插件更新仍需重新加载扩展。

分别压缩的 plugin/evaluator 包与组合包内容相同，选择一种解压即可。manifest.json 记录版本、平台提交和逐文件 SHA-256；SHA256SUMS 校验压缩包完整性。
'''
all_files = {**platform_files, **plugin_files, 'READ_FIRST.md': readme.encode()}
validate(all_files)
inventory = {'schemaVersion': 1, 'evaluatorVersion': version, 'evaluatorCommit': commit, 'pluginVersion': plugin_version,
             'extensionId': extension_id, 'runtime': 'Node.js >=24; Python 3.12; install dependencies, Playwright Chromium and project collection runtime on destination',
             'collectionComponents': ['engines/site-harvest', 'sop/automation-collection-v1', 'scripts/install-collection.mjs'],
             'files': {name: hashlib.sha256(data).hexdigest() for name, data in sorted(all_files.items())}}
def metadata(files):
    return (json.dumps({**inventory, 'files': {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}}, ensure_ascii=False, indent=2) + '\n').encode()

inventory_bytes = metadata(all_files)
output.mkdir(parents=True, exist_ok=True)

def write_zip(name, files):
    path = output / name
    if path.exists():
        raise SystemExit(f'输出已存在，使用新目录避免覆盖交付物：{path}')
    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(files.items()):
            archive.writestr(name, data)
    return path

archives = [write_zip(f'kooboo-plugin-{plugin_version}.zip', {**plugin_files, 'READ_FIRST.md': readme.encode(), 'manifest.json': metadata({**plugin_files, 'READ_FIRST.md': readme.encode()})}),
            write_zip(f'site-evaluator-{version}.zip', {**platform_files, 'READ_FIRST.md': readme.encode(), 'manifest.json': metadata({**platform_files, 'READ_FIRST.md': readme.encode()})}),
            write_zip(f'kooboo-team-plugin-{plugin_version}-evaluator-{version}.zip', {**all_files, 'manifest.json': inventory_bytes})]
(output / 'READ_FIRST.md').write_text(readme)
(output / 'manifest.json').write_bytes(inventory_bytes)
(output / 'SHA256SUMS').write_text(''.join(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n' for path in archives))
print(json.dumps({'output': str(output), 'commit': commit, 'archives': [path.name for path in archives]}, ensure_ascii=False, indent=2))
