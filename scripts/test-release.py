#!/usr/bin/env python3
"""Exercise release gates with real signatures, including tampering failures."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
TAURI = ROOT / 'apps/picsharp-app/node_modules/.bin/tauri'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


manifest = load('manifest', 'create-updater-manifest.py')
collector = load('collector', 'collect-macos-release.py')


class ReleaseGates(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='picsharp-release-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.assets = self.root / 'assets'
        self.assets.mkdir()
        self.version = manifest.release_metadata.metadata()[0]
        key = self.root / 'test.key'
        subprocess.run([str(TAURI), 'signer', 'generate', '--ci', '--password', 'test-only', '--write-keys', str(key)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        config_path = self.root / 'apps/picsharp-app/src-tauri/tauri.conf.json'
        config_path.parent.mkdir(parents=True)
        config_path.write_text(json.dumps({'plugins': {'updater': {'pubkey': Path(str(key) + '.pub').read_text().strip()}}}))
        previous = manifest.ROOT
        manifest.ROOT = self.root
        self.addCleanup(setattr, manifest, 'ROOT', previous)
        env = {**os.environ, 'TAURI_PRIVATE_KEY_PATH': str(key), 'TAURI_PRIVATE_KEY_PASSWORD': 'test-only'}
        for arch in ('arm64', 'x64'):
            archive = self.assets / f'PicSharp-Lazy_{self.version}_{arch}.app.tar.gz'
            archive.write_bytes(f'signed test payload for {arch}'.encode())
            subprocess.run([str(TAURI), 'signer', 'sign', str(archive)], env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            (self.assets / f'PicSharp-Lazy_{self.version}_{arch}.dmg').write_bytes(b'installer fixture')

    def test_complete_signed_pair_uses_only_fork_urls(self):
        result = manifest.create_manifest(self.assets, self.version)
        self.assertEqual(set(result['platforms']), {'darwin-aarch64', 'darwin-x86_64'})
        self.assertTrue(all(item['url'].startswith('https://github.com/lazyq666/PicSharp-Lazy/releases/download/') for item in result['platforms'].values()))
        original = (self.assets / 'latest.json').read_bytes()
        manifest.create_manifest(self.assets, self.version)
        self.assertEqual(original, (self.assets / 'latest.json').read_bytes())

    def test_tampered_archive_is_rejected(self):
        next(self.assets.glob('*arm64.app.tar.gz')).write_bytes(b'tampered archive')
        with self.assertRaises(subprocess.CalledProcessError):
            manifest.create_manifest(self.assets, self.version)
        self.assertFalse((self.assets / 'latest.json').exists())

    def test_other_archives_signature_is_rejected(self):
        arm = next(self.assets.glob('*arm64.app.tar.gz.sig'))
        intel = next(self.assets.glob('*x64.app.tar.gz.sig'))
        arm.write_bytes(intel.read_bytes())
        with self.assertRaises(subprocess.CalledProcessError):
            manifest.create_manifest(self.assets, self.version)

    def test_wrong_public_key_is_rejected(self):
        key = self.root / 'other.key'
        subprocess.run([str(TAURI), 'signer', 'generate', '--ci', '--password', 'test-only', '--write-keys', str(key)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        config_path = self.root / 'apps/picsharp-app/src-tauri/tauri.conf.json'
        config_path.write_text(json.dumps({'plugins': {'updater': {'pubkey': Path(str(key) + '.pub').read_text().strip()}}}))
        with self.assertRaises(subprocess.CalledProcessError):
            manifest.create_manifest(self.assets, self.version)

    def test_missing_architecture_does_not_create_feed(self):
        next(self.assets.glob('*x64.app.tar.gz')).unlink()
        with self.assertRaises(ValueError):
            manifest.create_manifest(self.assets, self.version)
        self.assertFalse((self.assets / 'latest.json').exists())

    def test_mismatched_version_is_rejected(self):
        with self.assertRaises(ValueError):
            manifest.create_manifest(self.assets, '0.0.0')

    def test_missing_installer_is_rejected(self):
        next(self.assets.glob('*arm64.dmg')).unlink()
        with self.assertRaises(ValueError):
            manifest.create_manifest(self.assets, self.version)

    def test_collect_preserves_archive_signature_and_unique_architecture(self):
        bundle = self.root / 'bundle'
        (bundle / 'macos').mkdir(parents=True)
        (bundle / 'dmg').mkdir()
        source = next(self.assets.glob('*arm64.app.tar.gz'))
        shutil.copy2(source, bundle / 'macos/PicSharp.app.tar.gz')
        shutil.copy2(str(source) + '.sig', bundle / 'macos/PicSharp.app.tar.gz.sig')
        (bundle / 'dmg/PicSharp.dmg').write_bytes(b'installer')
        destination = self.root / 'collected'
        collector.collect(bundle, destination, self.version, 'arm64')
        self.assertEqual(source.read_bytes(), next(destination.glob('*.app.tar.gz')).read_bytes())
        self.assertEqual(Path(str(source) + '.sig').read_bytes(), next(destination.glob('*.sig')).read_bytes())
        self.assertEqual(len(list(destination.iterdir())), 3)


if __name__ == '__main__':
    if not shutil.which('minisign'):
        raise SystemExit('Install minisign or add it to PATH before running release tests')
    unittest.main()
