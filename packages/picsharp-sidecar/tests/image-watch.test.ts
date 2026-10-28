import test from 'node:test';
import assert from 'node:assert/strict';
import {
  realpath,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  rm,
  utimes,
  symlink,
  chmod,
  stat,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import sharp from 'sharp';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { OutputRecords, isWatchInputChanged } from '../src/services/output-records';
import { readFileVersion } from '../src/services/file-version';
import { createMediaEvents } from '../src/controllers/watch/media';
import { watchMediaFiles } from '../src/controllers/watch/files';
import app from '../src/controllers/watch';
import { processJpeg } from '../src/services/compress/jpeg';
import { processPngLossless } from '../src/services/compress/png';
import { processSvg } from '../src/services/compress/svg';
import { processTinyPng } from '../src/services/compress/tinypng';
import { hashFile } from '../src/utils';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'picsharp-image-watch-')));
  const folder = join(root, 'watched');
  const temp = join(root, 'temp');
  const records = new OutputRecords(join(root, 'records'));
  await mkdir(folder);
  await mkdir(temp);
  const previous = process.env.PICSHARP_IMAGE_OUTPUTS_DIR;
  process.env.PICSHARP_IMAGE_OUTPUTS_DIR = records.directory;
  return {
    root,
    folder,
    temp,
    records,
    async close() {
      if (previous === undefined) delete process.env.PICSHARP_IMAGE_OUTPUTS_DIR;
      else process.env.PICSHARP_IMAGE_OUTPUTS_DIR = previous;
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function until(condition: () => boolean) {
  const deadline = Date.now() + 6000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for file events');
    await sleep(20);
  }
}

function options(temp: string, mode = 'save_as_new_file') {
  return {
    temp_dir: temp,
    save: { mode, new_file_suffix: '_small' },
    watermark_type: 'none',
    convert_enable: true,
    convert_types: ['webp'],
    convert_alpha: '#FFFFFF',
  };
}

async function changeMetadata(path: string, value: string) {
  if (process.platform === 'darwin') {
    execFileSync('/usr/bin/xattr', ['-w', 'com.picsharp.watch-test', value, path]);
  } else {
    const metadata = await stat(path);
    await chmod(path, (metadata.mode & 0o777) ^ 0o100);
  }
}

test('compressed image fingerprints survive metadata changes and restarts', async () => {
  const f = await fixture();
  const path = join(f.folder, 'output.png');
  try {
    await f.records.publish(path, (temporary) => writeFile(temporary, 'compressed image'));
    const before = await stat(path, { bigint: true });
    await changeMetadata(path, 'preview');
    const after = await stat(path, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.notEqual(after.ctimeNs, before.ctimeNs);
    const restarted = new OutputRecords(f.records.directory);
    assert.equal(await restarted.status(path), 'output');
    assert.equal(await restarted.isInput({ path, version: (await readFileVersion(path))! }), false);
  } finally {
    await f.close();
  }
});

test('unchanged outputs skip content reads; a replacement during fingerprinting is deferred', async () => {
  const f = await fixture();
  const path = join(f.folder, 'output.png');
  const timestamp = new Date('2026-01-01T00:00:00Z');
  const originalReadStream = fs.createReadStream;
  try {
    await f.records.publish(path, async (temporary) => {
      await writeFile(temporary, 'AAAA');
      await utimes(temporary, timestamp, timestamp);
    });
    let reads = 0;
    let replace = false;
    fs.createReadStream = ((...args: Parameters<typeof originalReadStream>) => {
      const stream = originalReadStream(...args);
      if (args[0] === path) {
        reads++;
        if (replace) {
          replace = false;
          stream.once('end', () => {
            fs.writeFileSync(path, 'BBBB');
            fs.utimesSync(path, timestamp, timestamp);
          });
        }
      }
      return stream;
    }) as typeof originalReadStream;
    syncBuiltinESMExports();
    assert.equal(await f.records.status(path), 'output');
    assert.equal(reads, 0, 'an unchanged version is already verified');
    await changeMetadata(path, 'preview');
    const candidate = { path, version: (await readFileVersion(path))! };
    replace = true;
    assert.equal(await f.records.status(path, candidate.version), 'writing');
    assert.equal(await f.records.isInput(candidate), false, 'the old queued version is stale');
    assert.equal(
      await f.records.status(path),
      'input',
      'the replacement is not a compressed output',
    );
  } finally {
    fs.createReadStream = originalReadStream;
    syncBuiltinESMExports();
    await f.close();
  }
});

test('legacy output markers never assume changed bytes are already compressed', async () => {
  const f = await fixture();
  const path = join(f.folder, 'output.png');
  try {
    await f.records.publish(path, (temporary) => writeFile(temporary, 'AAAA'));
    const [filename] = await readdir(f.records.directory);
    const recordPath = join(f.records.directory, filename);
    const legacy = JSON.parse(await readFile(recordPath, 'utf8'));
    delete legacy.fingerprint;
    await writeFile(recordPath, JSON.stringify(legacy));
    assert.equal(await f.records.status(path), 'output');
    await writeFile(path, 'BBBB');
    assert.equal(await f.records.status(path), 'input');
    await f.records.remember(path);
    await changeMetadata(path, 'preview-after-new-record');
    assert.equal(await new OutputRecords(f.records.directory).status(path), 'output');
  } finally {
    await f.close();
  }
});

test('live image watch ignores preview attributes but imports in-place and atomic re-exports', async () => {
  const f = await fixture();
  const path = join(f.folder, 'image.png');
  const timestamp = new Date('2026-01-01T00:00:00Z');
  const images = await Promise.all(
    ['#ff0000', '#00ff00', '#0000ff'].map((background) =>
      sharp({ create: { width: 32, height: 32, channels: 3, background } })
        .png({ compressionLevel: 0 })
        .toBuffer(),
    ),
  );
  assert.equal(new Set(images.map((image) => image.length)).size, 1);
  const publish = (image: Buffer) =>
    f.records.publish(path, async (temporary) => {
      await writeFile(temporary, image);
      await utimes(temporary, timestamp, timestamp);
    });
  await publish(images[0]);
  const emitted: { fullPath: string; version?: string }[] = [];
  const errors: Error[] = [];
  const events = createMediaEvents((payload) => emitted.push(payload), 40, 10, 4096, f.records);
  const watcher = watchMediaFiles(f.folder, [], events, (error) => errors.push(error));
  try {
    await watcher.ready;
    for (let n = 0; n < 3; n++) {
      await readFile(path);
      await changeMetadata(path, `preview-${n}`);
      await sleep(250);
      assert.equal(emitted.length, 0, 'preview metadata must not requeue a compressed image');
    }
    // In-place export keeps the file identity and its marker; even size/mtime stay equal.
    await writeFile(path, images[1]);
    await utimes(path, timestamp, timestamp);
    await until(() => emitted.length === 1);
    assert.equal(emitted[0].fullPath, path);
    assert.equal(await f.records.isInput({ path, version: emitted[0].version! }), true);
    await publish(images[1]);
    await changeMetadata(path, 'preview-after-recompression');
    await sleep(250);
    assert.equal(emitted.length, 1);
    const incoming = join(f.root, 'export.png');
    await writeFile(incoming, images[2]);
    await utimes(incoming, timestamp, timestamp);
    await rename(incoming, path);
    await until(() => emitted.length === 2);
    assert.equal(emitted[1].fullPath, path);
    assert.notEqual(emitted[0].version, emitted[1].version);
    await sleep(250);
    assert.equal(emitted.length, 2, 'each actual re-export is imported once');
    assert.deepEqual(errors, []);
  } finally {
    watcher.close();
    events.close();
    await f.close();
  }
});

test('a replacement during output registration is never marked as compressed', async () => {
  const f = await fixture();
  const path = join(f.folder, 'image.png');
  const remember = f.records.remember.bind(f.records);
  f.records.remember = async (...args) => {
    await writeFile(path, 'new original');
    await remember(...args);
  };
  try {
    await assert.rejects(
      f.records.publish(path, (temporary) => writeFile(temporary, 'compressed image')),
      isWatchInputChanged,
    );
    assert.equal(await readFile(path, 'utf8'), 'new original');
    assert.equal(await f.records.status(path), 'input');
  } finally {
    await f.close();
  }
});

test('watched images kept because of the savings threshold are still marked as processed', async () => {
  const f = await fixture();
  try {
    for (const ext of ['jpg', 'png', 'svg']) {
      const path = join(f.folder, `unchanged.${ext}`);
      const content =
        ext === 'svg'
          ? Buffer.from(
              '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red"/></svg>',
            )
          : await sharp({ create: { width: 32, height: 32, channels: 3, background: '#dd3333' } })
              .toFormat(ext === 'jpg' ? 'jpeg' : 'png')
              .toBuffer();
      await writeFile(path, content);
      const payload = {
        input_path: path,
        options: {
          ...options(f.temp, 'overwrite'),
          convert_enable: false,
          limit_compress_rate: 2,
          watch_version: await readFileVersion(path),
        },
        process_options: { quality: 50 },
      };
      const result =
        ext === 'jpg'
          ? await processJpeg(payload)
          : ext === 'png'
            ? await processPngLossless(payload)
            : await processSvg(payload);
      assert.equal(result.available_compress_rate, false, ext);
      assert.deepEqual(await readFile(path), content);
      await changeMetadata(path, 'preview');
      assert.equal(await f.records.status(path), 'output', ext);
      await writeFile(path, 'newly exported original');
      assert.equal(await f.records.status(path), 'input', ext);
    }
  } finally {
    await f.close();
  }
});

test('durable output records are version-specific, including equal-size/mtime replacements', async () => {
  const f = await fixture();
  const path = join(f.folder, 'output.png');
  const timestamp = new Date('2026-01-01T00:00:00Z');
  try {
    await f.records.publish(path, async (temporary) => {
      await writeFile(temporary, 'AAAA');
      await utimes(temporary, timestamp, timestamp);
    });
    assert.equal(await new OutputRecords(f.records.directory).status(path), 'output');
    await writeFile(path, 'BBBB');
    await utimes(path, timestamp, timestamp);
    assert.equal(await f.records.status(path), 'input');
    await f.records.remember(path);
    const incoming = join(f.root, 'replacement.png');
    await writeFile(incoming, 'CCCC');
    await utimes(incoming, timestamp, timestamp);
    await rename(incoming, path);
    assert.equal(await f.records.status(path), 'input');
    const candidate = { path, version: (await readFileVersion(path))! };
    assert.equal(await f.records.isInput(candidate), true);
    await f.records.remember(path);
    assert.equal(await f.records.isInput(candidate), false);
    if (process.platform !== 'win32') {
      const alias = join(f.root, 'alias');
      await symlink(f.folder, alias);
      assert.equal(await f.records.status(join(alias, 'output.png')), 'output');
    }
  } finally {
    await f.close();
  }
});

test('a slow publication record never leaks its output into monitoring', async () => {
  const f = await fixture();
  const path = join(f.folder, 'image.png');
  const emitted: string[] = [];
  const errors: Error[] = [];
  const events = createMediaEvents(
    (payload) => emitted.push(payload.fullPath),
    30,
    10,
    4096,
    f.records,
  );
  const watcher = watchMediaFiles(f.folder, [], events, (error) => errors.push(error));
  const remember = f.records.remember.bind(f.records);
  let release!: () => void;
  let publishing = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.records.remember = async (...args) => {
    publishing = true;
    await gate;
    await remember(...args);
  };
  let saving: Promise<void> | undefined;
  try {
    await watcher.ready;
    saving = f.records.publish(path, (temporary) => writeFile(temporary, 'output'));
    await until(() => publishing);
    assert.equal(await f.records.status(path), 'writing');
    await sleep(150);
    assert.deepEqual(emitted, []);
    release();
    await saving;
    await sleep(150);
    assert.deepEqual(emitted, []);
    await writeFile(path, 'user replacement');
    await until(() => emitted.length === 1);
    assert.deepEqual(emitted, [path]);
    assert.deepEqual(errors, []);
  } finally {
    release();
    await saving;
    watcher.close();
    events.close();
    await f.close();
  }
});

test('overwrite does not destroy a source replaced while its old version was compressing', async () => {
  const f = await fixture();
  const path = join(f.folder, 'source.png');
  try {
    await writeFile(path, 'old source');
    const expected = await readFileVersion(path);
    await assert.rejects(
      f.records.publish(
        path,
        async (temporary) => {
          await writeFile(temporary, 'compressed old source');
          await writeFile(path, 'new source');
        },
        expected,
      ),
      isWatchInputChanged,
    );
    assert.equal(await readFile(path, 'utf8'), 'new source');
    assert.equal(await f.records.status(path), 'input');
    assert.deepEqual(await readdir(f.folder), ['source.png']);
    assert.equal(
      (await readdir(f.records.directory)).some((name) => name.endsWith('.pending')),
      false,
    );
  } finally {
    await f.close();
  }
});

test(
  'real JPEG save-as and conversion outputs do not re-enter a live watch; replacements do',
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    const path = join(f.folder, 'photo.jpg');
    const payloads: { fullPath: string; version?: string }[] = [];
    const errors: Error[] = [];
    const events = createMediaEvents((payload) => payloads.push(payload), 40, 10, 4096, f.records);
    const watcher = watchMediaFiles(f.folder, [], events, (error) => errors.push(error));
    try {
      await watcher.ready;
      const source = await sharp({
        create: { width: 256, height: 256, channels: 3, background: '#cb253a' },
      })
        .jpeg({ quality: 100 })
        .toBuffer();
      await writeFile(path, source);
      await until(() => payloads.length === 1);
      const result = await processJpeg({
        input_path: path,
        options: { ...options(f.folder), watch_version: payloads[0].version },
        process_options: { quality: 50 },
      });
      assert.equal(await f.records.status(result.output_path), 'output');
      assert.equal(await f.records.status(result.convert_results[0].output_path), 'output');
      await sleep(300);
      assert.equal(
        payloads.length,
        1,
        'neither the saved JPEG nor converted WebP becomes an input',
      );
      // Even an already-queued output is rejected again at the worker/service boundary.
      await assert.rejects(
        processJpeg({
          input_path: result.output_path,
          options: {
            ...options(f.folder),
            watch_version: await readFileVersion(result.output_path),
          },
          process_options: { quality: 50 },
        }),
        isWatchInputChanged,
      );
      await writeFile(path, source);
      await until(() => payloads.length === 2);
      assert.notEqual(payloads[1].version, payloads[0].version);
      await processJpeg({
        input_path: path,
        options: { ...options(f.folder), watch_version: payloads[1].version },
        process_options: { quality: 50 },
      });
      await sleep(300);
      assert.equal(payloads.length, 2);
      await writeFile(result.output_path, source);
      await until(() => payloads.length === 3);
      assert.equal(
        payloads[2].fullPath,
        result.output_path,
        'a new original replacing a prior output is eligible',
      );
      assert.deepEqual(errors, []);
    } finally {
      watcher.close();
      events.close();
      await f.close();
    }
  },
);

test('PNG lossless and SVG overwrite/save-as paths all register their generated versions', async () => {
  const f = await fixture();
  try {
    const png = join(f.folder, 'input.png');
    const image = await sharp({
      create: { width: 100, height: 100, channels: 3, background: '#00aaff' },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    for (const mode of ['overwrite', 'save_as_new_file']) {
      await writeFile(png, image);
      const result = await processPngLossless({
        input_path: png,
        options: { ...options(f.temp, mode), watch_version: await readFileVersion(png) },
        process_options: {},
      });
      assert.equal(await f.records.status(result.output_path), 'output', mode);
      assert.equal(await f.records.status(result.convert_results[0].output_path), 'output');
    }
    const svg = join(f.folder, 'input.svg');
    await writeFile(
      svg,
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><!-- comment --><rect x="0" y="0" width="20" height="20" fill="red" /></svg>',
    );
    const result = await processSvg({
      input_path: svg,
      options: { ...options(f.temp, 'overwrite'), watch_version: await readFileVersion(svg) },
    });
    assert.equal(await f.records.status(result.output_path), 'output');
  } finally {
    await f.close();
  }
});

test('TinyPNG save-as returns the output hash and protects converted files without a network request', async () => {
  const f = await fixture();
  const previous = getGlobalDispatcher();
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  try {
    const path = join(f.folder, 'tiny.png');
    const image = sharp({ create: { width: 80, height: 80, channels: 3, background: '#3adada' } });
    const input = await image.clone().png({ compressionLevel: 0 }).toBuffer();
    const output = await image.clone().png({ compressionLevel: 9 }).toBuffer();
    await writeFile(path, input);
    mock
      .get('https://api.tinify.com')
      .intercept({ path: '/shrink', method: 'POST' })
      .reply(200, {
        input: { size: input.length, type: 'image/png' },
        output: {
          width: 80,
          height: 80,
          size: output.length,
          type: 'image/png',
          url: 'https://api.tinify.com/result',
        },
      });
    mock
      .get('https://api.tinify.com')
      .intercept({ path: '/result', method: 'GET' })
      .reply(200, output);
    const result = await processTinyPng({
      input_path: path,
      options: { ...options(f.temp), watch_version: await readFileVersion(path) },
      process_options: { api_key: 'test', mime_type: 'image/png' },
    });
    assert.equal(result.hash, await hashFile(result.output_path));
    assert.notEqual(result.hash, await hashFile(path));
    assert.equal(await f.records.status(result.output_path), 'output');
    assert.equal(await f.records.status(result.convert_results[0].output_path), 'output');
    mock.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(previous);
    await mock.close();
    await f.close();
  }
});

test('real filter route rejects late queued output events and stale versions but accepts replacements', async () => {
  const f = await fixture();
  const path = join(f.folder, 'queued.png');
  const filter = async (candidates: { path: string; version: string }[]) => {
    const response = await app.request('http://localhost/filter-inputs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(candidates),
    });
    assert.equal(response.status, 200);
    const result = await response.json() as { inputs: {path:string;version:string}[]; issues: unknown[] };
    assert.deepEqual(result.issues, []);
    return result.inputs;
  };
  try {
    await writeFile(path, 'compressed output');
    const queued = { path, version: (await readFileVersion(path))! };
    await f.records.remember(path); // File event came first; completion arrives before execution.
    assert.deepEqual(await filter([queued]), []);
    await writeFile(path, 'new input');
    assert.deepEqual(await filter([queued]), []);
    const replacement = { path, version: (await readFileVersion(path))! };
    assert.deepEqual(await filter([replacement]), [replacement]);
  } finally {
    await f.close();
  }
});
