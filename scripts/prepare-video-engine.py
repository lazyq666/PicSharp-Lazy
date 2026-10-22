#!/usr/bin/env python3
"""Stage a relocatable FFmpeg/ffprobe bundle for the current release target."""
import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'apps/picsharp-app/src-tauri/resources/video'


def run(*args):
    try:
        return subprocess.check_output([str(arg) for arg in args], text=True, stderr=subprocess.STDOUT)
    except subprocess.CalledProcessError as error:
        raise RuntimeError(error.output) from error


def mac_dependencies(binary):
    return [line.strip().split(' (compatibility')[0] for line in run('otool', '-L', binary).splitlines()[1:]]


def mac_resolve(dependency, binary, executable_dir):
    if dependency.startswith('@loader_path/'):
        return binary.parent / dependency.removeprefix('@loader_path/')
    if dependency.startswith('@executable_path/'):
        return executable_dir / dependency.removeprefix('@executable_path/')
    if dependency.startswith('@rpath/'):
        lines = run('otool', '-l', binary).splitlines()
        for index, line in enumerate(lines):
            if 'cmd LC_RPATH' in line:
                rpath = lines[index + 2].strip().removeprefix('path ').split(' (offset')[0]
                candidate = mac_resolve(rpath, binary, executable_dir) / dependency.removeprefix('@rpath/')
                if candidate.exists():
                    return candidate
        raise RuntimeError(f'Cannot resolve {dependency} from {binary}')
    return Path(dependency)


def prepare(source, target, identity):
    source = source.resolve()
    if platform.system() == 'Darwin':
        expected = 'arm64' if target.startswith('aarch64-') else 'x86_64'
        for name in ('ffmpeg', 'ffprobe'):
            if expected not in run('lipo', '-archs', source / name).split():
                raise RuntimeError(f'{name} does not contain target architecture {expected}')
    DEST.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.video-stage-', dir=DEST.parent) as temporary:
        stage = Path(temporary)
        suffix = '.exe' if platform.system() == 'Windows' else ''
        for executable in ('ffmpeg', 'ffprobe'):
            shutil.copy2(source / (executable + suffix), stage / (executable + suffix))
        if platform.system() == 'Darwin':
            (stage / 'lib').mkdir()
            pending = [(source / name, stage / name) for name in ('ffmpeg', 'ffprobe')]
            copied = {}
            while pending:
                original, output = pending.pop(0)
                output.chmod(output.stat().st_mode | 0o700)
                for dependency in mac_dependencies(original):
                    if dependency.startswith(('/usr/lib/', '/System/Library/')):
                        continue
                    resolved = mac_resolve(dependency, original, source).resolve()
                    if resolved == original.resolve():
                        continue  # dylib's own LC_ID_DYLIB
                    name = resolved.name
                    if name in copied and copied[name] != resolved:
                        raise RuntimeError(f'Conflicting libraries named {name}')
                    if name not in copied:
                        copied[name] = resolved
                        destination = stage / 'lib' / name
                        shutil.copy2(resolved, destination)
                        pending.append((resolved, destination))
                    relative = f'@loader_path/{"lib/" if output.parent == stage else ""}{name}'
                    run('install_name_tool', '-change', dependency, relative, output)
                if output.parent == stage / 'lib':
                    run('install_name_tool', '-id', f'@loader_path/{output.name}', output)
            for binary in [*(stage / 'lib').iterdir(), stage / 'ffmpeg', stage / 'ffprobe']:
                run('codesign', '--force', '--sign', identity, binary)
        else:
            # Windows: portable distribution DLLs. Linux: supply a static build,
            # or a self-contained distribution whose binaries already use $ORIGIN.
            for dll in source.glob('*.dll'):
                shutil.copy2(dll, stage / dll.name)
            if (source / 'lib').is_dir():
                shutil.copytree(source / 'lib', stage / 'lib')
        encoders = run(stage / ('ffmpeg' + suffix), '-hide_banner', '-encoders')
        if not all(codec in encoders for codec in ('libsvtav1', 'libx264')):
            raise RuntimeError('FFmpeg must include libsvtav1 and libx264')
        version = run(stage / ('ffmpeg' + suffix), '-version').splitlines()[0]
        (stage / 'FFmpeg-license.txt').write_text(run(stage / ('ffmpeg' + suffix), '-L'))
        run(stage / ('ffprobe' + suffix), '-version')
        # Keep licensing material provided by the binary distributor.
        for item in source.iterdir():
            if item.is_file() and item.name.lower().startswith(('license', 'copying', 'notice')):
                shutil.copy2(item, stage / item.name)
        (stage / 'manifest.json').write_text(json.dumps({'target': target, 'version': version, 'encoders': ['libsvtav1', 'libx264']}, indent=2) + '\n')
        if DEST.exists():
            shutil.rmtree(DEST)
        shutil.copytree(stage, DEST)
    print(f'Prepared {version} for {target}: {DEST}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True, help='Directory containing ffmpeg and ffprobe for this target')
    parser.add_argument('--target', default=next(line.split(': ', 1)[1] for line in run('rustc', '-vV').splitlines() if line.startswith('host:')))
    parser.add_argument('--sign', default='-', help='macOS signing identity; default is ad-hoc for local development')
    args = parser.parse_args()
    prepare(args.source, args.target, args.sign)
