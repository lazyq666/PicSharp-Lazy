import test from 'node:test';
import assert from 'node:assert/strict';
import { createClassicHarness, deferred } from './helpers/classic-drop-harness.mjs';

for (const [first, second] of [
  ['png', 'png'],
  ['png', 'mp4'],
  ['mp4', 'png'],
]) {
  test(`classic drop: ${first} then ${second} appends through the guide-to-workspace transition`, async () => {
    const h = await createClassicHarness();
    try {
      await h.emit([`/fixture/first.${first}`]);
      assert.equal(h.fixture.location, '/compression/classic/workspace');
      await h.emit([`/fixture/second.${second}`]);
      assert.deepEqual(h.paths(), [`/fixture/first.${first}`, `/fixture/second.${second}`]);
      assert.equal(
        h.fixture.listeners.size,
        1,
        'one native subscription survives the route transition',
      );
      assert.equal(h.parseCalls().length, 2);
    } finally {
      await h.close();
    }
  });
}

test('classic drop: duplicates preserve an active video object, progress, and selection', async () => {
  const h = await createClassicHarness();
  try {
    await h.emit(['/fixture/active.mp4']);
    const original = h.store.getState().files[0];
    const progress = { fraction: 0.4, seconds: 4 };
    Object.assign(original, {
      status: 'processing',
      videoProgress: progress,
      outputPath: '/fixture/result.mp4',
    });
    h.store.setState({ inCompressing: true, selectedFiles: [] });
    await h.emit(['/fixture/active.mp4', '/fixture/new.png', '/fixture/new.png']);
    assert.deepEqual(h.paths(), ['/fixture/active.mp4', '/fixture/new.png']);
    assert.equal(h.store.getState().files[0], original);
    assert.equal(original.videoProgress, progress);
    assert.equal(original.status, 'processing');
    assert.equal(h.store.getState().inCompressing, true);
    assert.deepEqual(h.store.getState().selectedFiles, ['/fixture/new.png']);
    assert.equal(h.store.getState().files[1].status, 'pending');
    assert.equal(
      h.registerCalls().length,
      1,
      'dropping an existing active video does not register it again',
    );
  } finally {
    await h.close();
  }
});

test('classic drop: completed results survive later imports and the new file remains pending', async () => {
  const h = await createClassicHarness();
  try {
    await h.emit(['/fixture/completed.png']);
    const original = h.store.getState().files[0];
    Object.assign(original, {
      status: 'completed',
      outputPath: '/fixture/compressed.png',
      compressRate: '40%',
    });
    await h.emit(['/fixture/next.mp4']);
    assert.equal(h.store.getState().files[0], original);
    assert.equal(original.outputPath, '/fixture/compressed.png');
    assert.equal(original.status, 'completed');
    assert.equal(h.store.getState().files[1].status, 'pending');
    assert.equal(h.store.getState().inCompressing, false);
  } finally {
    await h.close();
  }
});

test('classic drop: rapid imports keep drop order while the first parse is delayed', async () => {
  const h = await createClassicHarness();
  const first = deferred();
  try {
    h.fixture.parseHooks.set('/fixture/slow.png', () => first.promise);
    await h.emit(['/fixture/slow.png']);
    await h.emit(['/fixture/fast.mp4']);
    assert.equal(h.parseCalls().length, 1, 'the second parse waits for the first import');
    first.resolve();
    await h.settle();
    assert.deepEqual(h.paths(), ['/fixture/slow.png', '/fixture/fast.mp4']);
    assert.equal(h.fixture.listeners.size, 1);
  } finally {
    first.resolve();
    await h.settle();
    await h.close();
  }
});

test('classic drop: a failed or unsupported import leaves the existing batch usable', async () => {
  const h = await createClassicHarness();
  try {
    await h.emit(['/fixture/existing.png']);
    h.fixture.parseHooks.set('/fixture/broken.png', () => {
      throw new Error('fixture parse failed');
    });
    await h.emit(['/fixture/broken.png']);
    await h.emit(['/fixture/unsupported.txt']);
    await h.emit(['/fixture/recovered.png']);
    assert.deepEqual(h.paths(), ['/fixture/existing.png', '/fixture/recovered.png']);
    assert.ok(h.fixture.errors.some((error) => error.includes('fixture parse failed')));
    assert.equal(h.fixture.listeners.size, 1);
  } finally {
    await h.close();
  }
});

test('classic drop: switching modes removes its listener and remounting creates only one', async () => {
  const h = await createClassicHarness();
  try {
    await h.emit(['/fixture/batch.png']);
    await h.navigate('/compression/watch/guide');
    assert.equal(h.fixture.listeners.size, 0);
    const calls = h.parseCalls().length;
    await h.emit(['/fixture/must-not-import.png']);
    assert.equal(h.parseCalls().length, calls);
    await h.navigate('/compression/classic/guide');
    assert.equal(h.fixture.listeners.size, 1);
    await h.emit(['/fixture/new-session.png']);
    assert.equal(h.fixture.listeners.size, 1);
  } finally {
    await h.close();
  }
});

test('classic drop: a native subscription that resolves after unmount is immediately removed', async () => {
  const h = await createClassicHarness({ deferredSubscription: true });
  try {
    await h.unmount();
    await h.resolveSubscriptions();
    assert.equal(h.fixture.listeners.size, 0);
    assert.equal(h.fixture.subscribed, h.fixture.unsubscribed);
  } finally {
    await h.close();
  }
});

test('classic drop: a parse finishing after switching modes cannot repopulate the batch', async () => {
  const h = await createClassicHarness();
  const parse = deferred();
  try {
    h.fixture.parseHooks.set('/fixture/late.png', () => parse.promise);
    await h.emit(['/fixture/late.png']);
    await h.navigate('/outside');
    parse.resolve();
    await h.settle();
    assert.deepEqual(h.paths(), []);
    assert.equal(h.fixture.location, '/outside');
    assert.equal(h.fixture.listeners.size, 0);
  } finally {
    parse.resolve();
    await h.settle();
    await h.close();
  }
});

test('classic drop: resetting the batch invalidates imports already being parsed or queued', async () => {
  const h = await createClassicHarness();
  const parse = deferred();
  try {
    await h.emit(['/fixture/original.png']);
    h.fixture.parseHooks.set('/fixture/late.png', () => parse.promise);
    await h.emit(['/fixture/late.png']);
    await h.emit(['/fixture/queued.png']);
    h.store.getState().reset();
    parse.resolve();
    await h.settle();
    assert.deepEqual(h.paths(), []);
    await h.emit(['/fixture/fresh.png']);
    assert.deepEqual(h.paths(), ['/fixture/fresh.png']);
  } finally {
    parse.resolve();
    await h.settle();
    await h.close();
  }
});

test('classic append: the store preserves existing file identity and deduplicates repeated paths', async () => {
  const h = await createClassicHarness();
  try {
    const original = {
      path: '/fixture/existing.png',
      status: 'completed',
      outputPath: '/fixture/output.png',
    };
    h.store.getState().setFiles([original]);
    h.store.setState({ selectedFiles: [] });
    h.store.getState().appendFiles([
      { path: original.path, status: 'pending' },
      { path: '/fixture/new.png', status: 'pending' },
      { path: '/fixture/new.png', status: 'pending' },
    ]);
    assert.deepEqual(h.paths(), ['/fixture/existing.png', '/fixture/new.png']);
    assert.equal(h.store.getState().files[0], original);
    assert.equal(h.store.getState().fileMap.get(original.path), original);
    assert.deepEqual(h.store.getState().selectedFiles, ['/fixture/new.png']);
  } finally {
    await h.close();
  }
});

test('classic video: a delayed parse cannot register a native job after leaving the batch', async () => {
  const h = await createClassicHarness();
  const parse = deferred();
  try {
    h.fixture.parseHooks.set('/fixture/late.mp4', () => parse.promise);
    await h.emit(['/fixture/late.mp4']);
    await h.navigate('/outside');
    parse.resolve();
    await h.settle();
    assert.equal(
      h.registerCalls().length,
      0,
      'leaving the batch must prevent native registration as well as UI changes',
    );
    assert.deepEqual(h.paths(), []);
    assert.equal(h.fixture.location, '/outside');
  } finally {
    parse.resolve();
    await h.settle();
    await h.close();
  }
});

test('classic video: a delayed parse cannot register a native job after resetting the batch', async () => {
  const h = await createClassicHarness();
  const parse = deferred();
  try {
    await h.emit(['/fixture/existing.png']);
    h.fixture.parseHooks.set('/fixture/late.mp4', () => parse.promise);
    await h.emit(['/fixture/late.mp4']);
    h.store.getState().reset();
    parse.resolve();
    await h.settle();
    assert.equal(
      h.registerCalls().length,
      0,
      'resetting the batch must prevent stale native video registration',
    );
    assert.deepEqual(h.paths(), []);
  } finally {
    parse.resolve();
    await h.settle();
    await h.close();
  }
});

test('classic import: a captured dialog callback cannot import after leaving the batch', async () => {
  const h = await createClassicHarness();
  try {
    const oldImport = h.fixture.importFiles;
    await h.navigate('/outside');
    await oldImport(['/fixture/late-dialog.mp4']);
    await h.settle();
    assert.equal(h.parseCalls().length, 0);
    assert.equal(h.registerCalls().length, 0);
    assert.deepEqual(h.paths(), []);
    assert.equal(h.fixture.location, '/outside');
  } finally {
    await h.close();
  }
});

test('classic import: a captured dialog callback cannot import into a reset batch', async () => {
  const h = await createClassicHarness();
  try {
    const oldImport = h.fixture.importFiles;
    h.store.getState().reset();
    await h.settle();
    await oldImport(['/fixture/late-dialog.mp4']);
    await h.settle();
    assert.equal(h.parseCalls().length, 0);
    assert.equal(h.registerCalls().length, 0);
    assert.deepEqual(h.paths(), []);
    assert.equal(h.fixture.location, '/compression/classic/guide');
    await h.emit(['/fixture/current.png']);
    assert.deepEqual(h.paths(), ['/fixture/current.png']);
  } finally {
    await h.close();
  }
});

test('classic video: directory expansion excludes existing videos before registering new jobs', async () => {
  const h = await createClassicHarness();
  try {
    await h.emit(['/fixture/existing.mp4']);
    const original = h.store.getState().files[0];
    original.status = 'processing';
    h.fixture.directoryEntries.set('/fixture/folder', [
      '/fixture/existing.mp4',
      '/fixture/new.mp4',
      '/fixture/new.png',
      '/fixture/new.png',
    ]);
    await h.emit(['/fixture/folder']);
    assert.deepEqual(h.paths(), ['/fixture/existing.mp4', '/fixture/new.mp4', '/fixture/new.png']);
    assert.equal(h.store.getState().files[0], original);
    assert.equal(original.status, 'processing');
    assert.equal(h.registerCalls().length, 2);
    assert.deepEqual(h.registerCalls()[1].args.paths, ['/fixture/new.mp4']);
    await h.emit(['/fixture/folder']);
    assert.equal(h.registerCalls().length, 2);
    assert.deepEqual(h.paths(), ['/fixture/existing.mp4', '/fixture/new.mp4', '/fixture/new.png']);
  } finally {
    await h.close();
  }
});
