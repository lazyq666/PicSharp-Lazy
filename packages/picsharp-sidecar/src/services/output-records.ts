import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile, stat, link } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { canonicalPath, readFileFingerprint, readFileVersion } from './file-version';
import { DirectoryAnchor, AnchoredSnapshot } from './directory-anchor';

export interface FileCandidate {
  path: string;
  version: string;
}
export class WatchInputChanged extends Error {
  constructor(readonly recoveryPath?: string) {
    super(
      recoveryPath ? `文件已变化，保留的文件位于 ${recoveryPath}` : '文件已变化，等待重新导入。',
    );
  }
}
interface OutputRecord extends FileCandidate {
  fingerprint?: string;
  identity?: string;
}
interface PendingRecord {
  path: string;
  pid: number;
  started: number;
}
const pathKey = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const stableIdentity = (metadata: Awaited<ReturnType<typeof stat>>) =>
  `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}`;
// Renaming a file updates ctime. Its device/inode, length, mtime and bytes must
// still agree after taking ownership; merely checking its old pathname cannot do this.
const sameObject = (a: string, b: string) =>
  a.split(':').slice(0, 4).join(':') === b.split(':').slice(0, 4).join(':');

export class OutputRecords {
  constructor(readonly directory: string) {}
  private recordPath(path: string) {
    return join(this.directory, hash(pathKey(path)) + '.json');
  }
  private identityPath(identity: string) {
    return join(this.directory, 'identities', hash(identity) + '.json');
  }
  private async read<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch (error: any) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  }
  private async store(path: string, value: unknown) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(value));
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  private async workspace(path: string) {
    // Do not make legal paths longer, or leave encoder work behind when a source
    // directory is moved. Prefer the OS temporary directory on the same volume.
    const device = (await stat(dirname(path))).dev;
    let base = tmpdir();
    if ((await stat(base)).dev !== device) {
      base = dirname(path);
      const ancestors = [base];
      while (dirname(base) !== base && (await stat(dirname(base))).dev === device) {
        base = dirname(base);
        ancestors.push(base);
      }
      // A mounted volume's root may be read-only to this user. Try writable
      // same-volume ancestors instead of assuming that the root accepts files.
      for (const ancestor of ancestors.reverse()) {
        try {
          return await mkdtemp(join(ancestor, '.picsharp-image-'));
        } catch (error: any) {
          if (!['EACCES', 'EPERM', 'EROFS', 'ENAMETOOLONG'].includes(error.code)) throw error;
        }
      }
      throw new Error(`无法创建图片工作文件：${dirname(path)}`);
    }
    return mkdtemp(join(base, '.picsharp-image-'));
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
    const current = version ?? (await readFileVersion(key));
    if (!current) return 'input';
    let stored = await this.read<OutputRecord>(target);
    if (stored && stored.path !== key) throw new Error(`无法读取图片处理记录：${key}`);
    if (stored?.version === current && stored.path === key) {
      if (!stored.identity) await this.remember(key, { version: current });
      return 'output';
    }
    // A moved output can land at a pathname with a record for a different old
    // output. That stale pathname entry must not hide this object's identity.
    const identity = stableIdentity(await stat(key));
    const identityPending = await this.read<PendingRecord>(
      this.identityPath(identity) + '.pending',
    );
    if (identityPending && Date.now() - identityPending.started < 60_000) {
      try {
        process.kill(identityPending.pid, 0);
        return 'writing';
      } catch (error: any) {
        if (error.code !== 'ESRCH') return 'writing';
      }
    }
    const moved = await this.read<OutputRecord>(this.identityPath(identity));
    if (moved?.identity === identity) stored = moved;
    if (!stored?.fingerprint) return 'input';
    const snapshot = await readFileFingerprint(key, current);
    if (!snapshot) return 'writing';
    if (snapshot.fingerprint !== stored.fingerprint) return 'input';
    if (!stored.identity)
      await this.remember(key, { version: current, fingerprint: stored.fingerprint });
    return 'output';
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
    expected?: { version?: string; fingerprint?: string; snapshot?: AnchoredSnapshot },
  ): Promise<string> {
    const key = pathKey(await canonicalPath(path));
    const snapshot = expected?.snapshot ?? (await readFileFingerprint(key, expected?.version));
    if (!snapshot || (expected?.fingerprint && snapshot.fingerprint !== expected.fingerprint))
      throw new WatchInputChanged();
    const identity = expected?.snapshot?.identity ?? stableIdentity(await stat(key));
    if ((await readFileVersion(key)) !== snapshot.version) throw new WatchInputChanged();
    const record: OutputRecord = { ...snapshot, path: key, identity };
    await this.store(this.recordPath(key), record);
    await this.store(this.identityPath(identity), record);
    return snapshot.version;
  }
  // Move the actual object out of its pathname before validating/removing it.
  // Restoring uses an atomic no-replace link: a later export always wins its path.
  async claim(path: string, expectedVersion: string) {
    const key = await canonicalPath(path);
    const before = await readFileFingerprint(key, expectedVersion);
    if (!before) throw new WatchInputChanged();
    const work = await this.workspace(key);
    const held = join(work, 'original' + extname(key));
    let anchor: DirectoryAnchor;
    try {
      anchor = await DirectoryAnchor.open(key, held);
    } catch (error) {
      await rm(work, { recursive: true, force: true });
      throw error;
    }
    let owned = false;
    let recoveryRequired = false;
    const restore = async () => {
      if (recoveryRequired) throw new WatchInputChanged(held);
      if (!owned) {
        await anchor.close();
        return;
      }
      try {
        await anchor.restore();
      } catch (error: any) {
        recoveryRequired = true;
        await anchor.close();
        throw new WatchInputChanged(held);
      }
      owned = false;
      await anchor.close();
      await rm(work, { recursive: true, force: true });
    };
    try {
      await anchor.claim();
      owned = true;
      const after = await readFileFingerprint(held);
      if (
        !after ||
        !sameObject(before.version, after.version) ||
        before.fingerprint !== after.fingerprint
      ) {
        await restore();
        throw new WatchInputChanged();
      }
      return {
        path: held,
        anchor,
        restore,
        publish: async <T>(render: (temporary: string) => Promise<T>) => {
          const temporary = join(work, 'restored-' + randomUUID() + extname(key));
          try {
            const result = await render(temporary);
            const outputVersion = await this.publishAnchored(anchor, temporary);
            return { result, outputVersion };
          } finally {
            await rm(temporary, { force: true });
          }
        },
        discard: async () => {
          if (!owned) return;
          const latest = await readFileFingerprint(held);
          if (!latest || latest.fingerprint !== before.fingerprint) {
            await restore();
            throw new WatchInputChanged();
          }
          await rm(held);
          owned = false;
          await anchor.close();
          await rm(work, { recursive: true, force: true });
        },
      };
    } catch (error: any) {
      if (owned) await restore();
      else {
        await anchor.close();
        await rm(work, { recursive: true, force: true });
      }
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new WatchInputChanged();
      throw error;
    }
  }
  private async publishAnchored(anchor: DirectoryAnchor, temporary: string): Promise<string> {
    const rendered = await readFileFingerprint(temporary);
    if (!rendered) throw new WatchInputChanged();
    const identity = stableIdentity(await stat(temporary));
    const pending = this.identityPath(identity) + '.pending';
    await mkdir(dirname(pending), { recursive: true });
    await writeFile(
      pending,
      JSON.stringify({
        path: identity,
        pid: process.pid,
        started: Date.now(),
      } satisfies PendingRecord),
      { flag: 'wx' },
    );
    try {
      let published: AnchoredSnapshot;
      try {
        published = await anchor.publish(temporary);
      } catch (error: any) {
        if (error.code === 'EEXIST' || error.code === 'ESTALE') throw new WatchInputChanged();
        throw error;
      }
      return await this.remember(published.path, {
        fingerprint: rendered.fingerprint,
        snapshot: published,
      });
    } finally {
      await rm(pending, { force: true });
    }
  }
  async publish<T>(
    path: string,
    render: (temporary: string) => Promise<T>,
    expectedVersion?: string,
  ): Promise<T> {
    return (await this.publishTracked(path, render, expectedVersion)).result;
  }
  async publishTracked<T>(
    path: string,
    render: (temporary: string) => Promise<T>,
    expectedVersion?: string,
  ): Promise<{ result: T; outputVersion: string }> {
    const key = await canonicalPath(path);
    const work = await this.workspace(key);
    const temporary = join(work, 'output' + extname(key));
    try {
      const result = await render(temporary);
      const outputVersion = await this.commit(key, temporary, expectedVersion);
      return { result, outputVersion };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
  async commit(path: string, temporary: string, expectedVersion?: string): Promise<string> {
    const key = await canonicalPath(path);
    const pending = this.recordPath(key) + '.pending';
    let reserved = false;
    let claimed: Awaited<ReturnType<OutputRecords['claim']>> | undefined;
    try {
      await mkdir(this.directory, { recursive: true });
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
      const rendered = await readFileFingerprint(temporary);
      if (!rendered) throw new WatchInputChanged();
      const current = await readFileVersion(key);
      if (expectedVersion !== undefined && current !== (expectedVersion || undefined))
        throw new WatchInputChanged();
      if (current) claimed = await this.claim(key, current);
      // Every publication targets the anchored directory by basename. Replacing
      // the old absolute parent pathname cannot redirect this write elsewhere.
      const unclaimedAnchor = claimed
        ? undefined
        : await DirectoryAnchor.open(key, join(dirname(temporary), 'absent-original'));
      let outputVersion: string;
      try {
        outputVersion = await this.publishAnchored(claimed?.anchor ?? unclaimedAnchor!, temporary);
      } finally {
        await unclaimedAnchor?.close();
      }
      await claimed?.discard();
      claimed = undefined;
      return outputVersion;
    } catch (error) {
      if (claimed) {
        try {
          await claimed.restore();
        } catch (restoreError) {
          if (!(restoreError instanceof WatchInputChanged)) throw restoreError;
          // A new object already occupies the destination. Retire only the
          // unchanged object this task owned; discard retains it if an external
          // open descriptor has meanwhile written new bytes into that object.
          await claimed.discard();
        }
      }
      throw error;
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
  if (version && !(await imageOutputRecords().isInput({ path, version })))
    throw new WatchInputChanged();
}
export async function watchVersionForOutput(input: string, output: string, version?: string) {
  return version && (await canonicalPath(input)) === (await canonicalPath(output))
    ? version
    : undefined;
}
export function isWatchInputChanged(error: unknown): boolean {
  return (
    (error instanceof WatchInputChanged && !error.recoveryPath) ||
    (error instanceof Error && !!error.cause && isWatchInputChanged(error.cause))
  );
}
