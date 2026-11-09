#!/usr/bin/env python3
"""Build an Automation Lab handoff in isolation; never copy personal runtime data."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile


SOURCE_DIRS = ('frontend', 'server', 'shared', 'sop', 'engines', 'scripts',
               'tests-node', 'tests-python', 'docs', 'examples', 'deploy')
SOURCE_FILES = ('package.json', 'package-lock.json', 'tsconfig.json',
                'tsconfig.server.json', 'tsconfig.server.build.json',
                'tsconfig.web.json', 'README.md', 'AGENTS.md', '.gitignore',
                '.kooboo-ai/specs/frontend.md')
EXCLUDED_DIRS = {'.git', '.data', '.updates', '.private', '.venv', 'venv', 'node_modules',
                 '__pycache__', '.cache', '.pytest_cache', 'dist', 'dist-server'}


def allowed(path):
    return (path.parts[:3] != ('docs', 'ai-app-requirements', 'task-board')
            and not any(part in EXCLUDED_DIRS for part in path.parts)
            and not any(part.startswith('.env') for part in path.parts)
            and path.name not in {'master.key', 'settings.enc', 'kooboo.d.ts', '.DS_Store'}
            and path.suffix.lower() not in {'.db', '.sqlite', '.sqlite3', '.log', '.zip',
                                             '.key', '.pem', '.pfx', '.pyc', '.tsbuildinfo'}
            and not path.name.endswith(('-wal', '-shm')))


def collect_sources(root):
    files = {}

    def visit(path):
        relative = path.relative_to(root)
        if not allowed(relative):
            return
        if path.is_symlink():
            raise RuntimeError(f'不打包符号链接：{relative}')
        if path.is_dir():
            for child in sorted(path.iterdir()):
                visit(child)
        elif path.is_file():
            files[relative.as_posix()] = path.read_bytes()

    for name in SOURCE_FILES:
        if not (root / name).is_file():
            raise RuntimeError(f'缺少交付源码：{name}')
        visit(root / name)
    for name in SOURCE_DIRS:
        if not (root / name).is_dir():
            raise RuntimeError(f'缺少交付目录：{name}')
        visit(root / name)
    # These resources are required at runtime, even though TypeScript does not compile them.
    for name in ('sop/automation-collection-v1/README.md', 'engines/site-harvest/bridge.py',
                 'engines/site-harvest/requirements.lock', 'scripts/install-collection.mjs',
                 'docs/DEPLOYMENT_AND_HANDOFF.md'):
        if name not in files:
            raise RuntimeError(f'缺少运行组件：{name}')
    return files


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def update_manifest(sources, version, commit, snapshot_time, archive_name, archive_bytes):
    if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', version):
        raise RuntimeError('在线更新只发布正式版本号')
    if json.loads(sources['package-lock.json'])['version'] != version:
        raise RuntimeError('package.json 与锁文件版本不一致')
    return {
        'schemaVersion': 1, 'product': 'Kooboo AI Automation Lab', 'version': version,
        'commit': commit, 'publishedAt': snapshot_time, 'minLauncher': 1,
        'dataVersion': 1, 'nodeMajor': 24,
        'collectionLockSha256': sha256(sources['engines/site-harvest/requirements.lock']),
        'platforms': ['darwin', 'win32', 'linux'], 'architectures': ['arm64', 'x64'],
        'archive': {'name': archive_name, 'size': len(archive_bytes), 'sha256': sha256(archive_bytes)},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path, help='新的 ZIP 路径，不覆盖已有文件')
    parser.add_argument('--allow-dirty', action='store_true', help='明确制作含未提交源码的测试快照')
    parser.add_argument('--update', action='store_true', help='同时制作 UPDATE_MANIFEST.json，用于正式发行在线更新')
    parser.add_argument('--reuse-dependencies', action='store_true',
                        help='复用本机 node_modules 构建，不将其打包（macOS/Linux）')
    args = parser.parse_args()
    if args.update and args.allow_dirty:
        raise RuntimeError('在线更新不接受 --allow-dirty 测试快照')
    root = Path(__file__).resolve().parents[1]
    target = args.output.resolve()
    if target.suffix.lower() != '.zip' or target.exists():
        raise RuntimeError('输出必须是尚不存在的 .zip 文件')
    if target == root or root in target.parents:
        raise RuntimeError('交付 ZIP 必须保存到项目目录之外')
    if target.with_suffix('.zip.sha256').exists():
        raise RuntimeError('校验文件已存在，请使用新输出路径')
    update_target = target.parent / 'UPDATE_MANIFEST.json'
    if args.update and update_target.exists():
        raise RuntimeError('更新清单已存在，请使用独立的新发布目录')
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    status = subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all'],
                                     cwd=root, text=True)
    if status.strip() and not args.allow_dirty:
        raise RuntimeError('工作区有未提交改动；正式交付先提交，测试快照需显式使用 --allow-dirty')
    sources = collect_sources(root)
    # Freeze the source first. The build never writes to the running checkout or its .data.
    if sources != collect_sources(root):
        raise RuntimeError('复制期间源码发生变化，请在其他会话完成编辑后重试')
    if commit != subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip():
        raise RuntimeError('复制期间 Git 提交发生变化，请重试以记录准确基线')
    version = json.loads(sources['package.json'])['version']
    if args.update and not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}\.zip', target.name):
        raise RuntimeError('更新包文件名只能使用英文字母、数字、点、下划线和短横线')
    snapshot_time = datetime.now(timezone.utc).isoformat()
    npm = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
    if not npm:
        raise RuntimeError('找不到 npm，请先安装 Node.js 24+')
    with tempfile.TemporaryDirectory(prefix='automation-lab-handoff-') as temporary:
        workspace = Path(temporary)
        for name, data in sources.items():
            path = workspace / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        if args.reuse_dependencies:
            if os.name == 'nt':
                raise RuntimeError('Windows 打包请省略 --reuse-dependencies，由 npm ci 安装隔离依赖')
            dependencies = root / 'node_modules'
            if not dependencies.is_dir():
                raise RuntimeError('缺少本机 node_modules；先 npm ci 或省略 --reuse-dependencies')
            # A stale dependency tree must not silently produce a release.
            installed = dependencies / '.package-lock.json'
            lock = json.loads(sources['package-lock.json'])
            installed_packages = json.loads(installed.read_text()).get('packages', {}) if installed.exists() else {}
            if not installed_packages or any(
                    installed_packages.get(name, {}).get('version') != value.get('version')
                    for name, value in lock['packages'].items()
                    if name and not value.get('optional')):
                raise RuntimeError('本机依赖与锁文件不一致，请先 npm ci 或省略 --reuse-dependencies')
            (workspace / 'node_modules').symlink_to(dependencies, target_is_directory=True)
        else:
            subprocess.run([npm, 'ci'], cwd=workspace, check=True)
        subprocess.run([npm, 'run', 'build'], cwd=workspace, check=True,
                       env={**os.environ, 'AUTOMATION_BUILD_COMMIT': commit})
        payload = dict(sources)
        for name in ('dist', 'dist-server'):
            for path in sorted((workspace / name).rglob('*')):
                if path.is_symlink():
                    raise RuntimeError('构建产物中存在符号链接')
                if path.is_file():
                    payload[path.relative_to(workspace).as_posix()] = path.read_bytes()
        for name in ('dist/index.html', 'dist-server/server/main.js'):
            if name not in payload:
                raise RuntimeError(f'缺少构建产物：{name}')
        payload['READ_FIRST.md'] = sources['docs/DEPLOYMENT_AND_HANDOFF.md'].decode('utf-8').replace(
            '](UNIFIED_AUTOMATION.md)', '](docs/UNIFIED_AUTOMATION.md)').replace(
            '](PUBLIC_API.md)', '](docs/PUBLIC_API.md)').replace(
            '](manual-updates.md)', '](docs/manual-updates.md)').encode('utf-8')
        manifest = {
            'schemaVersion': 1, 'product': 'Kooboo AI Automation Lab', 'version': version,
            'snapshotAt': snapshot_time, 'baseCommit': commit,
            'sourceState': 'working-tree-test-snapshot' if status.strip() else 'clean-commit',
            'uncommittedPaths': status.splitlines(),
            'runtime': {'node': '>=24', 'collectionPython': '3.12',
                        'installOnDestination': ['npm ci', 'npm run install:browser'],
                        'collectionSetup': 'npm run install:collection'},
            'acceptance': {'fullSiteCompleteness': 'pending', 'aiApp': 'pending',
                           'windowsRealRun': 'pending', 'modelAndRemoteRun': 'not-run-by-packager'},
            'files': {name: sha256(data) for name, data in sorted(payload.items())},
        }
        payload['DELIVERY_MANIFEST.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
        if args.update and (len(payload) > 30000 or any(len(data) > 64 * 1024 * 1024 for data in payload.values())
                            or sum(map(len, payload.values())) > 1024 * 1024 * 1024):
            raise RuntimeError('更新包文件数量或解压体积超过启动器上限')
        target.parent.mkdir(parents=True, exist_ok=True)
        created = False
        try:
            archive = zipfile.ZipFile(target, 'x', compression=zipfile.ZIP_DEFLATED)
            created = True
            with archive:
                for name, data in sorted(payload.items()):
                    archive.writestr(f'Kooboo-AI-Automation-Lab/{name}', data)
            checksum = sha256(target.read_bytes())
            if args.update and target.stat().st_size > 512 * 1024 * 1024:
                raise RuntimeError('在线更新包超过 512 MiB 上限')
            with target.with_suffix('.zip.sha256').open('x') as output:
                output.write(f'{checksum}  {target.name}\n')
            if args.update:
                release = update_manifest(sources, version, commit, snapshot_time,
                                          target.name, target.read_bytes())
                with update_target.open('x', encoding='utf-8') as output:
                    output.write(json.dumps(release, ensure_ascii=False, indent=2) + '\n')
        except BaseException:
            if created:
                target.unlink(missing_ok=True)
                target.with_suffix('.zip.sha256').unlink(missing_ok=True)
            raise
    print(json.dumps({'archive': str(target), 'sha256': checksum, 'files': len(payload),
                      'updateManifest': str(update_target) if args.update else None,
                      'baseCommit': commit, 'sourceState': manifest['sourceState']}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error))
