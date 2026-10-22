// Keep active work, plus the most recent results. Used only by the continuous watch UI.
export function trimWatchHistory<T extends { status: string }>(files: T[], limit = 500): T[] {
  const kept: T[] = [];
  let remaining = limit;
  for (let index = files.length - 1; index >= 0; index -= 1) {
    const file = files[index];
    if (file.status === 'pending' || file.status === 'processing' || remaining-- > 0) {
      kept.push(file);
    }
  }
  return kept.length === files.length ? files : kept.reverse();
}
