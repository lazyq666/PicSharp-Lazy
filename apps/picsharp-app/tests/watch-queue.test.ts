import test from 'node:test';
import assert from 'node:assert/strict';
import { WatchQueue, filterWatchInputs } from '../src/utils/watch-queue';

test('replacement while compressing keeps only the latest version and resumes after completion', () => {
  const queue = new WatchQueue();
  queue.add({ path: '/video.mp4', version: 'first' });
  assert.deepEqual(
    queue.take(() => false),
    [{ path: '/video.mp4', version: 'first' }],
  );
  queue.add({ path: '/video.mp4', version: 'second' });
  queue.add({ path: '/video.mp4', version: 'third' });
  queue.add({ path: '/image.png', version: 'image' });
  assert.deepEqual(
    queue.take((path) => path === '/video.mp4'),
    [{ path: '/image.png', version: 'image' }],
  );
  assert.equal(
    queue.hasReady(() => true),
    false,
  );
  assert.deepEqual(
    queue.take(() => false),
    [{ path: '/video.mp4', version: 'third' }],
  );
  assert.equal(
    queue.hasReady(() => false),
    false,
  );
});

test('a slow version check or failed request cannot replace a newer queued event', () => {
  const queue = new WatchQueue();
  queue.add({ path: '/image.png', version: 'old' });
  const checking = queue.take(() => false);
  queue.add({ path: '/image.png', version: 'new' });
  assert.equal(queue.hasNewer(checking[0]), true);
  queue.retry(checking);
  assert.deepEqual(
    queue.take(() => false),
    [{ path: '/image.png', version: 'new' }],
  );
});

test('identical contents at different paths remain separate inputs; batches are bounded', () => {
  const queue = new WatchQueue();
  for (let i = 0; i < 600; i++) queue.add({ path: `/${i}.png`, version: 'same' });
  assert.equal(queue.take(() => false).length, 256);
  assert.equal(queue.take(() => false).length, 256);
  assert.equal(queue.take(() => false).length, 88);
  queue.add({ path: '/new.png', version: 'new' });
  queue.clear();
  assert.deepEqual(
    queue.take(() => false),
    [],
  );
});

test('a file event queued before completion is rechecked against output records before execution', async () => {
  const originalFetch = globalThis.fetch;
  const queue = new WatchQueue();
  queue.add({ path: '/image.png', version: 'output' });
  let knownOutput = false;
  let checks = 0;
  globalThis.fetch = async (_url, init) => {
    checks++;
    const candidates = JSON.parse(String(init?.body));
    return Response.json(knownOutput ? [] : candidates);
  };
  try {
    knownOutput = true; // Compression completion arrives after the file event.
    assert.deepEqual(
      await filterWatchInputs(
        'http://localhost',
        queue.take(() => false),
      ),
      [],
    );
    assert.equal(checks, 1);
    globalThis.fetch = async () => new Response('offline', { status: 503 });
    await assert.rejects(
      filterWatchInputs('http://localhost', [{ path: '/image.png', version: 'input' }]),
      /无法核对/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('watch ignore skips .9 images without matching directories, similar names or videos', async () => {
  const originalFetch = globalThis.fetch;
  const skipped = [
    '/design/button.9.png',
    '/design/panel.9.PNG',
    '/design/panel.9.webp',
    '/design/照片.9.jpeg',
    String.raw`C:\design\button.9.png`,
  ];
  const kept = [
    '/design/button.png',
    '/design.9.png/button.png',
    '/design.9/button.png',
    '/design/button.99.png',
    '/design/button9.png',
    '/design/button.9.backup.png',
    '/design/clip.9.mp4',
    String.raw`C:\design.9.png\button.png`,
  ];
  const candidates = [...skipped, ...kept].map((path) => ({ path, version: 'input' }));
  const controller = new AbortController();
  let checked: typeof candidates = [];
  globalThis.fetch = async (_url, init) => {
    assert.equal(init?.signal, controller.signal);
    checked = JSON.parse(String(init?.body));
    return Response.json(checked);
  };
  try {
    const result = await filterWatchInputs('http://localhost', candidates, {
      ignoreNinePatch: true,
      signal: controller.signal,
    });
    assert.deepEqual(
      result.map(({ path }) => path),
      kept,
    );
    assert.deepEqual(checked, result);
    assert.equal(candidates.length, skipped.length + kept.length);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('changing the ignore setting applies to the next queued batch without restarting the watch', async () => {
  const originalFetch = globalThis.fetch;
  const queue = new WatchQueue();
  const candidate = { path: '/button.9.png', version: 'input' };
  let checks = 0;
  globalThis.fetch = async (_url, init) => {
    checks++;
    return Response.json(JSON.parse(String(init?.body)));
  };
  try {
    for (const ignoreNinePatch of [true, false, true]) {
      queue.add(candidate);
      const result = await filterWatchInputs(
        'http://localhost',
        queue.take(() => false),
        {
          ignoreNinePatch,
        },
      );
      assert.deepEqual(result, ignoreNinePatch ? [] : [candidate]);
      assert.equal(
        queue.hasReady(() => false),
        false,
      );
    }
    assert.equal(checks, 1, 'ignored-only batches never reach the compression backend');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
