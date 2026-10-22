import test from 'node:test';
import assert from 'node:assert/strict';
import { realpath, mkdtemp, mkdir, writeFile, rename, rm, open } from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createMediaEvents } from '../src/controllers/watch/media';
import { watchMediaFiles } from '../src/controllers/watch/files';

async function until(condition: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'file event did not arrive');
    await sleep(20);
  }
}

test(
  'video watcher handles moved directories and replacements without reading video content',
  { timeout: 15000 },
  async () => {
    const folder = await realpath(await mkdtemp(join(tmpdir(), 'picsharp-video-watch-')));
    const incoming = await realpath(await mkdtemp(join(tmpdir(), 'picsharp-incoming-')));
    const emitted: string[] = [];
    const errors: Error[] = [];
    let videoReads = 0;
    const original = fs.createReadStream;
    fs.createReadStream = ((...args: Parameters<typeof original>) => {
      if (String(args[0]).startsWith(folder) && /\.mp4$/i.test(String(args[0]))) videoReads += 1;
      return original(...args);
    }) as typeof original;
    syncBuiltinESMExports();
    const events = createMediaEvents((payload) => emitted.push(payload.fullPath), 50, 15);
    const watcher = watchMediaFiles(folder, ['ignored'], events, (error) => errors.push(error));
    try {
      await watcher.ready;
      // Sparse files are large logically, but require no large allocation to construct.
      for (let i = 0; i < 24; i++) {
        const file = await open(join(incoming, `${i}.MP4`), 'w');
        await file.truncate(16 * 1024 * 1024);
        await file.close();
      }
      await rename(incoming, join(folder, 'moved'));
      await until(() => emitted.length === 24);
      assert.equal(videoReads, 0);
      const changed = join(folder, 'moved', '0.MP4');
      await writeFile(changed, 'replacement');
      await until(() => emitted.filter((path) => path === changed).length === 2);
      await mkdir(join(folder, 'ignored'));
      await writeFile(join(folder, 'ignored', 'skip.mp4'), 'skip');
      await writeFile(join(folder, '.picsharp-video-work.mp4'), 'partial');
      await sleep(150);
      assert.equal(emitted.length, 25);
      watcher.close();
      events.close();
      await writeFile(join(folder, 'after-close.mp4'), 'closed');
      await sleep(150);
      assert.equal(emitted.length, 25);
      assert.deepEqual(errors, []);
    } finally {
      watcher.close();
      events.close();
      fs.createReadStream = original;
      syncBuiltinESMExports();
      await rm(folder, { recursive: true, force: true });
      await rm(incoming, { recursive: true, force: true });
    }
  },
);

test('directory reconciliation does not reimport existing files; removing the root closes the watch', async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'picsharp-watch-root-')));
  const emitted: string[] = [];
  const errors: Error[] = [];
  await writeFile(join(folder, 'existing.png'), 'existing');
  const events = createMediaEvents((payload) => emitted.push(payload.fullPath), 40, 10);
  let missing = false;
  const watcher = watchMediaFiles(
    folder,
    [],
    events,
    (error) => errors.push(error),
    () => {
      missing = true;
    },
  );
  try {
    await watcher.ready;
    // A directory name with a media extension must not be discarded by an extension filter.
    await mkdir(join(folder, 'directory.mp4'));
    const child = join(folder, 'directory.mp4', 'new.png');
    await writeFile(child, 'new');
    await until(() => emitted.includes(child));
    assert.deepEqual(emitted, [child]);
    await rm(folder, { recursive: true, force: true });
    await until(() => missing);
    assert.deepEqual(errors, []);
  } finally {
    watcher.close();
    events.close();
    await rm(folder, { recursive: true, force: true });
  }
});
