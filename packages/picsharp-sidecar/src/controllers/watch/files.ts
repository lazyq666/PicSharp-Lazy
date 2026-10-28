import { realpathSync, watch } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileVersion } from '../../services/file-version';
import { createMediaEvents, isMedia, isTemporaryMedia, isVideoOutput } from './media';
import { createIgnoreMatcher } from './ignores';

// One metadata snapshot per watched file, rather than dirspy's content hashes/tree.
// A normal file event examines only that path. Directory events reconcile snapshots,
// so moved-in folders work without re-importing their unchanged neighbours.
export function watchMediaFiles(
  folder: string,
  ignores: string[],
  events: ReturnType<typeof createMediaEvents>,
  onError: (error: Error) => void,
  onMissing: () => void = () => {},
) {
  const root = realpathSync(resolve(folder));
  const versions = new Map<string, string>();
  const pending = new Set<string>();
  let closed = false;
  let draining = false;
  let initializing = true;
  let rootIdentity: string | undefined;
  const matchesIgnore = createIgnoreMatcher(root, ignores);
  const ignored = (path: string) =>
    matchesIgnore(path) ||
    isTemporaryMedia(path) ||
    isVideoOutput(path);

  function forget(path: string) {
    events.remove(path);
    for (const key of versions.keys()) {
      if (key === path || key.startsWith(path + sep)) {
        versions.delete(key);
        events.remove(key);
      }
    }
  }

  async function sample(path: string, baseline = false): Promise<void> {
    if (closed || (path !== root && ignored(path))) return;
    try {
      const metadata = await lstat(path, { bigint: true });
      if (closed) return;
      if (metadata.isDirectory()) {
        const identity = `${metadata.dev}:${metadata.ino}:${metadata.birthtimeNs}`;
        if (path === root) {
          if (rootIdentity && rootIdentity !== identity) return missing();
          rootIdentity = identity;
        }
        const seen = new Set<string>();
        const directory = await opendir(path);
        for await (const entry of directory) {
          if (closed) break;
          const child = join(path, entry.name);
          seen.add(child);
          if (entry.isDirectory() || (entry.isFile() && isMedia(child))) {
            await sample(child, baseline);
          }
        }
        if (!closed && !baseline) {
          for (const key of versions.keys()) {
            if (key.startsWith(path + sep)) {
              const first = join(path, relative(path, key).split(sep)[0]);
              if (!seen.has(first)) forget(first);
            }
          }
        }
      } else if (metadata.isFile() && isMedia(path)) {
        if (baseline) await events.prime(path);
        const version = fileVersion(metadata);
        const previous = versions.get(path);
        versions.set(path, version);
        if (!baseline && previous !== version) events.add({ fullPath: path, isFile: true });
      } else {
        forget(path);
        if (path === root) missing();
      }
    } catch (error: any) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        forget(path);
        if (path === root) missing();
      } else if (!closed) onError(error);
    }
  }

  async function drain() {
    if (draining || closed || initializing) return;
    draining = true;
    try {
      while (!closed && pending.size) {
        const path = pending.values().next().value!;
        pending.delete(path);
        await sample(path);
      }
    } finally {
      draining = false;
    }
  }

  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    if (closed) return;
    const path = filename ? resolve(root, filename.toString()) : root;
    const child = relative(root, path);
    if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) return;
    if (path !== root && ignored(path)) return;
    pending.add(path);
    void drain();
  });
  watcher.on('error', (error) => {
    if (!closed) onError(error);
  });

  // fs.watch does not consistently report deletion/replacement of the watched root.
  let checkingRoot = false;
  const guard = setInterval(async () => {
    if (closed || checkingRoot) return;
    checkingRoot = true;
    try {
      const metadata = await lstat(root, { bigint: true });
      const identity = `${metadata.dev}:${metadata.ino}:${metadata.birthtimeNs}`;
      if (!metadata.isDirectory() || (rootIdentity && identity !== rootIdentity)) missing();
    } catch (error: any) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') missing();
      else if (!closed) onError(error);
    } finally {
      checkingRoot = false;
    }
  }, 1000);
  function close() {
    closed = true;
    clearInterval(guard);
    pending.clear();
    versions.clear();
    watcher.close();
  }
  function missing() {
    if (closed) return;
    close();
    onMissing();
  }
  const ready = sample(root, true).then(async () => {
    initializing = false;
    await drain();
  });
  return { ready, close };
}
