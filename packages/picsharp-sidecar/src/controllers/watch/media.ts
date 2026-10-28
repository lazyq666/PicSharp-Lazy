import { basename, extname } from 'node:path';
import { stat } from 'node:fs/promises';
import { VALID_IMAGE_EXTS } from '../../constants';
import { fileVersion } from '../../services/file-version';
import { imageOutputRecords, OutputRecords } from '../../services/output-records';

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
export const isTemporaryMedia = (path: string) =>
  basename(path).startsWith('.picsharp-video-') || basename(path).startsWith('.picsharp-image-');
export const isMedia = (path: string) =>
  !isTemporaryMedia(path) &&
  !isVideoOutput(path) &&
  (isVideo(path) || VALID_IMAGE_EXTS.includes(extname(path).toLowerCase()));

export interface Payload {
  fullPath: string;
  isFile?: boolean;
  version?: string;
  [key: string]: unknown;
}

// Coalesce writes using metadata. Images settle for 500 ms, videos for 3 s.
// Only changed, previously marked image outputs need a content fingerprint check.
// Output protection is checked here and again immediately before queued work runs.
export function createMediaEvents(
  emit: (payload: Payload) => void,
  stableMs = 3000,
  pollMs = 750,
  dedupeLimit = 4096,
  outputs: OutputRecords = imageOutputRecords(),
  onError: (error: Error) => void = () => {},
) {
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
      const metadata = await stat(path, { bigint: true });
      if (closed || waiting.get(path) !== entry) return;
      if (!metadata.isFile() || metadata.size === 0n) {
        // A later write will trigger a new event; don't poll an empty file forever.
        waiting.delete(path);
        return;
      }
      const signature = fileVersion(metadata);
      if (delivered.get(path) === signature) {
        waiting.delete(path);
        return;
      }
      if (signature !== entry.signature) {
        entry.signature = signature;
        entry.since = Date.now();
      } else if (Date.now() - entry.since >= (isVideo(path) ? stableMs : Math.min(stableMs, 500))) {
        const status = isVideo(path) ? 'input' : await outputs.status(path, signature);
        if (closed || waiting.get(path) !== entry) return;
        const latest = await stat(path, { bigint: true });
        if (closed || waiting.get(path) !== entry) return;
        if (fileVersion(latest) !== signature) {
          entry.signature = fileVersion(latest);
          entry.since = Date.now();
        } else if (status !== 'writing') {
          waiting.delete(path);
          delivered.delete(path);
          delivered.set(path, signature);
          while (delivered.size > dedupeLimit) delivered.delete(delivered.keys().next().value!);
          if (status === 'input') emit({ ...entry.payload, version: signature });
          return;
        }
      }
      entry.timer = setTimeout(
        () => void sample(path),
        Math.min(pollMs, isVideo(path) ? pollMs : 250),
      );
    } catch (error: any) {
      if (waiting.get(path) !== entry) return;
      waiting.delete(path);
      if (!closed && error.code !== 'ENOENT' && error.code !== 'ENOTDIR') onError(error);
    }
  };
  return {
    remove(path: string) {
      clearTimeout(waiting.get(path)?.timer);
      waiting.delete(path);
      delivered.delete(path);
    },
    add(payload: Payload) {
      if (closed || !payload.isFile || !isMedia(payload.fullPath)) return;
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
