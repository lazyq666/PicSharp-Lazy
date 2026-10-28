#!/usr/bin/env python3
"""Validate the fork release contract and optionally write human-readable notes."""
import argparse
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = 'lazyq666/PicSharp-Lazy'


def metadata():
    paths = ['package.json', 'apps/picsharp-app/package.json', 'packages/picsharp-sidecar/package.json']
    versions = [json.loads((ROOT / path).read_text())['version'] for path in paths]
    version = versions[0]
    if len(set(versions)) != 1 or not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Root, app, and sidecar must share one stable x.y.z version')
    config = json.loads((ROOT / 'apps/picsharp-app/src-tauri/tauri.conf.json').read_text())
    expected = f'https://github.com/{REPOSITORY}/releases/latest/download/latest.json'
    if config['plugins']['updater']['endpoints'] != [expected]:
        raise ValueError('Updater must use only the PicSharp-Lazy release feed')
    notes = json.loads((ROOT / 'apps/picsharp-app/release-notes.json').read_text())['releases'].get(version, {}).get('notes', [])
    if not notes:
        raise ValueError(f'Missing release notes for {version}')
    return version, '\n'.join(f'{index}. {note}' for index, note in enumerate(notes, 1)) + '\n'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--notes', type=Path)
    args = parser.parse_args()
    version, notes = metadata()
    if args.notes:
        args.notes.write_text(notes)
    print(f'Validated PicSharp-Lazy {version}')
