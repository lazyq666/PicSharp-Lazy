#!/usr/bin/env python3
"""Give each Mac architecture unique names before merging release artifacts."""
import argparse
from pathlib import Path
import shutil


def collect(bundle, destination, version, arch):
    if arch not in ('arm64', 'x64'):
        raise ValueError('Unsupported Mac architecture')
    files = [(list((bundle / 'macos').glob('*.app.tar.gz')), '.app.tar.gz'),
             (list((bundle / 'dmg').glob('*.dmg')), '.dmg')]
    for candidates, suffix in files:
        if len(candidates) != 1:
            raise ValueError(f'Expected exactly one {suffix} bundle, found {len(candidates)}')
        source = candidates[0]
        if suffix == '.app.tar.gz' and not Path(str(source) + '.sig').is_file():
            raise ValueError('Updater archive has no signature')
    destination.mkdir(parents=True, exist_ok=True)
    for candidates, suffix in files:
        source = candidates[0]
        output = destination / f'PicSharp-Lazy_{version}_{arch}{suffix}'
        shutil.copy2(source, output)
        if suffix == '.app.tar.gz':
            shutil.copy2(Path(str(source) + '.sig'), Path(str(output) + '.sig'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    parser.add_argument('destination', type=Path)
    parser.add_argument('version')
    parser.add_argument('arch')
    args = parser.parse_args()
    collect(args.bundle, args.destination, args.version, args.arch)
