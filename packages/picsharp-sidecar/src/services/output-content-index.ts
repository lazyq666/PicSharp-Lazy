import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface ContentRecord {
  version: string;
  fingerprint?: string;
  copyEligible?: boolean;
}
const digestOf = (record: ContentRecord) =>
  record.copyEligible !== false && /^sha256:[a-f0-9]{64}$/.test(record.fingerprint ?? '')
    ? record.fingerprint!.slice(7)
    : undefined;
const sizeOf = (version: string) => {
  const size = version.split(':')[2];
  return /^[1-9][0-9]*$/.test(size ?? '') ? size : undefined;
};

// One shared limit in this runtime, including multiple watched folders.
// Waiting candidates hold paths/versions, never decoded images or file buffers.
let active = 0;
const waiting: (() => void)[] = [];
export async function withCopyCheck<T>(check: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  else active++;
  try {
    return await check();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

// Durable size/digest index; workers publish entries visible to a live watcher.
// Directory metadata invalidates the small memory cache without polling or
// repeatedly scanning all output records. Entries describe completed content,
// so moving/deleting the original does not invalidate an identical copy.
export class OutputContentIndex {
  private readonly root: string;
  private ready?: Promise<void>;
  private readonly cache = new Map<string, { version: string; digests: Set<string> }>();
  constructor(private readonly recordsDirectory: string) {
    this.root = join(recordsDirectory, 'content-v1');
  }
  async add(record: ContentRecord) {
    const size = sizeOf(record.version),
      digest = digestOf(record);
    if (!size || !digest) return;
    const directory = join(this.root, size);
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(join(directory, digest), '', { flag: 'wx' });
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  private async migrate() {
    const marker = join(this.root, '.migrated');
    try {
      await stat(marker);
      return;
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
    await mkdir(this.root, { recursive: true });
    const files = (await readdir(this.recordsDirectory)).filter((name) =>
      /^[a-f0-9]{64}\.json$/.test(name),
    );
    for (let i = 0; i < files.length; i += 16) {
      await Promise.all(
        files.slice(i, i + 16).map(async (name) => {
          let record: ContentRecord;
          try {
            record = JSON.parse(await readFile(join(this.recordsDirectory, name), 'utf8'));
          } catch (error: any) {
            // An unrelated broken legacy record must not block healthy candidates.
            // Its own path/identity check still reports the original error.
            if (error instanceof SyntaxError || ['ENOENT', 'EACCES', 'EPERM'].includes(error.code))
              return;
            throw error;
          }
          if (record && typeof record.version === 'string') await this.add(record);
        }),
      );
    }
    await writeFile(marker, '1');
  }
  private async initialize() {
    this.ready ??= this.migrate().catch((error) => {
      this.ready = undefined;
      throw error;
    });
    await this.ready;
  }
  async hasSize(version: string): Promise<boolean> {
    await this.initialize();
    const size = sizeOf(version);
    if (!size) return false;
    try {
      return (await stat(join(this.root, size))).isDirectory();
    } catch (error: any) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  async matches(record: ContentRecord): Promise<boolean> {
    const size = sizeOf(record.version),
      digest = digestOf(record);
    if (!size || !digest) return false;
    const directory = join(this.root, size);
    const metadata = await stat(directory, { bigint: true });
    const version = `${metadata.ino}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
    let cached = this.cache.get(size);
    if (cached?.version !== version) {
      cached = { version, digests: new Set(await readdir(directory)) };
      this.cache.delete(size);
      this.cache.set(size, cached);
      if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
    }
    return cached!.digests.has(digest);
  }
}
