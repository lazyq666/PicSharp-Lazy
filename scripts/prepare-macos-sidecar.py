#!/usr/bin/env python3
"""Prepare the macOS helper with its own Node.js runtime and native dependencies."""
import argparse
import json
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / 'packages/picsharp-sidecar'
DEST = ROOT / 'apps/picsharp-app/src-tauri/resources/sidecar'


def run(*args, **kwargs):
    subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def prepare(node):
    if platform.system() != 'Darwin':
        raise RuntimeError('This packaging helper requires macOS.')
    node = node.resolve()
    architecture = platform.machine()
    target = 'aarch64-apple-darwin' if architecture == 'arm64' else 'x86_64-apple-darwin'
    arches = subprocess.check_output(['lipo', '-archs', str(node)], text=True).split()
    if architecture not in arches:
        raise RuntimeError(f'Node.js does not contain the {architecture} architecture.')

    if (PACKAGE / 'dist').exists():
        shutil.rmtree(PACKAGE / 'dist')
    run('pnpm', '--filter', '@picsharp/picsharp-sidecar', 'build', cwd=ROOT)
    DEST.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='picsharp-sidecar-stage-') as temporary:
        stage = Path(temporary)
        shutil.copytree(PACKAGE / 'dist', stage / 'dist')
        # Copy only declared production packages into a real filesystem. Native addons
        # and libvips cannot reliably load from pkg's virtual snapshot filesystem.
        for name in ('package.json', 'package-lock.json'):
            shutil.copy2(PACKAGE / name, stage / name)
        run('npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', cwd=stage)
        shutil.copy2(node, stage / 'node')
        license_file = node.parent.parent / 'LICENSE'
        if license_file.is_file():
            shutil.copy2(license_file, stage / 'Node-LICENSE.txt')
        run(stage / 'node', '-e', "require('./dist/app.js').createApp(); console.log('Helper dependencies ready')", cwd=stage)
        (stage / 'manifest.json').write_text(json.dumps({
            'target': target,
            'node': subprocess.check_output([str(node), '--version'], text=True).strip(),
        }, indent=2) + '\n')
        if DEST.exists():
            shutil.rmtree(DEST)
        shutil.copytree(stage, DEST)

    binary = ROOT / 'apps/picsharp-app/src-tauri/binaries' / f'picsharp-sidecar-{target}'
    binary.parent.mkdir(parents=True, exist_ok=True)
    run('clang', '-O2', '-Wall', '-Wextra', '-arch', architecture,
        '-mmacosx-version-min=12.0', ROOT / 'scripts/macos-sidecar-launcher.c', '-o', binary)
    run('codesign', '--force', '--sign', '-', binary)
    print(f'Prepared standalone macOS helper: {binary}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', type=Path, required=True, help='Official self-contained macOS Node.js executable')
    prepare(parser.parse_args().node)
