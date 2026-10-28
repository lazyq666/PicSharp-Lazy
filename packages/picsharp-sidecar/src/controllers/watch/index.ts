import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { createMediaEvents, isMedia, isVideo } from './media';
import { watchMediaFiles } from './files';
import { readFileVersion } from '../../services/file-version';
import { imageOutputRecords } from '../../services/output-records';
import undoImage from '../undo-image';

const app = new Hono();
let id = BigInt(0);

const candidatesSchema = z.array(z.object({ path: z.string(), version: z.string() })).max(4096);
app.route('/undo-image', undoImage);
app.post('/filter-inputs', async (c) => {
  const candidates = candidatesSchema.parse(await c.req.json());
  const inputs = [];
  const issues: {path:string;message:string;code:string}[] = [];
  const outputs = imageOutputRecords();
  for (const candidate of candidates) {
    if (!isMedia(candidate.path)) continue;
    try {
      const version = await readFileVersion(candidate.path);
      if (!version) continue;
      // A sibling hard-link replacement changes ctime alone. Refresh that
      // metadata candidate, while rejecting queued versions of changed inputs.
      if (version !== candidate.version &&
          version.split(':').slice(0, 4).join(':') !== candidate.version.split(':').slice(0, 4).join(':')) continue;
      const eligible = isVideo(candidate.path) || await outputs.status(candidate.path, version) === 'input';
      if (eligible && await readFileVersion(candidate.path) === version) inputs.push({...candidate, version});
    } catch (error: any) {
      issues.push({path:candidate.path,message:error.message,code:'output_record_unreadable'});
    }
  }
  return c.json({inputs,issues});
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
      const fault = (error: Error & { code?: string; path?: string }) => {
        if (!abort)
          void send('fault', JSON.stringify({
            code: error.code || 'WATCH_ERROR',
            message: error.message,
            path: error.path || path,
            scope: error.path && error.path !== path ? 'subtree' : 'watch',
          }));
      };
      mediaEvents = createMediaEvents(
        (payload) => {
          if (!abort) void send('add', JSON.stringify(payload));
        },
        3000,
        750,
        4096,
        imageOutputRecords(),
        fault,
      );
      watcher = watchMediaFiles(
        path,
        ignores,
        mediaEvents,
        fault,
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
