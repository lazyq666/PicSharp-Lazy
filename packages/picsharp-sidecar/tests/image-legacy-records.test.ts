import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  realpath,
  mkdir,
  readFile,
  writeFile,
  rename,
  copyFile,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import sharp from 'sharp';
import { OutputRecords } from '../src/services/output-records';
import { readFileVersion } from '../src/services/file-version';
import { createMediaEvents } from '../src/controllers/watch/media';
import { watchMediaFiles } from '../src/controllers/watch/files';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'picsharp-legacy-output-')));
  const watched = join(root, 'watched');
  const records = new OutputRecords(join(root, 'records'));
  await mkdir(watched);
  const path = join(watched, 'finished.png');
  const bytes = await sharp({
    create: { width: 64, height: 64, channels: 3, background: '#e13737' },
  })
    .png()
    .toBuffer();
  const next = await sharp({
    create: { width: 64, height: 64, channels: 3, background: '#305fdd' },
  })
    .png()
    .toBuffer();
  await records.publish(path, (temporary) => writeFile(temporary, bytes));
  // Recreate exactly the shipped legacy record format. No identity index from
  // this test's fixture creation may accidentally make the upgrade test green.
  const recordPath = join(
    records.directory,
    createHash('sha256').update(path).digest('hex') + '.json',
  );
  const current = JSON.parse(await readFile(recordPath, 'utf8'));
  const legacy = { path: current.path, version: current.version, fingerprint: current.fingerprint };
  await writeFile(recordPath, JSON.stringify(legacy));
  await rm(join(records.directory, 'identities'), { recursive: true, force: true });
  assert.equal('identity' in JSON.parse(await readFile(recordPath, 'utf8')), false);
  return {
    root,
    watched,
    records,
    path,
    bytes,
    next,
    legacy,
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function until(condition: () => boolean) {
  const deadline = Date.now() + 6000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for media event');
    await sleep(20);
  }
}

test('WATCH-001 legacy upgrade: real watch baseline sees the old path, then pure rename must skip', async () => {
  const f = await fixture();
  const delivered: { fullPath: string; version?: string }[] = [];
  const faults: Error[] = [];
  const events = createMediaEvents(
    (event) => delivered.push(event),
    70,
    15,
    100,
    f.records,
    (error) => faults.push(error),
  );
  const watcher = watchMediaFiles(f.watched, [], events, (error) => faults.push(error));
  try {
    await watcher.ready;
    const moved = join(f.watched, 'delivery.png');
    await rename(f.path, moved);
    await sleep(1200);
    assert.deepEqual(faults, []);
    assert.deepEqual(
      delivered,
      [],
      'pure organization of a pre-upgrade compressed image must not enqueue compression',
    );
    assert.equal(await f.records.status(moved), 'output');
    const independent = join(f.watched, 'independent.png');
    await copyFile(moved, independent);
    await until(() => delivered.some((event) => event.fullPath === independent));
    assert.equal(
      await f.records.status(independent),
      'input',
      'same bytes at an independent inode remain a new original',
    );
    await writeFile(moved, f.next);
    await until(() => delivered.some((event) => event.fullPath === moved));
    assert.equal(
      await f.records.status(moved),
      'input',
      'genuinely re-exported V2 at the organized path remains eligible',
    );
  } finally {
    watcher.close();
    events.close();
    await f.close();
  }
});

test('legacy exact-path check keeps old output protection and does not globally suppress byte-identical copies or V2', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.records.status(f.path), 'output');
    const independent = join(f.watched, 'same-bytes-independent.png');
    await copyFile(f.path, independent);
    assert.notEqual(
      (await stat(f.path, { bigint: true })).ino,
      (await stat(independent, { bigint: true })).ino,
    );
    assert.equal(await f.records.status(independent), 'input');
    const moved = join(f.watched, 'renamed-after-check.png');
    await rename(f.path, moved);
    assert.equal(
      await f.records.status(moved),
      'output',
      'checking a valid legacy result before organization must retain its identity',
    );
    await writeFile(moved, f.next);
    assert.equal(await f.records.status(moved), 'input');
  } finally {
    await f.close();
  }
});

test('legacy first encounter after an earlier rename records its migration boundary without global content dedupe', async (t) => {
  const f = await fixture();
  try {
    const before = await stat(f.path, { bigint: true });
    const moved = join(f.watched, 'moved-before-first-check.png');
    await rename(f.path, moved);
    const after = await stat(moved, { bigint: true });
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    const migratedStatus = await f.records.status(moved);
    t.diagnostic(
      JSON.stringify({
        scenario: 'old path absent before any upgraded validation',
        legacyRecord: f.legacy,
        newPathVersion: await readFileVersion(moved),
        observedStatus: migratedStatus,
        samePhysicalObject: true,
      }),
    );
    const independent = join(f.watched, 'same-bytes-copy.png');
    await copyFile(moved, independent);
    assert.equal(
      await f.records.status(independent),
      'input',
      'a migration must not turn all matching bytes into known outputs',
    );
    await writeFile(moved, f.next);
    assert.equal(await f.records.status(moved), 'input');
  } finally {
    await f.close();
  }
});
