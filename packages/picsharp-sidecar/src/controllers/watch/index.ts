import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createMediaEvents, isMedia, isVideoOutput } from './media';
import { jsonBigInt } from '../../utils';
import { watch, Event } from 'dirspy';

const app = new Hono();
let id = BigInt(0);

app.post('/new-images', (c) => {
  return streamSSE(c, async (stream) => {
    try {
      const { path, ignores = [] } = await c.req.json<{ path: string; ignores: string[] }>();
      let ready = false;
      let abort = false;
      const mediaEvents = createMediaEvents((payload) => {
        if (!abort)
          void stream
            .writeSSE({
              data: JSON.stringify(payload, jsonBigInt),
              event: 'add',
              id: (++id).toString(),
            })
            .catch(() => {
              mediaEvents.close();
            });
      });
      const watcher = await watch(path, {
        ignore(path) {
          // Do not filter directories by extension: newly created subfolders must be watched.
          return ignores.some((ignore) => path.includes(ignore)) || isVideoOutput(path);
        },
        fileFilter: (entry) => {
          if (ignores.some((ignore) => entry.fullPath.includes(ignore))) return false;
          return isMedia(entry.path);
        },
        directoryFilter: (entry) => {
          return !ignores.includes(entry.basename);
        },
      });
      stream.onAbort(() => {
        console.log(`Watch <${path}> aborted`);
        mediaEvents.close();
        watcher.close();
        stream.close();
        abort = true;
      });
      while (true) {
        if (abort) break;
        if (!ready) {
          ready = true;
          watcher.on(Event.READY, () => {
            stream.writeSSE({
              data: '',
              event: 'ready',
              id: (++id).toString(),
            });
            watcher
              .on(Event.ADD, (payload) => mediaEvents.add({ ...payload }))
              .on(Event.CHANGE, (_oldPayload, newPayload) => mediaEvents.add({ ...newPayload }))
              .on(Event.SELF_ENOENT, () => {
                mediaEvents.close();
                stream.writeSSE({
                  data: '',
                  event: 'self-enoent',
                  id: (++id).toString(),
                });
              })
              .on(Event.ERROR, (error) => {
                stream.writeSSE({
                  data: error.toString(),
                  event: 'fault',
                  id: (++id).toString(),
                });
              });
          });
        }
        await stream.sleep(1000 * 10);
        await stream.writeSSE({
          data: '',
          event: 'ping',
          id: (++id).toString(),
        });
      }
    } catch (error: any) {
      await stream.writeSSE({
        data: error.toString(),
        event: 'abort',
        id: (++id).toString(),
      });
      stream.close();
    }
  });
});

export default app;
