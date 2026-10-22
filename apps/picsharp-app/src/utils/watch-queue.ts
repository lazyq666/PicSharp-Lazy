import { VALID_IMAGE_EXTS } from '../constants';

export interface WatchCandidate {
  path: string;
  version: string;
}

// Keep the latest version of each path. Busy paths stay queued until completion,
// without polling the backend every second or losing replacements during encoding.
export class WatchQueue {
  private pending = new Map<string, WatchCandidate>();

  add(candidate: WatchCandidate) {
    this.pending.set(candidate.path, candidate);
  }

  take(isBusy: (path: string) => boolean, limit = 256): WatchCandidate[] {
    const ready: WatchCandidate[] = [];
    for (const [path, candidate] of this.pending) {
      if (isBusy(path)) continue;
      this.pending.delete(path);
      ready.push(candidate);
      if (ready.length >= limit) break;
    }
    return ready;
  }

  hasReady(isBusy: (path: string) => boolean): boolean {
    for (const path of this.pending.keys()) if (!isBusy(path)) return true;
    return false;
  }

  hasNewer(candidate: WatchCandidate): boolean {
    const next = this.pending.get(candidate.path);
    return !!next && next.version !== candidate.version;
  }

  retry(candidates: WatchCandidate[]) {
    for (const candidate of candidates) {
      if (!this.pending.has(candidate.path)) this.pending.set(candidate.path, candidate);
    }
  }

  clear() {
    this.pending.clear();
  }
}

export async function filterWatchInputs(
  origin: string,
  candidates: WatchCandidate[],
  { signal, ignoreNinePatch = false }: { signal?: AbortSignal; ignoreNinePatch?: boolean } = {},
): Promise<WatchCandidate[]> {
  const inputs = ignoreNinePatch
    ? candidates.filter(({ path }) => {
        const filename = path.split(/[\\/]/).pop() ?? '';
        const match = /\.9\.([^.]+)$/.exec(filename);
        return !match || !VALID_IMAGE_EXTS.includes(match[1].toLowerCase());
      })
    : candidates;
  if (!inputs.length) return [];

  const response = await fetch(`${origin}/stream/watch/filter-inputs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(inputs),
    signal,
  });
  if (!response.ok) throw new Error('无法核对待压缩文件的版本。');
  return response.json();
}
