import { basename, extname } from 'node:path';
import { stat } from 'node:fs/promises';
import { VALID_IMAGE_EXTS } from '../../constants';

export const VIDEO_EXTENSIONS = [
  '.mp4',
  '.mov',
  '.m4v',
  '.mkv',
  '.webm',
  '.avi',
  '.mpg',
  '.mpeg',
  '.mts',
  '.m2ts',
  '.ts',
  '.wmv',
  '.flv',
  '.3gp',
  '.ogv',
];
export const isVideo = (path: string) => VIDEO_EXTENSIONS.includes(extname(path).toLowerCase());
export const isVideoOutput = (path: string) =>
  basename(path).startsWith('.picsharp-video-') ||
  /_picsharp_(av1_47|av1_35|h264_28)(_[0-9]+)?\.mp4$/i.test(basename(path));
export const isMedia = (path: string) =>
  !isVideoOutput(path) && (isVideo(path) || VALID_IMAGE_EXTS.includes(extname(path).toLowerCase()));

interface Payload {
  fullPath: string;
  isFile?: boolean;
  content_hash?: string;
  [key: string]: unknown;
}

// A video may be gigabytes long: wait for size AND modification time to stop changing.
// Repeated ADD/CHANGE events share one timer and one eventual import per file version.
export function createMediaEvents(emit: (payload: Payload) => void, stableMs = 3000, pollMs = 750) {
  const waiting = new Map<
    string,
    { payload: Payload; signature: string; since: number; timer?: ReturnType<typeof setTimeout> }
  >();
  const delivered = new Map<string, string>();
  let closed = false;
  const sample = async (path: string) => {
    const entry = waiting.get(path);
    if (!entry || closed) return;
    try {
      const metadata = await stat(path);
      if (closed || waiting.get(path) !== entry) return;
      if (!metadata.isFile()) {
        waiting.delete(path);
        return;
      }
      const signature = `${metadata.size}:${metadata.mtimeMs}`;
      if (signature !== entry.signature || metadata.size === 0) {
        entry.signature = signature;
        entry.since = Date.now();
      } else if (Date.now() - entry.since >= stableMs) {
        waiting.delete(path);
        if (delivered.get(path) !== signature) {
          delivered.set(path, signature);
          emit({ ...entry.payload, content_hash: `video:${path}:${signature}` });
        }
        return;
      }
      entry.timer = setTimeout(() => void sample(path), pollMs);
    } catch {
      waiting.delete(path);
    }
  };
  return {
    add(payload: Payload) {
      if (closed || !payload.isFile || !isMedia(payload.fullPath)) return;
      if (!isVideo(payload.fullPath)) {
        emit(payload);
        return;
      }
      const current = waiting.get(payload.fullPath);
      if (current) {
        current.payload = payload;
        return;
      }
      waiting.set(payload.fullPath, { payload, signature: '', since: Date.now() });
      void sample(payload.fullPath);
    },
    close() {
      closed = true;
      for (const entry of waiting.values()) clearTimeout(entry.timer);
      waiting.clear();
      delivered.clear();
    },
  };
}
