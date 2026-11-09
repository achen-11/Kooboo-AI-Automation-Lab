"""Handoff boundaries: runtime secrets must never travel with source releases."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('platform_package', Path(__file__).resolve().parents[1] / 'scripts/package-platform.py')
package = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(package)


class PlatformPackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in package.SOURCE_FILES:
            self.write(name)
        for name in package.SOURCE_DIRS:
            (self.root / name).mkdir(exist_ok=True)
        for name in ('sop/automation-collection-v1/README.md', 'engines/site-harvest/bridge.py',
                     'engines/site-harvest/requirements.lock', 'scripts/install-collection.mjs',
                     'docs/DEPLOYMENT_AND_HANDOFF.md'):
            self.write(name)

    def write(self, name):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('fixture', encoding='utf-8')

    def test_excludes_runtime_and_credentials_even_under_source(self):
        forbidden = ('.env', '.data/master.key', 'node_modules/private.json',
                     'dist/old.html', 'dist-server/old.js',
                     'frontend/.env.production', 'server/.data/database.sqlite-wal',
                     'engines/.venv/bin/python', 'scripts/__pycache__/cached.pyc',
                     'docs/customer.zip', 'server/master.key', 'server/settings.enc',
                     'examples/credential.pem', 'docs/debug.log')
        for name in forbidden:
            self.write(name)
        self.write('frontend/public/brand.svg')
        self.write('server/automation/new-feature.ts')
        files = package.collect_sources(self.root)
        self.assertFalse(set(forbidden) & files.keys())
        self.assertIn('frontend/public/brand.svg', files)
        self.assertIn('server/automation/new-feature.ts', files)
        self.assertIn('engines/site-harvest/requirements.lock', files)

    def test_rejects_symlinks_to_external_material(self):
        target = self.root / 'personal-settings.json'
        target.write_text('must not ship')
        try:
            (self.root / 'docs/personal.json').symlink_to(target)
        except OSError:
            self.skipTest('Host does not permit symlinks')
        with self.assertRaisesRegex(RuntimeError, '符号链接'):
            package.collect_sources(self.root)

    def test_missing_collection_engine_cannot_produce_successful_release(self):
        (self.root / 'engines/site-harvest/bridge.py').unlink()
        with self.assertRaisesRegex(RuntimeError, '缺少运行组件'):
            package.collect_sources(self.root)

    def test_missing_build_configuration_is_reported(self):
        (self.root / 'tsconfig.server.build.json').unlink()
        with self.assertRaisesRegex(RuntimeError, '缺少交付源码'):
            package.collect_sources(self.root)


if __name__ == '__main__':
    unittest.main()
