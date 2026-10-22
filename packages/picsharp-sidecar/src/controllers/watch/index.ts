import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { createMediaEvents, isMedia, isVideo } from './media';
import { watchMediaFiles } from './files';
import { readFileVersion } from '../../services/file-version';
import { imageOutputRecords } from '../../services/output-records';

const app = new Hono();
let id = BigInt(0);

const candidatesSchema = z.array(z.object({ path: z.string(), version: z.string() })).max(4096);
app.post('/filter-inputs', async (c) => {
  const candidates = candidatesSchema.parse(await c.req.json());
  const inputs = [];
  const outputs = imageOutputRecords();
  for (const candidate of candidates) {
    if (!isMedia(candidate.path)) continue;
    const eligible = isVideo(candidate.path)
      ? (await readFileVersion(candidate.path)) === candidate.version
      : await outputs.isInput(candidate);
    if (eligible) inputs.push(candidate);
  }
  return c.json(inputs);
});

app.post('/new-images', (c) => {
  return streamSSE(c, async (stream) => {
    let abort = false;
    let watcher: ReturnType<typeof watchMediaFiles> | undefined;
    let mediaEvents: ReturnType<typeof createMediaEvents> | undefined;
    const cleanup = () => {
      abort = true;
      mediaEvents?.close();
      watcher?.close();
    };
    const send = (event: string, data = '') =>
      stream.writeSSE({ data, event, id: (++id).toString() }).catch(cleanup);
    stream.onAbort(cleanup);
    try {
      const { path, ignores = [] } = await c.req.json<{ path: string; ignores: string[] }>();
      mediaEvents = createMediaEvents(
        (payload) => {
          if (!abort) void send('add', JSON.stringify(payload));
        },
        3000,
        750,
        4096,
        imageOutputRecords(),
        (error) => {
          if (!abort) void send('fault', error.message);
        },
      );
      watcher = watchMediaFiles(
        path,
        ignores,
        mediaEvents,
        (error) => {
          if (!abort) void send('fault', error.message);
        },
        () => {
          void send('self-enoent');
          cleanup();
        },
      );
      await watcher.ready;
      if (abort) return;
      await send('ready');
      while (!abort) {
        await stream.sleep(1000 * 10);
        if (!abort) await send('ping');
      }
    } catch (error: any) {
      if (!abort) await send('abort', error.toString());
      stream.close();
    } finally {
      cleanup();
    }
  });
});

export default app;
