import type { BigIntStats } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

// ctime catches edits that preserve size/mtime; device/inode catch replacement.
// Reading metadata never reads the contents of a large image or video.
export function fileVersion(metadata: BigIntStats): string {
  return [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(':');
}

export async function readFileVersion(path: string): Promise<string | undefined> {
  try {
    const metadata = await stat(path, { bigint: true });
    return metadata.isFile() ? fileVersion(metadata) : undefined;
  } catch (error: any) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
    throw error;
  }
}

// Only fingerprint generated images or changed, previously marked outputs. Stream
// their bytes so large images do not require a second full-size buffer in memory.
// A snapshot is valid only if the file stayed at the same version throughout.
export async function readFileFingerprint(path: string, expectedVersion?: string) {
  const version = await readFileVersion(path);
  if (!version || (expectedVersion && version !== expectedVersion)) return undefined;
  try {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if ((await readFileVersion(path)) !== version) return undefined;
    return { version, fingerprint: `sha256:${hash.digest('hex')}` };
  } catch (error: any) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
    throw error;
  }
}

export async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  const canonical = await realpath(absolute).catch(async (error) => {
    if (error.code !== 'ENOENT') throw error;
    return join(await realpath(dirname(absolute)), basename(absolute));
  });
  return canonical;
}
