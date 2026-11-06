import test from 'node:test';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { undoImage } from '../src/services/undo-image';
import watchApp from '../src/controllers/watch';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import sharp from 'sharp';
import { OutputRecords, isWatchInputChanged } from '../src/services/output-records';
import { createMediaEvents } from '../src/controllers/watch/media';
import { watchMediaFiles } from '../src/controllers/watch/files';
import { processPngLossy } from '../src/services/compress/png';
import { readFileVersion } from '../src/services/file-version';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'picsharp-copy-watch-')));
  const watched = join(root, 'watched');
  await mkdir(watched);
  const records = new OutputRecords(join(root, 'records'));
  const source = join(watched, 'source.png');
  await records.publish(source, async (p) =>
    writeFile(
      p,
      await sharp({ create: { width: 80, height: 80, channels: 3, background: 'red' } })
        .png()
        .toBuffer(),
    ),
  );
  return {
    root,
    watched,
    records,
    source,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test('live watch skips copied outputs, but emits a same-size changed copy', async () => {
  const f = await fixture();
  const delivered: string[] = [],
    errors: Error[] = [];
  const events = createMediaEvents(
    (e) => delivered.push(e.fullPath),
    40,
    10,
    4096,
    f.records,
    (e) => errors.push(e),
  );
  const watcher = watchMediaFiles(f.watched, [], events, (e) => errors.push(e));
  try {
    await watcher.ready;
    const copy = join(f.watched, 'android.png');
    await copyFile(f.source, copy);
    await sleep(600);
    assert.deepEqual(errors, []);
    assert.deepEqual(delivered, [], 'byte-identical copy must not enqueue compression');
    const bytes = await readFile(copy);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(copy, bytes);
    for (let i = 0; i < 100 && !delivered.length; i++) await sleep(20);
    assert.deepEqual(delivered, [copy]);
  } finally {
    watcher.close();
    events.close();
    await sleep(50);
    await f.close();
  }
});

test('automatic execution rejects a copied output; explicit manual compression still executes', async () => {
  const f = await fixture(),
    previous = process.env.PICSHARP_IMAGE_OUTPUTS_DIR;
  process.env.PICSHARP_IMAGE_OUTPUTS_DIR = f.records.directory;
  try {
    const copy = join(f.watched, 'copy.png'),
      temp = join(f.root, 'temp');
    await mkdir(temp);
    await copyFile(f.source, copy);
    const options = {
      temp_dir: temp,
      save: { mode: 'save_as_new_file', new_file_suffix: '_manual' },
      watermark_type: 'none',
      convert_enable: false,
    };
    await assert.rejects(
      processPngLossy({
        input_path: copy,
        options: { ...options, watch_version: await readFileVersion(copy) },
        process_options: { quality: 50 },
      }),
      isWatchInputChanged,
    );
    const result = await processPngLossy({
      input_path: copy,
      options,
      process_options: { quality: 50 },
    });
    assert.equal(result.output_path, join(f.watched, 'copy_manual.png'));
    assert.ok((await readFile(result.output_path)).length > 0);
  } finally {
    if (previous === undefined) delete process.env.PICSHARP_IMAGE_OUTPUTS_DIR;
    else process.env.PICSHARP_IMAGE_OUTPUTS_DIR = previous;
    await f.close();
  }
});

test('restart migrates legacy fingerprints even after the original was moved or deleted', async () => {
  const f = await fixture();
  try {
    const copy = join(f.watched, 'copy.png');
    await copyFile(f.source, copy);
    await rm(f.source);
    await rm(join(f.records.directory, 'content-v1'), { recursive: true, force: true });
    const restarted = new OutputRecords(f.records.directory);
    assert.equal(await restarted.watchStatus(copy), 'output');
    assert.equal(await new OutputRecords(f.records.directory).watchStatus(copy), 'output');
  } finally {
    await f.close();
  }
});

test('a long-lived watcher sees outputs registered by another process', async () => {
  const f = await fixture();
  try {
    const copy = join(f.watched, 'copy.png');
    await copyFile(f.source, copy);
    assert.equal(await f.records.watchStatus(copy), 'output');
    const bytes = await readFile(copy);
    bytes[bytes.length - 1] ^= 1;
    const output = join(f.root, 'another.png');
    await writeFile(output, bytes);
    // Same-size unknown bytes do not match the already warmed cache.
    await writeFile(copy, bytes);
    assert.equal(await f.records.watchStatus(copy), 'input');
    await promisify(execFile)(process.execPath, [
      '--require',
      require.resolve('tsx/cjs'),
      '-e',
      'const {OutputRecords}=require(process.argv[1]); new OutputRecords(process.argv[2]).remember(process.argv[3]).catch(e=>{console.error(e);process.exitCode=1;});',
      require.resolve('../src/services/output-records'),
      f.records.directory,
      output,
    ]);
    assert.equal(await f.records.watchStatus(copy), 'output');
  } finally {
    await f.close();
  }
});

test('different-size inputs skip hashing; duplicate hashing is limited to two and cached copies do not reread', async () => {
  const f = await fixture();
  const original = fs.createReadStream;
  let reads = 0,
    active = 0,
    peak = 0;
  fs.createReadStream = ((...args: Parameters<typeof original>) => {
    const stream = original(...args);
    if (String(args[0]).startsWith(f.watched)) {
      reads++;
      active++;
      peak = Math.max(peak, active);
      let ended = false;
      const done = () => {
        if (!ended) {
          ended = true;
          active--;
        }
      };
      stream.once('end', done);
      stream.once('close', done);
    }
    return stream;
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    const different = join(f.watched, 'new.png');
    await writeFile(different, 'different size');
    assert.equal(await f.records.watchStatus(different), 'input');
    assert.equal(reads, 0);
    const copies = Array.from({ length: 24 }, (_, i) => join(f.watched, `copy-${i}.png`));
    await Promise.all(copies.map((p) => copyFile(f.source, p)));
    assert.deepEqual(
      await Promise.all(copies.map((p) => f.records.watchStatus(p))),
      copies.map(() => 'output'),
    );
    assert.equal(reads, copies.length, 'one streamed read per copy, including registration');
    assert.ok(peak <= 2, `observed ${peak} concurrent reads`);
    await Promise.all(copies.map((p) => f.records.watchStatus(p)));
    assert.equal(reads, copies.length, 'registered unchanged copies use metadata only');
  } finally {
    fs.createReadStream = original;
    syncBuiltinESMExports();
    await f.close();
  }
});

test('replacement during copy fingerprinting is deferred and never registered as output', async () => {
  const f = await fixture();
  const original = fs.createReadStream;
  const copy = join(f.watched, 'racing.png');
  try {
    await copyFile(f.source, copy);
    let changed = false;
    fs.createReadStream = ((...args: Parameters<typeof original>) => {
      const stream = original(...args);
      if (args[0] === copy && !changed) {
        changed = true;
        stream.once('end', () => fs.writeFileSync(copy, 'new original'));
      }
      return stream;
    }) as typeof original;
    syncBuiltinESMExports();
    assert.equal(await f.records.watchStatus(copy), 'writing');
    assert.equal(await f.records.watchStatus(copy), 'input');
  } finally {
    fs.createReadStream = original;
    syncBuiltinESMExports();
    await f.close();
  }
});

test('Undo protects the restored original without declaring its copies compressed', async () => {
  const f = await fixture();
  try {
    const backup = join(f.root, 'backup.png');
    await writeFile(backup, 'uncompressed original');
    const result = await undoImage(
      {
        path: f.source,
        outputPath: f.source,
        originalTempPath: backup,
        saveType: 'overwrite',
        outputVersion: await readFileVersion(f.source),
      },
      f.records,
    );
    assert.equal(result.success, true);
    assert.equal(await f.records.watchStatus(f.source), 'output');
    const copy = join(f.watched, 'restored-copy.png');
    await copyFile(f.source, copy);
    assert.equal(await f.records.watchStatus(copy), 'input');
    await rm(join(f.records.directory, 'content-v1'), { recursive: true, force: true });
    assert.equal(await new OutputRecords(f.records.directory).watchStatus(copy), 'input');
  } finally {
    await f.close();
  }
});

test('queue filtering drops a copied output but keeps a genuinely new image', async () => {
  const f = await fixture(),
    previous = process.env.PICSHARP_IMAGE_OUTPUTS_DIR;
  process.env.PICSHARP_IMAGE_OUTPUTS_DIR = f.records.directory;
  try {
    const copy = join(f.watched, 'queued-copy.png'),
      fresh = join(f.watched, 'fresh.png');
    await copyFile(f.source, copy);
    await writeFile(fresh, 'fresh image content');
    const candidates = await Promise.all(
      [copy, fresh].map(async (path) => ({ path, version: await readFileVersion(path) })),
    );
    const response = await watchApp.request('http://localhost/filter-inputs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(candidates),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { inputs: [candidates[1]], issues: [] });
  } finally {
    if (previous === undefined) delete process.env.PICSHARP_IMAGE_OUTPUTS_DIR;
    else process.env.PICSHARP_IMAGE_OUTPUTS_DIR = previous;
    await f.close();
  }
});
