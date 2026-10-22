import test from 'node:test';
import assert from 'node:assert/strict';
import { realpath, mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

test(
  'live watch imports nested mixed media after video copies finish, excluding outputs',
  { skip: !process.env.PICSHARP_TEST_SIDECAR_URL, timeout: 20000 },
  async () => {
    const folder = await realpath(await mkdtemp(join(tmpdir(), 'picsharp-live-watch-')));
    const controller = new AbortController();
    const events: { event: string; data: string }[] = [];
    let reading: Promise<void> | undefined;
    try {
      const response = await fetch(
        `${process.env.PICSHARP_TEST_SIDECAR_URL}/stream/watch/new-images`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer picsharp_sidecar' },
          body: JSON.stringify({ path: folder, ignores: [] }),
          signal: controller.signal,
        },
      );
      assert.equal(response.status, 200);
      reading = (async () => {
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const field = (name: string) =>
              block
                .split('\n')
                .find((line) => line.startsWith(`${name}:`))
                ?.slice(name.length + 1)
                .trim() || '';
            events.push({ event: field('event'), data: field('data') });
          }
        }
      })().catch((error) => {
        if (!controller.signal.aborted) throw error;
      });
      const until = async (condition: () => boolean) => {
        const deadline = Date.now() + 8000;
        while (!condition()) {
          if (Date.now() > deadline) throw new Error(`Watch timed out: ${JSON.stringify(events)}`);
          await sleep(100);
        }
      };
      await until(() => events.some((event) => event.event === 'ready'));
      const nested = join(folder, 'new-subfolder');
      await mkdir(nested);
      const video = join(nested, 'copying.MP4');
      await writeFile(video, 'first bytes');
      for (let index = 0; index < 4; index++) {
        await sleep(500);
        await appendFile(video, 'more bytes');
      }
      assert.equal(events.filter((event) => event.event === 'add').length, 0);
      await until(() =>
        events.some((event) => event.event === 'add' && JSON.parse(event.data).fullPath === video),
      );
      const image = join(nested, 'image.PNG');
      await writeFile(image, 'image bytes');
      await until(() =>
        events.some((event) => event.event === 'add' && JSON.parse(event.data).fullPath === image),
      );
      const output = join(nested, 'copying_picsharp_av1_47.mp4');
      await writeFile(output, 'output bytes');
      await writeFile(join(nested, '.picsharp-video-test.mp4'), 'partial output');
      await sleep(3800);
      assert.equal(
        events.filter((event) => event.event === 'add' && JSON.parse(event.data).fullPath === video)
          .length,
        1,
      );
      assert.equal(events.filter((event) => event.event === 'add').length, 2);
    } finally {
      controller.abort();
      await reading;
      await rm(folder, { recursive: true, force: true });
    }
  },
);
