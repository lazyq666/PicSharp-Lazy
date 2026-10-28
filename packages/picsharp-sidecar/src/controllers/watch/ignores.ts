import { relative } from 'node:path';

// picomatch has no bundled declarations. Keep its small used surface typed here.
const picomatch: (pattern: string, options: Record<string, boolean>) => (path: string) => boolean =
  require('picomatch');

export function createIgnoreMatcher(root: string, ignores: string[]) {
  const normalize = (path: string) => path.replace(/\\/g, '/');
  const rules = ignores.filter((rule) => typeof rule === 'string' && rule.trim()).map((rule) => {
    const pattern = normalize(rule.trim());
    if (!/[*?\[\]{}()!]/.test(pattern)) {
      // Preserve existing literal-path rules while adding the promised glob syntax.
      return (path: string) => normalize(path).includes(pattern);
    }
    const match = picomatch(pattern, { dot: true, basename: !pattern.includes('/'), nonegate: true });
    return (path: string) => match(normalize(relative(root, path))) || match(normalize(path));
  });
  return (path: string) => rules.some((match) => match(path));
}
