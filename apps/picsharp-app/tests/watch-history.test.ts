import test from 'node:test';
import assert from 'node:assert/strict';
import { trimWatchHistory } from '../src/utils/watch-history';

test('a continuous watch retains active jobs and the latest 500 finished cards', () => {
  const finished = Array.from({ length: 2000 }, (_, id) => ({ id, status: 'completed' }));
  const active = [
    { id: -1, status: 'processing' },
    { id: -2, status: 'pending' },
  ];
  const kept = trimWatchHistory([...active, ...finished]);
  assert.equal(kept.length, 502);
  assert.deepEqual(kept.slice(0, 2), active);
  assert.equal(kept[2].id, 1500);
  assert.equal(kept.at(-1)?.id, 1999);
  assert.equal(finished.length, 2000);
});

test('no unnecessary store update when the watch is below its history limit', () => {
  const files = [{ status: 'failed' }, { status: 'cancelled' }];
  assert.equal(trimWatchHistory(files), files);
});
