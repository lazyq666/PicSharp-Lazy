import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
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

test('stopping a watch cancels pending imports and images still import immediately', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'picsharp-watch-'));
  const path = join(folder, 'clip.mp4');
  const emitted: unknown[] = [];
  const events = createMediaEvents((payload) => emitted.push(payload), 80, 20);
  try {
    events.add({ fullPath: join(folder, 'image.png'), isFile: true });
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
