import test from 'node:test';
import assert from 'node:assert/strict';
import { realpath, mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { watchMediaFiles } from '../src/controllers/watch/files';
import { createMediaEvents } from '../src/controllers/watch/media';

async function until(condition: () => boolean, milliseconds = 3000) {
  const deadline = Date.now() + milliseconds;
  while (!condition()) { assert.ok(Date.now() < deadline, 'expected watch event'); await sleep(20); }
}

for (const [name, ignores, skipped, accepted] of [
  ['filename glob', ['*.png'], ['a.png', 'nested/b.png'], ['c.jpg']],
  ['directory glob', ['**/draft/**'], ['draft/a.png', 'nested/draft/b.jpg'], ['publish/c.png']],
  ['literal path', ['hold_area'], ['hold_area/a.png', 'nested/hold_area/b.jpg'], ['publish/c.png']],
  ['empty ignored rule', ['', '  '], [], ['a.png', 'nested/b.jpg']],
] as const) {
  test(`WATCH-002/010 ${name} filters actual watch imports`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'picsharp-ignore-repair-')));
    const emitted: string[] = [];
    const errors: Error[] = [];
    const events = createMediaEvents(p => emitted.push(p.fullPath), 40, 10);
    const watcher = watchMediaFiles(root, [...ignores], events, e => errors.push(e));
    try {
      await watcher.ready;
      for (const path of [...skipped, ...accepted]) {
        const absolute = join(root, path);
        await mkdir(join(absolute, '..'), { recursive: true });
        await writeFile(absolute, 'synthetic image input');
      }
      await until(() => accepted.every(path => emitted.includes(join(root, path))));
      await sleep(180);
      assert.deepEqual(emitted.sort(), accepted.map(path => join(root, path)).sort());
      assert.deepEqual(errors, []);
    } finally { watcher.close(); events.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test('WATCH-003 SSE reports the inaccessible subtree while healthy images still arrive', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'picsharp-permission-repair-')));
  const denied = join(root, 'denied');
  await mkdir(denied);
  await writeFile(join(denied, 'blocked.png'), 'blocked');
  await chmod(denied, 0);
  const controller = new AbortController();
  const events: { event: string; data: string }[] = [];
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let reading: Promise<void> | undefined;
  try {
    const { default: app } = await import('../src/controllers/watch/index');
    const response = await app.request('http://localhost/new-images', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: root }), signal: controller.signal,
    });
    reader = response.body!.getReader();
    reading = (async () => {
      let buffer = ''; const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader!.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const field = (key: string) => block.split('\n').find(l => l.startsWith(key + ':'))?.slice(key.length + 1).trim() || '';
          events.push({ event: field('event'), data: field('data') });
        }
      }
    })();
    await until(() => events.some(e => e.event === 'ready'));
    await writeFile(join(root, 'healthy.png'), 'healthy');
    await until(() => events.some(e => e.event === 'add' && JSON.parse(e.data).fullPath === join(root, 'healthy.png')));
    const fault = events.find(e => e.event === 'fault');
    assert.ok(fault, 'inaccessible child must report a partial coverage fault');
    let details: any;
    try { details = JSON.parse(fault.data); } catch { details = { message: fault.data }; }
    assert.equal(details.path, denied);
    assert.equal(details.code, 'EACCES');
    assert.equal(details.scope, 'subtree');
    await chmod(denied, 0o755);
    await writeFile(join(denied, 'recovered.png'), 'recovered');
    await until(() => events.some(e => e.event === 'add' && JSON.parse(e.data).fullPath === join(denied, 'recovered.png')));
  } finally {
    controller.abort(); await reader?.cancel(); await reading;
    await chmod(denied, 0o755); await rm(root, { recursive: true, force: true });
  }
});
