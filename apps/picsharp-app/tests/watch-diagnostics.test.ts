import test from 'node:test';
import assert from 'node:assert/strict';
import { filterWatchInputs } from '../src/utils/watch-queue';

test('healthy candidates continue while a damaged record reports its affected path', async () => {
  const originalFetch = globalThis.fetch;
  const healthy = { path: '/watch/healthy.png', version: 'v1' };
  const issue = { path: '/watch/bad.png', code: 'OUTPUT_RECORD_INVALID', message: 'Invalid record' };
  const reported: unknown[] = [];
  globalThis.fetch = async () => Response.json({ inputs: [healthy], issues: [issue] });
  try {
    const inputs = await filterWatchInputs('http://localhost', [healthy], {
      onIssues: (issues: unknown[]) => reported.push(...issues),
    } as any);
    assert.deepEqual(inputs, [healthy], 'response diagnostics must not be parsed as inputs');
    assert.deepEqual(reported, [issue], 'the affected path must reach the visible UI');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
