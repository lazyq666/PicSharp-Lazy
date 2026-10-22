import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { realpath, mkdtemp, open, writeFile, mkdir, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

test(
  'mixed-media watch reads no image/video contents, imports changed versions, and closes cleanly',
  { timeout: 20000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'picsharp-watch-route-')));
    let videoBytesRead = 0;
    let imageBytesRead = 0;
    const original = fs.createReadStream;
    fs.createReadStream = ((...args: Parameters<typeof original>) => {
      const stream = original(...args);
      if (String(args[0]).startsWith(root) && /\.mp4$/i.test(String(args[0]))) {
        stream.on('data', (chunk) => {
          videoBytesRead += chunk.length;
        });
      }
      if (String(args[0]).startsWith(root) && /\.png$/i.test(String(args[0]))) {
        stream.on('data', (chunk) => {
          imageBytesRead += chunk.length;
        });
      }
      return stream;
    }) as typeof original;
    syncBuiltinESMExports();
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let reading: Promise<void> | undefined;
    const events: { event: string; data: string }[] = [];
    try {
      for (let i = 0; i < 24; i++) {
        const file = await open(join(root, `${i}.mp4`), 'w');
        await file.truncate(16 * 1024 * 1024);
        await file.close();
      }
      for (let i = 0; i < 3; i++)
        await writeFile(join(root, `existing-${i}.png`), Buffer.alloc(1024 ** 2));
      const { default: app } = await import('../src/controllers/watch/index');
      const response = await app.request('http://localhost/new-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: root }),
        signal: controller.signal,
      });
      assert.equal(response.status, 200);
      reader = response.body!.getReader();
      reading = (async () => {
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader!.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const field = (key: string) =>
              block
                .split('\n')
                .find((line) => line.startsWith(key + ':'))
                ?.slice(key.length + 1)
                .trim() || '';
            events.push({ event: field('event'), data: field('data') });
          }
        }
      })();
      const until = async (condition: () => boolean) => {
        const deadline = Date.now() + 6000;
        while (!condition()) {
          assert.ok(Date.now() < deadline, JSON.stringify(events));
          await sleep(50);
        }
      };
      await until(() => events.some((event) => event.event === 'ready'));
      assert.equal(videoBytesRead, 0, 'starting a watch must not read existing video contents');
      assert.equal(imageBytesRead, 0, 'starting a watch must not read existing image contents');
      const nested = join(root, 'new-folder');
      await mkdir(nested);
      const video = join(nested, 'copying.MP4');
      await writeFile(video, 'first');
      await sleep(400);
      await appendFile(video, 'more');
      assert.equal(events.filter((event) => event.event === 'add').length, 0);
      const imported = (path: string) =>
        events.filter((event) => event.event === 'add' && JSON.parse(event.data).fullPath === path);
      await until(() => imported(video).length === 1);
      for (let i = 0; i < 8; i++) {
        await appendFile(join(root, '0.mp4'), 'write');
        await sleep(150);
      }
      assert.equal(imageBytesRead, 0, 'video writes must not rehash neighbouring images');
      const image = join(nested, 'image.png');
      await writeFile(image, 'image bytes');
      await until(() => imported(image).length === 1);
      assert.ok(JSON.parse(imported(image)[0].data).version);
      await writeFile(image, 'replacement image bytes');
      await until(() => imported(image).length === 2);
      await appendFile(video, 'changed version');
      await until(() => imported(video).length === 2);
      assert.equal(videoBytesRead, 0, 'changed videos must not trigger content hashing either');
      console.log(
        JSON.stringify({
          videoMiBRead: videoBytesRead / 1024 ** 2,
          imageMiBRead: imageBytesRead / 1024 ** 2,
          peakMiB: process.resourceUsage().maxRSS / 1024,
        }),
      );
    } finally {
      controller.abort();
      await reader?.cancel();
      await reading;
      fs.createReadStream = original;
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  },
);
