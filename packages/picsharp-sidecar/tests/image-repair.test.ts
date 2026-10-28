import test from 'node:test';
import assert from 'node:assert/strict';
import fsp, {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rename,
  rm,
  realpath,
  copyFile,
  readdir,
  stat,
  link,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { OutputRecords, isWatchInputChanged } from '../src/services/output-records';
import { DirectoryAnchor } from '../src/services/directory-anchor';
import { readFileVersion } from '../src/services/file-version';
import { processPngLossy } from '../src/services/compress/png';
import app from '../src/controllers/watch';
import { createMediaEvents } from '../src/controllers/watch/media';
import { setTimeout as sleep } from 'node:timers/promises';
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ps-repair-')));
  const watched = join(root, 'watch'),
    temp = join(root, 'temp');
  await mkdir(watched);
  await mkdir(temp);
  const records = new OutputRecords(join(root, 'records'));
  const prev = process.env.PICSHARP_IMAGE_OUTPUTS_DIR;
  process.env.PICSHARP_IMAGE_OUTPUTS_DIR = records.directory;
  return {
    root,
    watched,
    temp,
    records,
    async close() {
      if (prev === undefined) delete process.env.PICSHARP_IMAGE_OUTPUTS_DIR;
      else process.env.PICSHARP_IMAGE_OUTPUTS_DIR = prev;
      await rm(root, { recursive: true, force: true });
    },
  };
}
const png = (color: string) =>
  sharp({ create: { width: 64, height: 64, channels: 3, background: color } })
    .png({ compressionLevel: 0 })
    .toBuffer();
const payload = (path: string, temp: string, version: string | undefined) => ({
  input_path: path,
  options: {
    temp_dir: temp,
    save: { mode: 'overwrite' },
    watch_version: version,
    watermark_type: 'none',
    convert_enable: false,
  },
  process_options: { palette: true, quality: 80 },
});
test('WATCH-001 moved outputs stay protected; independent copies and new export remain inputs', async () => {
  const f = await fixture();
  try {
    const source = join(f.watched, 'a.png');
    await f.records.publish(source, (t) => writeFile(t, 'output'));
    const moved = join(f.watched, 'b.png');
    await rename(source, moved);
    assert.equal(await new OutputRecords(f.records.directory).status(moved), 'output');
    const copy = join(f.watched, 'copy.png');
    await copyFile(moved, copy);
    assert.equal(await f.records.status(copy), 'input');
    await writeFile(moved, 'V2');
    assert.equal(await f.records.status(moved), 'input');
  } finally {
    await f.close();
  }
});
test('WATCH-005 new export in the final anchored publication syscall window survives', async () => {
  const f = await fixture(),
    source = join(f.watched, 'a.png'),
    v2 = await png('blue');
  const original = DirectoryAnchor.prototype.claim;
  let injected = 0;
  try {
    await writeFile(source, await png('red'));
    const version = await readFileVersion(source);
    DirectoryAnchor.prototype.claim = async function () {
      if (!injected++) {
        await writeFile(source, v2);
      }
      return original.call(this);
    };
    await assert.rejects(processPngLossy(payload(source, f.temp, version)), isWatchInputChanged);
    assert.equal(injected, 1);
    assert.deepEqual(await readFile(source), v2);
  } finally {
    DirectoryAnchor.prototype.claim = original;
    await f.close();
  }
});
test('WATCH-008 bad record isolates its candidate and returns a diagnostic with healthy input', async () => {
  const f = await fixture();
  try {
    const bad = join(f.watched, 'bad.png'),
      good = join(f.watched, 'good.png');
    await f.records.publish(bad, (t) => writeFile(t, 'old'));
    const files = (await readdir(f.records.directory)).filter((x) => x.endsWith('.json'));
    await writeFile(join(f.records.directory, files[0]), '{bad');
    await writeFile(bad, 'new');
    await writeFile(good, 'healthy');
    const response = await app.request('http://localhost/filter-inputs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        await Promise.all(
          [bad, good].map(async (path) => ({ path, version: await readFileVersion(path) })),
        ),
      ),
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as any;
    assert.deepEqual(
      result.inputs.map((x: any) => x.path),
      [good],
    );
    assert.equal(result.issues[0].path, bad);
  } finally {
    await f.close();
  }
});
test('WATCH-011 valid 1022-byte source path does not grow for internal files', async () => {
  const f = await fixture();
  try {
    let parent = f.watched;
    while (Buffer.byteLength(parent) < 1000) {
      const budget = 1012 - Buffer.byteLength(parent) - 1;
      parent = join(parent, 'p'.repeat(Math.min(120, budget)));
      await mkdir(parent);
    }
    if (Buffer.byteLength(parent) < 1012) {
      parent = join(parent, 'p'.repeat(1012 - Buffer.byteLength(parent) - 1));
      await mkdir(parent);
    }
    const source = join(parent, 'ppppp.png');
    assert.equal(Buffer.byteLength(source), 1022);
    await writeFile(source, await png('red'));
    const result = await processPngLossy(payload(source, f.temp, await readFileVersion(source)));
    assert.ok(result.output_size > 0);
    await sharp(source).metadata();
  } finally {
    await f.close();
  }
});
test('WATCH-012 stale hardlink metadata refreshes to an eligible current candidate', async () => {
  const f = await fixture();
  try {
    const a = join(f.watched, 'a.png'),
      b = join(f.watched, 'b.png');
    await writeFile(a, await png('red'));
    await link(a, b);
    const old = await readFileVersion(b);
    await processPngLossy(payload(a, f.temp, await readFileVersion(a)));
    assert.notEqual(await readFileVersion(b), old);
    const response = await app.request('http://localhost/filter-inputs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ path: b, version: old }]),
    });
    const result = (await response.json()) as any;
    assert.equal(result.inputs[0].path, b);
    assert.equal(result.inputs[0].version, await readFileVersion(b));
  } finally {
    await f.close();
  }
});
for (const seam of ['claim', 'publish'] as const)
  for (let iteration = 1; iteration <= 3; iteration++)
    test(`WATCH-005 anchored ${seam} final syscall request window ${iteration}`, async () => {
      const f = await fixture(),
        source = join(f.watched, 'a.png'),
        v2 = await png('blue');
      const originalClaim = DirectoryAnchor.prototype.claim,
        originalPublish = DirectoryAnchor.prototype.publish;
      let injected = 0;
      try {
        await writeFile(source, await png('red'));
        const version = await readFileVersion(source);
        DirectoryAnchor.prototype.claim = async function () {
          if (seam === 'claim' && !injected++) {
            await writeFile(source, v2);
          }
          return originalClaim.call(this);
        };
        DirectoryAnchor.prototype.publish = async function (temporary) {
          if (seam === 'publish' && !injected++) {
            await writeFile(source, v2);
          }
          return originalPublish.call(this, temporary);
        };
        await assert.rejects(
          processPngLossy(payload(source, f.temp, version)),
          isWatchInputChanged,
        );
        assert.equal(injected, 1);
        assert.deepEqual(await readFile(source), v2);
        assert.equal(await f.records.status(source), 'input');
        console.log(
          JSON.stringify({
            case: 'WATCH-005',
            seam,
            iteration,
            injected,
            V2Preserved: true,
            scope:
              'last version check completed; injection immediately before actual directory-anchor syscall request',
          }),
        );
      } finally {
        DirectoryAnchor.prototype.claim = originalClaim;
        DirectoryAnchor.prototype.publish = originalPublish;
        await f.close();
      }
    });
test('WATCH-006 image work stays outside a moved source parent and is removed', async () => {
  const f = await fixture();
  const source = join(f.watched, 'a.png'),
    moved = join(f.root, 'moved');
  const commit = OutputRecords.prototype.commit;
  let hook = 0,
    work = '';
  try {
    await writeFile(source, await png('red'));
    OutputRecords.prototype.commit = async function (path, temporary, expected) {
      if (path === source && !hook++) {
        work = dirname(temporary);
        await rename(f.watched, moved);
      }
      return commit.call(this, path, temporary, expected);
    };
    await assert.rejects(processPngLossy(payload(source, f.temp, await readFileVersion(source))));
    assert.ok(hook);
    assert.deepEqual(
      (await readdir(moved)).filter((x) => x.startsWith('.picsharp-image-')),
      [],
    );
    await assert.rejects(stat(work), (e: any) => e.code === 'ENOENT');
    await sharp(join(moved, 'a.png')).metadata();
  } finally {
    OutputRecords.prototype.commit = commit;
    await f.close();
  }
});
for (let iteration = 1; iteration <= 3; iteration++)
  test(`WATCH-012 production resampler supplies and processes the hardlink replacement candidate ${iteration}`, async () => {
    const f = await fixture();
    const a = join(f.watched, 'a.png'),
      b = join(f.watched, 'b.png');
    const emitted: any[] = [];
    const errors: Error[] = [];
    const events = createMediaEvents(
      (p) => emitted.push(p),
      40,
      10,
      4096,
      f.records,
      (e) => errors.push(e),
    );
    async function until(fn: () => boolean) {
      const end = Date.now() + 4000;
      while (!fn()) {
        assert.ok(Date.now() < end, 'replacement candidate was not delivered');
        await sleep(10);
      }
    }
    try {
      await writeFile(a, await png('red'));
      await link(a, b);
      events.add({ fullPath: a, isFile: true });
      events.add({ fullPath: b, isFile: true });
      await until(() => emitted.length === 2);
      const first = emitted.find((x) => x.fullPath === a),
        second = emitted.find((x) => x.fullPath === b);
      await processPngLossy(payload(a, f.temp, first.version));
      await assert.rejects(
        processPngLossy(payload(b, f.temp, second.version)),
        isWatchInputChanged,
      );
      await until(() => emitted.filter((x) => x.fullPath === b).length === 2);
      const replacement = emitted.filter((x) => x.fullPath === b)[1];
      assert.notEqual(replacement.version, second.version);
      await processPngLossy(payload(b, f.temp, replacement.version));
      assert.equal(await f.records.status(a), 'output');
      assert.equal(await f.records.status(b), 'output');
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          case: 'WATCH-012',
          iteration,
          staleRejected: true,
          replacementDelivered: true,
          bothProcessed: true,
        }),
      );
    } finally {
      events.close();
      await f.close();
    }
  });
test('WATCH-001 moved output wins identity lookup over an older record at its new pathname', async () => {
  const f = await fixture();
  try {
    const a = join(f.watched, 'a.png'),
      b = join(f.watched, 'b.png');
    await f.records.publish(a, (t) => writeFile(t, 'A'));
    await f.records.publish(b, (t) => writeFile(t, 'B'));
    await rename(b, join(f.watched, 'b-moved.png'));
    await rename(a, b);
    assert.equal(await new OutputRecords(f.records.directory).status(b), 'output');
    const copy = join(f.watched, 'independent.png');
    await copyFile(b, copy);
    assert.equal(await f.records.status(copy), 'input');
    await writeFile(b, 'V2');
    assert.equal(await f.records.status(b), 'input');
  } finally {
    await f.close();
  }
});

for (const recreate of [false, true])
  test(`WATCH-006 moved parent after actual claim remains addressed by anchored directory; recreate=${recreate}`, async () => {
    const f = await fixture(),
      source = join(f.watched, 'a.png'),
      moved = join(f.root, 'delivery');
    const original = DirectoryAnchor.prototype.claim;
    let injected = 0;
    try {
      await writeFile(source, await png('red'));
      const version = await readFileVersion(source);
      const awaitBuffer = await sharp(await png('red'))
        .png()
        .toBuffer();
      DirectoryAnchor.prototype.claim = async function () {
        await original.call(this);
        if (!injected++) {
          await rename(f.watched, moved);
          if (recreate) await mkdir(f.watched);
        }
      };
      await f.records.publish(source, (temporary) => writeFile(temporary, awaitBuffer), version);
      assert.equal(injected, 1);
      await sharp(join(moved, 'a.png')).metadata();
      assert.deepEqual(
        (await readdir(moved)).filter((x) => x.startsWith('.picsharp-image-')),
        [],
      );
      if (recreate) assert.deepEqual(await readdir(f.watched), []);
      console.log(
        JSON.stringify({
          case: 'WATCH-006',
          recreate,
          injected,
          movedSourceValid: true,
          newNamespaceUnmodified: true,
        }),
      );
    } finally {
      DirectoryAnchor.prototype.claim = original;
      await f.close();
    }
  });
test('directory anchor closes after rollback conflict and retains a real recovery file', async () => {
  const f = await fixture(),
    source = join(f.watched, 'anchor.png');
  try {
    await writeFile(source, 'original');
    const claim = await f.records.claim(source, (await readFileVersion(source))!);
    await writeFile(source, 'new export');
    let recovery: any;
    try {
      await claim.restore();
    } catch (error) {
      recovery = error;
    }
    assert.equal(await readFile(source, 'utf8'), 'new export');
    assert.equal(await readFile(recovery.recoveryPath, 'utf8'), 'original');
    assert.equal(
      isWatchInputChanged(recovery),
      false,
      'recovery requires visible attention, never a silent skip',
    );
    assert.equal((claim.anchor as any).child.stdin.writableEnded, true);
    assert.notEqual((claim.anchor as any).child.exitCode, null);
    await rm(dirname(claim.path), { recursive: true, force: true });
  } finally {
    await f.close();
  }
});
test('directory anchor restores the original on owner EOF after a source-directory move', async () => {
  const f = await fixture(),
    source = join(f.watched, 'anchor.png'),
    moved = join(f.root, 'delivery');
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const register = join(
    process.cwd(),
    'packages/picsharp-sidecar/node_modules/tsx/dist/cjs/index.cjs',
  );
  const recordsModule = join(
    process.cwd(),
    'packages/picsharp-sidecar/src/services/output-records.ts',
  );
  const versionsModule = join(
    process.cwd(),
    'packages/picsharp-sidecar/src/services/file-version.ts',
  );
  let owner: any;
  try {
    await writeFile(source, 'original');
    const script = `const {OutputRecords}=require(${JSON.stringify(recordsModule)});const {readFileVersion}=require(${JSON.stringify(versionsModule)});(async()=>{const path=${JSON.stringify(source)};const records=new OutputRecords(${JSON.stringify(f.records.directory)});await records.claim(path,await readFileVersion(path));process.stdout.write('claimed\\n');setInterval(()=>{},10000);})();`;
    owner = spawn(process.execPath, ['--require', register, '-e', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    owner.stdout.on('data', (chunk: Buffer) => (output += chunk));
    const deadline = Date.now() + 5000;
    while (!output.includes('claimed')) {
      assert.ok(Date.now() < deadline, 'owner failed to claim');
      await sleep(10);
    }
    await rename(f.watched, moved);
    owner.kill('SIGTERM');
    await once(owner, 'close');
    const restored = join(moved, 'anchor.png');
    while (
      !(await stat(restored).then(
        () => true,
        () => false,
      ))
    ) {
      assert.ok(Date.now() < deadline, 'anchor did not restore after owner EOF');
      await sleep(10);
    }
    assert.equal(await readFile(restored, 'utf8'), 'original');
  } finally {
    if (owner && owner.exitCode === null) owner.kill('SIGTERM');
    await f.close();
  }
});
test('directory anchor accepts leading-dash filenames as data', async () => {
  const f = await fixture();
  try {
    const source = join(f.watched, '-source.png');
    await writeFile(source, 'raw');
    await f.records.publish(
      source,
      (t) => writeFile(t, 'compressed'),
      await readFileVersion(source),
    );
    assert.equal(await readFile(source, 'utf8'), 'compressed');
    assert.equal(await f.records.status(source), 'output');
  } finally {
    await f.close();
  }
});
