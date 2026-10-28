import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { canonicalPath, readFileFingerprint, readFileVersion } from './file-version';

export interface FileCandidate {
  path: string;
  version: string;
}

export class WatchInputChanged extends Error {
  constructor() {
    super('文件已变化，等待重新导入。');
  }
}

interface OutputRecord extends FileCandidate {
  // Older records have no fingerprint and can only identify their exact version.
  fingerprint?: string;
}
interface PendingRecord {
  path: string;
  pid: number;
  started: number;
}

const pathKey = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);

// Disk records are shared by the server, worker threads and cluster processes.
// They are separate from temporary images and survive restarts/history eviction.
export class OutputRecords {
  constructor(readonly directory: string) {}

  private recordPath(path: string) {
    return join(this.directory, createHash('sha256').update(pathKey(path)).digest('hex') + '.json');
  }

  private async read<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch (error: any) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async status(path: string, version?: string): Promise<'input' | 'output' | 'writing'> {
    const key = pathKey(await canonicalPath(path));
    const target = this.recordPath(key);
    const pending = await this.read<PendingRecord>(target + '.pending');
    if (pending?.path === key && Date.now() - pending.started < 60_000) {
      try {
        process.kill(pending.pid, 0);
        return 'writing';
      } catch (error: any) {
        if (error.code !== 'ESRCH') return 'writing';
      }
    }
    const stored = await this.read<OutputRecord>(target);
    if (!stored || stored.path !== key) return 'input';
    const current = version ?? (await readFileVersion(key));
    if (stored.version === current) return 'output';
    if (!current || !stored.fingerprint) return 'input';
    // ctime also changes for permissions/preview attributes, not just image edits.
    // Keep the original record: an attribute update must not bless new bytes, and
    // a delayed check must not overwrite a newer compression's record.
    const snapshot = await readFileFingerprint(key, current);
    if (!snapshot) return 'writing';
    return snapshot.fingerprint === stored.fingerprint ? 'output' : 'input';
  }

  async isInput(candidate: FileCandidate): Promise<boolean> {
    const current = await readFileVersion(candidate.path);
    return (
      current === candidate.version &&
      (await this.status(candidate.path, current)) === 'input' &&
      (await readFileVersion(candidate.path)) === candidate.version
    );
  }

  async remember(
    path: string,
    expected?: { version?: string; fingerprint?: string },
  ): Promise<void> {
    const key = pathKey(await canonicalPath(path));
    const snapshot = await readFileFingerprint(key, expected?.version);
    if (!snapshot || (expected?.fingerprint && snapshot.fingerprint !== expected.fingerprint)) {
      throw new WatchInputChanged();
    }
    await mkdir(this.directory, { recursive: true });
    const target = this.recordPath(key);
    const temporary = target + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify({ path: key, ...snapshot } satisfies OutputRecord));
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  // Render to an ignored sibling, then protect the destination BEFORE publishing it.
  // The pending marker bridges the interval between rename and the final version record.
  async publish<T>(
    path: string,
    render: (temporary: string) => Promise<T>,
    expectedVersion?: string,
  ): Promise<T> {
    const key = await canonicalPath(path);
    const temporary = join(dirname(key), `.picsharp-image-${randomUUID()}${extname(key)}`);
    try {
      const result = await render(temporary);
      await this.commit(key, temporary, expectedVersion);
      return result;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async commit(path: string, temporary: string, expectedVersion?: string): Promise<void> {
    const key = await canonicalPath(path);
    const pending = this.recordPath(key) + '.pending';
    let reserved = false;
    try {
      await mkdir(this.directory, { recursive: true });
      // Writers targeting the same output must not overwrite one another's protection.
      await writeFile(
        pending,
        JSON.stringify({
          path: pathKey(key),
          pid: process.pid,
          started: Date.now(),
        } satisfies PendingRecord),
        { flag: 'wx' },
      );
      reserved = true;
      // Capture the actual compressor output before exposing it at the user's path.
      // If an export replaces it during registration, never mark that export as ours.
      const rendered = await readFileFingerprint(temporary);
      if (!rendered) throw new WatchInputChanged();
      if (expectedVersion && (await readFileVersion(key)) !== expectedVersion) {
        throw new WatchInputChanged();
      }
      await rename(temporary, key);
      await this.remember(key, { fingerprint: rendered.fingerprint });
    } finally {
      if (reserved) await rm(pending, { force: true });
    }
  }
}

export function imageOutputRecords() {
  return new OutputRecords(
    process.env.PICSHARP_IMAGE_OUTPUTS_DIR || join(homedir(), '.picsharp', 'image-outputs'),
  );
}

export async function assertWatchInput(path: string, version?: string) {
  if (version && !(await imageOutputRecords().isInput({ path, version }))) {
    throw new WatchInputChanged();
  }
}

export function isWatchInputChanged(error: unknown): boolean {
  return (
    error instanceof WatchInputChanged ||
    (error instanceof Error && !!error.cause && isWatchInputChanged(error.cause))
  );
}
