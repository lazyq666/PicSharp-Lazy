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
export const isTemporaryMedia = (path: string) =>
  path.split(/[\\/]/).some(
    (part) => part.startsWith('.picsharp-video-') || part.startsWith('.picsharp-image-'),
  );
export const isVideoOutput = (path: string) =>
  isTemporaryMedia(path) ||
  /_picsharp_(av1_47|av1_35|h264_28)(_[0-9]+)?\.mp4$/i.test(basename(path));
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
  // Replacing one of a pair of hard links changes its sibling's ctime without
  // reliably sending an event for the sibling. Retain only these linked inputs
  // for a metadata resample; ordinary files keep the event-driven fast path.
  const linkedInputs = new Set<string>();
  const reportedErrors = new Map<string, string>();
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
          if (status === 'input' && (metadata.nlink > 1n || linkedInputs.has(path))) {
            linkedInputs.add(path);
          } else linkedInputs.delete(path);
          reportedErrors.delete(path);
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
      if (closed || error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        waiting.delete(path);
        linkedInputs.delete(path);
      } else {
        if (reportedErrors.get(path) !== error.message) {
          reportedErrors.set(path, error.message);
          onError(
            Object.assign(new Error(error.message), {
              path,
              code: error.code || 'output_record_unreadable',
            }),
          );
        }
        entry.timer = setTimeout(() => void sample(path), 1000);
      }
    }
  };
  let checkingLinks = false;
  const linkedTimer = setInterval(async () => {
    if (closed || checkingLinks) return;
    checkingLinks = true;
    try {
      for (const path of linkedInputs) {
        if (closed) break;
        if (!delivered.has(path)) {
          linkedInputs.delete(path);
          continue;
        }
        try {
          const metadata = await stat(path, { bigint: true });
          if (fileVersion(metadata) !== delivered.get(path) && !waiting.has(path)) {
            waiting.set(path, {
              payload: { fullPath: path, isFile: true },
              signature: '',
              since: Date.now(),
            });
            void sample(path);
          }
        } catch (error: any) {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR') linkedInputs.delete(path);
          else if (!closed)
            onError(
              Object.assign(new Error(error.message), { path, code: error.code || 'WATCH_ERROR' }),
            );
        }
      }
    } finally {
      checkingLinks = false;
    }
  }, 750);
  linkedTimer.unref();
  return {
    async prime(path: string) {
      if (isVideo(path)) return;
      try {
        await outputs.status(path);
      } catch (error: any) {
        onError(
          Object.assign(new Error(error.message), {
            path,
            code: error.code || 'output_record_unreadable',
          }),
        );
      }
    },
    remove(path: string) {
      clearTimeout(waiting.get(path)?.timer);
      waiting.delete(path);
      delivered.delete(path);
      linkedInputs.delete(path);
      reportedErrors.delete(path);
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
      clearInterval(linkedTimer);
      for (const entry of waiting.values()) clearTimeout(entry.timer);
      waiting.clear();
      delivered.clear();
      linkedInputs.clear();
      reportedErrors.clear();
    },
  };
}
