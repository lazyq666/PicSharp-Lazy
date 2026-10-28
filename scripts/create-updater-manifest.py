#!/usr/bin/env python3
"""Verify both Mac update archives before creating the fork's latest.json."""
import argparse
import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release_metadata', Path(__file__).with_name('release-metadata.py'))
release_metadata = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_metadata)


def create_manifest(directory, version):
    expected_version, notes = release_metadata.metadata()
    if version != expected_version:
        raise ValueError('Artifact version does not match source version')
    config = json.loads((ROOT / 'apps/picsharp-app/src-tauri/tauri.conf.json').read_text())
    public_key = base64.b64decode(config['plugins']['updater']['pubkey'], validate=True)
    platforms = {}
    with tempfile.TemporaryDirectory(prefix='picsharp-verify-') as temporary:
        public_file = Path(temporary) / 'public.key'
        signature_file = Path(temporary) / 'archive.minisig'
        public_file.write_bytes(public_key)
        for arch, platform in [('arm64', 'darwin-aarch64'), ('x64', 'darwin-x86_64')]:
            name = f'PicSharp-Lazy_{version}_{arch}.app.tar.gz'
            archive = directory / name
            signature = Path(str(archive) + '.sig').read_text().strip()
            if not archive.is_file() or archive.stat().st_size == 0:
                raise ValueError(f'Missing or empty updater archive: {name}')
            installer = directory / f'PicSharp-Lazy_{version}_{arch}.zip'
            if not installer.is_file() or installer.stat().st_size == 0:
                raise ValueError(f'Missing or empty installer: {installer.name}')
            signature_file.write_bytes(base64.b64decode(signature, validate=True))
            subprocess.run(['minisign', '-Vm', str(archive), '-p', str(public_file), '-x', str(signature_file)], check=True)
            platforms[platform] = {
                'signature': signature,
                'url': f'https://github.com/{release_metadata.REPOSITORY}/releases/download/v{version}/{quote(name)}',
            }
    # Omit optional pub_date so upload/readback verification remains deterministic.
    manifest = {'version': version, 'notes': notes, 'platforms': platforms}
    (directory / 'latest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
    print(f'Verified both Mac signatures and wrote {directory / "latest.json"}')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('version')
    args = parser.parse_args()
    create_manifest(args.directory, args.version)
