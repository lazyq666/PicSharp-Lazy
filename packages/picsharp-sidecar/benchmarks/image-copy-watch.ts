// Run from repository root with tsx. Uses disposable directories and real fs.watch.
// Optional first argument: a directory containing already compressed PNG fixtures.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  mkdtemp,
  realpath,
  mkdir,
  copyFile,
  writeFile,
  readFile,
  rm,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import sharp from 'sharp';
import { OutputRecords } from '../src/services/output-records';
import { createMediaEvents } from '../src/controllers/watch/media';
import { watchMediaFiles } from '../src/controllers/watch/files';

async function noisePng(width: number) {
  const raw = Buffer.alloc(width * width * 3);
  let seed = 123456789;
  for (let i = 0; i < raw.length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    raw[i] = seed & 255;
  }
  return sharp(raw, { raw: { width, height: width, channels: 3 } })
    .png()
    .toBuffer();
}
async function run(name: string, buffers: Buffer[], count: number, baseline = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'picsharp-copy-bench-')));
  const watched = join(root, 'watched');
  await mkdir(watched);
  const records = new OutputRecords(join(root, 'records'));
  const sources: string[] = [];
  for (let i = 0; i < buffers.length; i++) {
    const source = join(root, `source-${i}.png`);
    await writeFile(source, buffers[i]);
    await records.remember(source);
    sources.push(source);
  }
  // Warm migration just as an already running watcher would; report separately.
  const warmStart = performance.now();
  const warm = join(root, 'warm.png');
  await writeFile(warm, 'not a matching size');
  await records.watchStatus(warm);
  const indexStartupMs = performance.now() - warmStart;
  const checked = new Set<string>(),
    emitted: string[] = [],
    errors: Error[] = [];
  const check = baseline ? records.status.bind(records) : records.watchStatus.bind(records);
  records.watchStatus = async (...args) => {
    const result = await check(...args);
    if (result !== 'writing') checked.add(args[0]);
    return result;
  };
  let reads = 0,
    readBytes = 0,
    active = 0,
    peakReads = 0;
  const original = fs.createReadStream;
  fs.createReadStream = ((...args: Parameters<typeof original>) => {
    const stream = original(...args);
    if (String(args[0]).startsWith(watched + '/')) {
      reads++;
      active++;
      peakReads = Math.max(peakReads, active);
      stream.on('data', (chunk) => {
        readBytes += Buffer.byteLength(chunk);
      });
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
  const events = createMediaEvents(
    (e) => emitted.push(e.fullPath),
    3000,
    750,
    4096,
    records,
    (e) => errors.push(e),
  );
  const watcher = watchMediaFiles(watched, [], events, (e) => errors.push(e));
  const lag = monitorEventLoopDelay({ resolution: 10 });
  let peakRss = process.memoryUsage().rss;
  const sample = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 10);
  try {
    await watcher.ready;
    lag.enable();
    const startRss = process.memoryUsage().rss;
    const cpu = process.cpuUsage(),
      start = performance.now();
    for (let offset = 0; offset < count; offset += 16) {
      await Promise.all(
        Array.from({ length: Math.min(16, count - offset) }, (_, j) => {
          const i = offset + j;
          return copyFile(sources[i % sources.length], join(watched, `copy-${i}.png`));
        }),
      );
    }
    const copyFinishedMs = performance.now() - start;
    while (checked.size < count) {
      assert.ok(performance.now() - start < 60000, `timeout: ${checked.size}/${count}`);
      await sleep(10);
    }
    const settledMs = performance.now() - start,
      used = process.cpuUsage(cpu);
    assert.deepEqual(errors, []);
    await sleep(550);
    assert.equal(emitted.length, baseline ? count : 0);
    const idleReadsBefore = reads;
    await sleep(1000);
    assert.equal(reads, idleReadsBefore, 'idle watch must not reread images');
    const mib = (n: number) => +(n / 1024 / 1024).toFixed(2);
    const round = (n: number) => +n.toFixed(2);
    const result = {
      name,
      mode: baseline
        ? 'prior identity-only detection (no compression executed)'
        : 'copy suppression',
      count,
      totalMiB: mib(
        Array.from({ length: count }, (_, i) => buffers[i % buffers.length].length).reduce(
          (a, b) => a + b,
          0,
        ),
      ),
      indexStartupMs: round(indexStartupMs),
      copyFinishedMs: round(copyFinishedMs),
      settledMs: round(settledMs),
      afterCopyMs: round(settledMs - copyFinishedMs),
      cpuMs: round((used.user + used.system) / 1000),
      hashReads: reads,
      hashReadMiB: mib(readBytes),
      peakHashReads: peakReads,
      peakRssMiB: mib(peakRss),
      rssGrowthMiB: mib(Math.max(0, peakRss - startRss)),
      eventLoopP99Ms: round(lag.percentile(99) / 1e6),
      eventLoopMaxMs: round(lag.max / 1e6),
      queuedForCompression: emitted.length,
      idleImageReads: reads - idleReadsBefore,
    };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    clearInterval(sample);
    lag.disable();
    watcher.close();
    events.close();
    fs.createReadStream = original;
    syncBuiltinESMExports();
    await sleep(100);
    await rm(root, { recursive: true, force: true });
  }
}
async function legacyIndexBenchmark() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'picsharp-copy-migration-bench-')));
  try {
    const directory = join(root, 'records');
    await mkdir(directory);
    const bytes = await noisePng(256),
      copy = join(root, 'copy.png');
    await writeFile(copy, bytes);
    const fingerprint = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    const count = 2000;
    for (let offset = 0; offset < count; offset += 32) {
      await Promise.all(
        Array.from({ length: Math.min(32, count - offset) }, (_, j) => {
          const path = join(root, `old-${offset + j}.png`);
          return writeFile(
            join(directory, createHash('sha256').update(path).digest('hex') + '.json'),
            JSON.stringify({ path, version: `1:2:${bytes.length}:3:4`, fingerprint }),
          );
        }),
      );
    }
    const start = performance.now();
    assert.equal(await new OutputRecords(directory).watchStatus(copy), 'output');
    const coldMs = performance.now() - start;
    const next = join(root, 'copy2.png');
    await copyFile(copy, next);
    const warmStart = performance.now();
    assert.equal(await new OutputRecords(directory).watchStatus(next), 'output');
    console.log(
      JSON.stringify({
        name: 'legacy index migration',
        records: count,
        coldMigrationAndFirstMatchMs: +coldMs.toFixed(2),
        restartAndNextMatchMs: +(performance.now() - warmStart).toFixed(2),
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function main() {
  if (process.argv.includes('--legacy-only')) return legacyIndexBenchmark();
  console.log(
    JSON.stringify({
      runtime: process.version,
      platform: process.platform,
      arch: process.arch,
      note: 'Real local fs.watch, default 500ms image stability window; compression queue only, no encoder runs.',
    }),
  );
  const small = await noisePng(256),
    large = await noisePng(1024);
  if (process.argv[2]) {
    const dir = process.argv[2];
    const fixtures = await Promise.all(
      (await readdir(dir)).filter((n) => n.endsWith('.png')).map((n) => readFile(join(dir, n))),
    );
    assert.ok(fixtures.length);
    await run('provided UI images', fixtures, fixtures.length);
    await run('provided UI images repeated', [...fixtures], 1000);
  }
  await run('1000 small PNGs', [small], 1000, true);
  await run('1000 small PNGs', [small], 1000);
  await run('100 large PNGs', [large], 100);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
