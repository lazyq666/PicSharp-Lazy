import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { canonicalPath, readFileVersion } from './file-version';

export interface FileCandidate {
  path: string;
  version: string;
}

export class WatchInputChanged extends Error {
  constructor() {
    super('文件已变化，等待重新导入。');
  }
}

interface OutputRecord extends FileCandidate {}
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
    return stored.version === current ? 'output' : 'input';
  }

  async isInput(candidate: FileCandidate): Promise<boolean> {
    const current = await readFileVersion(candidate.path);
    return (
      current === candidate.version && (await this.status(candidate.path, current)) === 'input'
    );
  }

  async remember(path: string): Promise<void> {
    const key = pathKey(await canonicalPath(path));
    const version = await readFileVersion(key);
    if (!version) throw new Error(`无法登记压缩成品：${path}`);
    await mkdir(this.directory, { recursive: true });
    const target = this.recordPath(key);
    const temporary = target + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify({ path: key, version } satisfies OutputRecord));
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
      if (expectedVersion && (await readFileVersion(key)) !== expectedVersion) {
        throw new WatchInputChanged();
      }
      await rename(temporary, key);
      await this.remember(key);
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
