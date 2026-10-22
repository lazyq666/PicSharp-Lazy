import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, writeFile, appendFile, rm, utimes, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createMediaEvents, isMedia, isVideoOutput } from '../src/controllers/watch/media';

test('mixed media filters include uppercase video and exclude generated outputs', () => {
  for (const file of ['a.JPG', 'a.png', 'a.MP4', 'a.mov', 'a.MKV', 'a.webm', 'a.m2ts'])
    assert.equal(isMedia(file), true, file);
  for (const file of [
    'a.txt',
    '.picsharp-video-job.mp4',
    '.picsharp-image-job.png',
    'a_picsharp_av1_47.mp4',
    'a_picsharp_h264_28_2.MP4',
  ])
    assert.equal(isMedia(file), false, file);
  assert.equal(isVideoOutput('a_picsharp_av1_35_10.mp4'), true);
});

test('video import waits for stable writes, deduplicates events, and detects replacement', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'picsharp-watch-'));
  const path = join(folder, 'clip.MP4');
  const emitted: unknown[] = [];
  const events = createMediaEvents((payload) => emitted.push(payload), 120, 20);
  try {
    await writeFile(path, 'start');
    events.add({ fullPath: path, isFile: true });
    for (let i = 0; i < 4; i++) {
      await sleep(60);
      await appendFile(path, 'more');
      events.add({ fullPath: path, isFile: true });
      assert.equal(emitted.length, 0);
    }
    await sleep(220);
    assert.equal(emitted.length, 1);
    events.add({ fullPath: path, isFile: true });
    await sleep(200);
    assert.equal(emitted.length, 1);
    await appendFile(path, 'new version');
    events.add({ fullPath: path, isFile: true });
    await sleep(220);
    assert.equal(emitted.length, 2);
    const output = join(folder, 'clip_picsharp_av1_47.mp4');
    await writeFile(output, 'result');
    events.add({ fullPath: output, isFile: true });
    assert.equal(emitted.length, 2);
  } finally {
    events.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('images wait for stable writes, and stopping cancels pending imports', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'picsharp-watch-'));
  const path = join(folder, 'clip.mp4');
  const emitted: unknown[] = [];
  const events = createMediaEvents((payload) => emitted.push(payload), 80, 20);
  try {
    const image = join(folder, 'image.png');
    await writeFile(image, 'image');
    events.add({ fullPath: image, isFile: true });
    assert.equal(emitted.length, 0);
    await sleep(160);
    assert.equal(emitted.length, 1);
    await writeFile(path, 'video');
    events.add({ fullPath: path, isFile: true });
    events.close();
    await sleep(160);
    assert.equal(emitted.length, 1);
  } finally {
    events.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('same-size/mtime edits and atomic replacements are distinct versions of images and videos', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'picsharp-replacement-'));
  const emitted: { fullPath: string; version?: string }[] = [];
  const events = createMediaEvents((payload) => emitted.push(payload), 30, 10);
  const timestamp = new Date('2026-01-01T00:00:00Z');
  try {
    for (const ext of ['png', 'mp4']) {
      const path = join(folder, `source.${ext}`);
      await writeFile(path, 'AAAA');
      await utimes(path, timestamp, timestamp);
      events.add({ fullPath: path, isFile: true });
      await sleep(100);
      await writeFile(path, 'BBBB');
      await utimes(path, timestamp, timestamp);
      events.add({ fullPath: path, isFile: true });
      await sleep(100);
      const incoming = join(folder, `incoming.${ext}`);
      await writeFile(incoming, 'CCCC');
      await utimes(incoming, timestamp, timestamp);
      await rename(incoming, path);
      events.add({ fullPath: path, isFile: true });
      await sleep(100);
      const versions = emitted
        .filter((entry) => entry.fullPath === path)
        .map((entry) => entry.version);
      assert.equal(new Set(versions).size, 3, ext);
    }
  } finally {
    events.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('an empty file is not imported, and a later write is handled normally', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'picsharp-empty-watch-'));
  const path = join(folder, 'empty.mp4');
  const emitted: unknown[] = [];
  const events = createMediaEvents((payload) => emitted.push(payload), 30, 10);
  try {
    await writeFile(path, '');
    events.add({ fullPath: path, isFile: true });
    await sleep(100);
    assert.equal(emitted.length, 0);
    await writeFile(path, 'video');
    events.add({ fullPath: path, isFile: true });
    await sleep(100);
    assert.equal(emitted.length, 1);
  } finally {
    events.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('a delayed error from the removed version cannot cancel a replacement', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'picsharp-stat-race-'));
  const path = join(folder, 'replaced.mp4');
  await writeFile(path, 'replacement');
  const originalStat = fs.stat;
  let first = true;
  let rejectOld!: (error: Error) => void;
  fs.stat = ((target, ...args) => {
    if (target === path && first) {
      first = false;
      return new Promise((_resolve, reject) => {
        rejectOld = reject;
      });
    }
    return originalStat(target, ...args);
  }) as typeof originalStat;
  syncBuiltinESMExports();
  const emitted: unknown[] = [];
  const events = createMediaEvents((payload) => emitted.push(payload), 30, 10);
  try {
    events.add({ fullPath: path, isFile: true });
    events.remove(path);
    events.add({ fullPath: path, isFile: true });
    rejectOld(Object.assign(new Error('old file disappeared'), { code: 'ENOENT' }));
    await sleep(100);
    assert.equal(emitted.length, 1);
  } finally {
    events.close();
    fs.stat = originalStat;
    syncBuiltinESMExports();
    await rm(folder, { recursive: true, force: true });
  }
});

test('video deduplication is bounded and removal drops pending work', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'picsharp-bounded-watch-'));
  const emitted: string[] = [];
  const events = createMediaEvents((payload) => emitted.push(payload.fullPath), 30, 10, 2);
  try {
    for (const name of ['a.mp4', 'b.mp4', 'c.mp4']) {
      const path = join(folder, name);
      await writeFile(path, 'video');
      events.add({ fullPath: path, isFile: true });
      await sleep(80);
    }
    assert.equal(emitted.length, 3);
    events.add({ fullPath: join(folder, 'c.mp4'), isFile: true });
    await sleep(80);
    assert.equal(emitted.length, 3, 'recent versions remain deduplicated');
    events.add({ fullPath: join(folder, 'a.mp4'), isFile: true });
    await sleep(80);
    assert.equal(emitted.length, 4, 'old entries no longer occupy the in-memory index');
    const removed = join(folder, 'removed.mp4');
    await writeFile(removed, 'pending');
    events.add({ fullPath: removed, isFile: true });
    events.remove(removed);
    await sleep(80);
    assert.equal(emitted.length, 4);
  } finally {
    events.close();
    await rm(folder, { recursive: true, force: true });
  }
});
