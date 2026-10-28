import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '../..');
const report = join(repo, 'doc/classic-drop-testing');
const baseline = process.argv[2] || 'e0ff7a8';
const scratch = await mkdtemp(join(tmpdir(), 'picsharp-classic-ablation-'));
const testFile = join(app, 'tests/classic-drop.test.mjs');
const hash = (value) => createHash('sha256').update(value).digest('hex');

function replaceOnce(source, before, after) {
  assert.equal(
    source.split(before).length - 1,
    1,
    `Ablation anchor must match exactly once: ${before}`,
  );
  return source.replace(before, after);
}

const variants = [
  { name: 'baseline', pattern: 'guide-to-workspace', revision: baseline, expectedPass: false },
  {
    name: 'replace-instead-of-append',
    pattern: 'guide-to-workspace',
    file: 'pages/compression/classic-layout.tsx',
    changes: [['state.appendFiles(files);', 'state.setFiles(files);']],
  },
  {
    name: 'remove-store-deduplication',
    pattern: 'classic append:',
    file: 'store/compression.ts',
    changes: [
      ['if (fileMap.has(file.path)) return false;', '// Ablation: accept duplicate paths.'],
    ],
  },
  {
    name: 'remove-video-exclusion',
    pattern: 'duplicates preserve an active video',
    file: 'utils/fs.ts',
    changes: [
      [
        'const candidates = parsed?.filter((item) => !excludedPaths?.has(item.path));',
        'const candidates = parsed;',
      ],
    ],
  },
  {
    name: 'remove-stale-video-registration-guard',
    pattern: 'classic video: a delayed parse',
    file: 'utils/fs.ts',
    changes: [
      ['if (!isCurrent()) return [];', '// Ablation: register video jobs after a stale parse.'],
    ],
  },
  {
    name: 'remove-import-serialization',
    pattern: 'rapid imports keep drop order',
    file: 'pages/compression/classic-layout.tsx',
    changes: [
      ['const importing = queue.current.then(async () => {', 'const importing = (async () => {'],
      ['});\n      queue.current = importing;', '})();\n      queue.current = importing;'],
    ],
  },
  {
    name: 'remove-batch-revision-check',
    pattern: 'resetting the batch invalidates imports',
    file: 'pages/compression/classic-layout.tsx',
    changes: [
      [
        'session === lifetime.current &&\n        revision === useCompressionStore.getState().batchRevision;',
        'session === lifetime.current;',
      ],
    ],
  },
  {
    name: 'remove-late-subscription-cleanup',
    pattern: 'subscription that resolves after unmount',
    file: 'pages/compression/classic-layout.tsx',
    changes: [['if (disposed) stop();\n        else unlisten = stop;', 'unlisten = stop;']],
  },
  {
    name: 'remove-inactive-import-guard',
    pattern: 'captured dialog callback cannot import after leaving',
    file: 'pages/compression/classic-layout.tsx',
    changes: [
      ['!active.current ||\n        ', ''],
      ['active.current &&\n        ', ''],
    ],
  },
  {
    name: 'remove-captured-batch-identity',
    pattern: 'captured dialog callback cannot import into a reset batch',
    file: 'pages/compression/classic-layout.tsx',
    changes: [
      [' ||\n        batchRevision !== useCompressionStore.getState().batchRevision', ''],
      [
        'const revision = batchRevision;',
        'const revision = useCompressionStore.getState().batchRevision;',
      ],
    ],
  },
  { name: 'full-fix', expectedPass: true },
];

async function copySources(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory()) await copySources(join(from, entry.name), join(to, entry.name));
    else if (entry.isFile()) await copyFile(join(from, entry.name), join(to, entry.name));
  }
}

await mkdir(report, { recursive: true });
const results = [];
try {
  for (const variant of variants) {
    const environment = { ...process.env };
    delete environment.CLASSIC_DROP_SOURCE_ROOT;
    delete environment.CLASSIC_DROP_REVISION;
    let mutation;
    if (variant.revision) environment.CLASSIC_DROP_REVISION = variant.revision;
    else if (variant.file) {
      const snapshot = join(scratch, variant.name);
      await copySources(join(app, 'src'), snapshot);
      const target = join(snapshot, variant.file);
      const original = await readFile(target, 'utf8');
      let modified = original;
      for (const [before, after] of variant.changes)
        modified = replaceOnce(modified, before, after);
      assert.notEqual(modified, original);
      await writeFile(target, modified);
      mutation = { file: variant.file, beforeSha256: hash(original), afterSha256: hash(modified) };
      const diff = spawnSync(
        'diff',
        [
          '-u',
          '--label',
          `full/${variant.file}`,
          '--label',
          `${variant.name}/${variant.file}`,
          join(app, 'src', variant.file),
          target,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(diff.status, 1, 'a real source change must exist before running the ablation');
      await writeFile(join(report, variant.name + '.patch'), diff.stdout);
      environment.CLASSIC_DROP_SOURCE_ROOT = snapshot;
    }
    const command = ['--test', '--test-reporter=tap'];
    if (variant.pattern) command.push('--test-name-pattern=' + variant.pattern);
    command.push(testFile);
    const run = spawnSync(process.execPath, command, {
      cwd: repo,
      encoding: 'utf8',
      env: environment,
      timeout: 30000,
    });
    const output = run.stdout + run.stderr;
    await writeFile(join(report, variant.name + '.log'), output);
    const count = (key) => Number(output.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0);
    const verdict = {
      variant: variant.name,
      exitCode: run.status,
      tests: count('tests'),
      passed: count('pass'),
      failed: count('fail'),
      expectedPass: variant.expectedPass === true,
      mutation,
    };
    assert.ok(verdict.tests > 0, `${variant.name}: tests must execute`);
    if (variant.expectedPass) assert.equal(run.status, 0, `${variant.name}: full fix must pass`);
    else {
      assert.equal(run.status, 1, `${variant.name}: removal must be detected`);
      assert.ok(verdict.failed > 0, `${variant.name}: at least one test must fail`);
      assert.match(
        output,
        /ERR_ASSERTION/,
        `${variant.name}: failure must be a behavior assertion, not a build/import error`,
      );
    }
    results.push(verdict);
    console.log(
      `${variant.name}: ${verdict.passed}/${verdict.tests} passed, ${verdict.failed} failed (expected ${variant.expectedPass ? 'green' : 'red'})`,
    );
  }
  await writeFile(
    join(report, 'ablation-results.json'),
    JSON.stringify(
      {
        baseline,
        node: process.version,
        head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim(),
        variants: results,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
