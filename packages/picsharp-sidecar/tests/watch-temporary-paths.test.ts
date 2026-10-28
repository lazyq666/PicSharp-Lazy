import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createMediaEvents, isMedia, isTemporaryMedia, isVideoOutput } from '../src/controllers/watch/media';
import { watchMediaFiles } from '../src/controllers/watch/files';

for (const path of [
  '/watch/PicSharp Videos/.picsharp-video-job/output.mp4',
  '/watch/.picsharp-image-job/output.png',
  'C:\\watch\\PicSharp Videos\\.picsharp-video-job\\output.mp4',
]) {
  test(`work directory descendants are excluded: ${path}`, () => {
    assert.equal(isTemporaryMedia(path), true);
    assert.equal(isVideoOutput(path), true);
    assert.equal(isMedia(path), false);
  });
}

test('real watcher ignores media written inside task work directories while importing normal nested video', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'picsharp-temp-path-regression-')));
  const videoWork = join(root, 'PicSharp Videos', '.picsharp-video-ours');
  const imageWork = join(root, '.picsharp-image-ours');
  const normal = join(root, 'assets', 'nested.mp4');
  // Existing work directories exercise direct deep fs.watch notifications, rather
  // than relying on the parent directory event pruning a later recursive scan.
  await mkdir(videoWork, { recursive: true });
  await mkdir(imageWork);
  await mkdir(join(root, 'assets'));
  const emitted: string[] = [];
  const errors: Error[] = [];
  const events = createMediaEvents(payload => emitted.push(payload.fullPath), 40, 10);
  const watcher = watchMediaFiles(root, [], events, error => errors.push(error));
  try {
    await watcher.ready;
    await writeFile(join(videoWork, 'output.mp4'), 'partial real encoder output');
    await writeFile(join(imageWork, 'output.png'), 'partial real image output');
    await writeFile(normal, 'normal newly exported nested video');
    const deadline = Date.now() + 4000;
    while (!emitted.includes(normal)) {
      assert.ok(Date.now() < deadline, `normal video did not arrive: ${JSON.stringify(emitted)}`);
      await sleep(20);
    }
    await sleep(200);
    assert.deepEqual(emitted, [normal], 'task work files must never appear as user input');
    assert.deepEqual(errors, []);
  } finally {
    watcher.close(); events.close(); await rm(root, { recursive: true, force: true });
  }
});
