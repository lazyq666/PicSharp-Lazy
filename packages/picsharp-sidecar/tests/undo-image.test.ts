import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  copyFile,
  rename,
  rm,
  access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import sharp from 'sharp';
import { OutputRecords } from '../src/services/output-records';
import { DirectoryAnchor } from '../src/services/directory-anchor';
import { undoImage, UndoImageInput } from '../src/services/undo-image';
import { readFileVersion } from '../src/services/file-version';
import { createMediaEvents } from '../src/controllers/watch/media';
import { watchMediaFiles } from '../src/controllers/watch/files';
import { processPngLossless } from '../src/services/compress/png';
import app from '../src/controllers/watch';

const exists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'picsharp-undo-image-')));
  const watched = join(root, 'watched');
  const outputs = join(root, 'outputs');
  const temp = join(root, 'temp');
  await mkdir(watched);
  await mkdir(outputs);
  await mkdir(temp);
  const records = new OutputRecords(join(root, 'records'));
  const path = join(watched, 'image.png'),
    outputPath = join(outputs, 'image.png'),
    originalTempPath = join(temp, 'backup.png');
  const raw = await sharp({
    create: { width: 100, height: 100, channels: 3, background: '#ff0000' },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
  const compressed = await sharp(raw).png({ compressionLevel: 9 }).toBuffer();
  const next = await sharp({
    create: { width: 100, height: 100, channels: 3, background: '#0000ff' },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
  await writeFile(path, raw);
  await writeFile(originalTempPath, raw);
  const previous = process.env.PICSHARP_IMAGE_OUTPUTS_DIR;
  process.env.PICSHARP_IMAGE_OUTPUTS_DIR = records.directory;
  return {
    root,
    watched,
    outputs,
    temp,
    records,
    path,
    outputPath,
    originalTempPath,
    raw,
    compressed,
    next,
    async publish(overwrite = false) {
      const output = overwrite ? path : outputPath;
      await records.publish(output, (p) => writeFile(p, compressed));
      return {
        path,
        outputPath: output,
        originalTempPath,
        saveType: overwrite ? 'overwrite' : 'save_to_new_folder',
        outputVersion: (await readFileVersion(output))!,
      } satisfies UndoImageInput;
    },
    async close() {
      if (previous === undefined) delete process.env.PICSHARP_IMAGE_OUTPUTS_DIR;
      else process.env.PICSHARP_IMAGE_OUTPUTS_DIR = previous;
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function until(condition: () => boolean) {
  const deadline = Date.now() + 6000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for file event');
    await sleep(20);
  }
}

test('WATCH-014: moved old output and new file at its old path survive stale Undo', async () => {
  const f = await fixture();
  try {
    const input = await f.publish();
    const stash = join(f.root, 'old-output.png');
    await rename(input.outputPath, stash);
    await writeFile(input.outputPath, f.next);
    const result = await undoImage(input, f.records);
    assert.deepEqual(result, { success: false, message: 'undo.output_file_changed' });
    assert.deepEqual(await readFile(input.outputPath), f.next);
    assert.deepEqual(await readFile(stash), f.compressed);
    assert.deepEqual(await readFile(f.path), f.raw);
  } finally {
    await f.close();
  }
});

test('WATCH-014: a new export after publication cannot be attributed to the old result card', async () => {
  const f = await fixture();
  const originalCommit = OutputRecords.prototype.commit;
  try {
    let injected = false;
    OutputRecords.prototype.commit = async function (...args: Parameters<typeof originalCommit>) {
      const result = await originalCommit.apply(this, args);
      if (args[0] === f.outputPath && !injected) {
        injected = true;
        await writeFile(f.outputPath, f.next);
      }
      return result;
    };
    const result = await processPngLossless({
      input_path: f.path,
      process_options: {},
      options: {
        temp_dir: f.temp,
        save: { mode: 'save_to_new_folder', new_folder_path: f.outputs },
        watermark_type: 'none',
      },
    });
    assert.ok(injected, 'controlled export landed after commit and before compression response');
    const undo = await undoImage(
      {
        path: f.path,
        outputPath: result.output_path,
        originalTempPath: result.original_temp_path,
        saveType: 'save_to_new_folder',
        outputVersion: result.output_version,
      },
      f.records,
    );
    assert.equal(undo.success, false, 'the old card must not own the newly exported V2');
    assert.deepEqual(await readFile(f.outputPath), f.next);
  } finally {
    OutputRecords.prototype.commit = originalCommit;
    await f.close();
  }
});
test('WATCH-014: a replacement at the final claim rename is restored, never deleted', async () => {
  const f = await fixture();
  const originalClaim = DirectoryAnchor.prototype.claim;
  try {
    const input = await f.publish();
    let injected = false;
    DirectoryAnchor.prototype.claim = async function () {
      if ((await this.location()) === input.outputPath && !injected) {
        injected = true;
        await writeFile(input.outputPath, f.next);
      }
      return originalClaim.call(this);
    };
    const result = await undoImage(input, f.records);
    assert.ok(
      injected,
      'controlled replacement landed after validation and before the anchored rename request',
    );
    assert.equal(result.success, false);
    assert.deepEqual(await readFile(input.outputPath), f.next);
  } finally {
    DirectoryAnchor.prototype.claim = originalClaim;
    await f.close();
  }
});

test('Undo after claim cannot restore into a different parent recreated at the old pathname', async () => {
  const f = await fixture();
  const originalClaim = OutputRecords.prototype.claim;
  try {
    const input = await f.publish(true);
    const movedParent = join(f.root, 'organized');
    const movedSource = join(movedParent, 'image.png');
    let injected = false;
    OutputRecords.prototype.claim = async function (...args: Parameters<typeof originalClaim>) {
      const result = await originalClaim.apply(this, args);
      if (args[0] === f.path && !injected) {
        injected = true;
        await rename(f.watched, movedParent);
        await mkdir(f.watched);
      }
      return result;
    };
    const result = await undoImage(input, f.records);
    assert.ok(injected, 'original directory moved after the exact object was claimed');
    assert.equal(
      await exists(f.path),
      false,
      'Undo must not write into the unrelated replacement directory',
    );
    const actual = await readFile(movedSource);
    assert.ok(
      actual.equals(f.raw) || actual.equals(f.compressed),
      'the owned file must remain in its actual directory',
    );
    if (result.success)
      assert.deepEqual(
        actual,
        f.raw,
        'successful Undo restores in the original anchored directory',
      );
  } finally {
    OutputRecords.prototype.claim = originalClaim;
    await f.close();
  }
});
test('normal SaveFolder Undo awaits deletion; missing backup and unidentifiable cards fail safely', async () => {
  const f = await fixture();
  try {
    const input = await f.publish();
    const result = await undoImage(input, f.records);
    assert.equal(result.success, true);
    assert.equal(await exists(input.outputPath), false);
    assert.deepEqual(await readFile(f.path), f.raw);
    const newer = await f.publish();
    await rm(f.originalTempPath);
    assert.deepEqual(await undoImage(newer, f.records), {
      success: false,
      message: 'undo.original_file_not_exists',
    });
    assert.deepEqual(await readFile(newer.outputPath), f.compressed);
    assert.deepEqual(await undoImage({ ...newer, outputVersion: undefined }, f.records), {
      success: false,
      message: 'undo.output_file_changed',
    });
  } finally {
    await f.close();
  }
});
test('conversion replacement rejects Undo and restores an already claimed main result', async () => {
  const f = await fixture();
  try {
    const input = await f.publish();
    const converted = join(f.outputs, 'image.webp');
    await f.records.publish(converted, (p) => writeFile(p, 'old webp'));
    const output_version = (await readFileVersion(converted))!;
    await writeFile(converted, 'NEW WEBP');
    const result = await undoImage(
      { ...input, convertResults: [{ output_path: converted, output_version }] },
      f.records,
    );
    assert.equal(result.success, false);
    assert.deepEqual(await readFile(input.outputPath), f.compressed);
    assert.equal(await readFile(converted, 'utf8'), 'NEW WEBP');
  } finally {
    await f.close();
  }
});
test('rollback conflict preserves the occupied conversion and still restores other targets', async () => {
  const f = await fixture();
  try {
    const input = await f.publish();
    const first = join(f.outputs, 'first.webp');
    const changed = join(f.outputs, 'second.webp');
    await f.records.publish(first, (p) => writeFile(p, 'first compressed'));
    await f.records.publish(changed, (p) => writeFile(p, 'second compressed'));
    const firstVersion = (await readFileVersion(first))!;
    const secondVersion = (await readFileVersion(changed))!;
    await writeFile(changed, 'NEW SECOND');
    class CollisionRecords extends OutputRecords {
      async claim(path: string, expectedVersion: string) {
        const claimed = await super.claim(path, expectedVersion);
        if (path !== first) return claimed;
        return {
          ...claimed,
          restore: async () => {
            await writeFile(first, 'NEW FIRST');
            await claimed.restore();
          },
        };
      }
    }
    const records = new CollisionRecords(f.records.directory);
    const result = await undoImage(
      {
        ...input,
        convertResults: [
          { output_path: first, output_version: firstVersion },
          { output_path: changed, output_version: secondVersion },
        ],
      },
      records,
    );
    assert.equal(result.success, false);
    assert.ok(result.recoveryPaths?.length);
    assert.deepEqual(
      await readFile(input.outputPath),
      f.compressed,
      'main result is restored after an earlier rollback collision',
    );
    assert.equal(await readFile(first, 'utf8'), 'NEW FIRST');
    assert.equal(await readFile(changed, 'utf8'), 'NEW SECOND');
    assert.equal(await readFile(result.recoveryPaths![0], 'utf8'), 'first compressed');
  } finally {
    await f.close();
  }
});
test('WATCH-013: restored original stays untouched under real watch and a later new export compresses', async () => {
  const f = await fixture();
  const emitted: any[] = [];
  let watcher: ReturnType<typeof watchMediaFiles> | undefined;
  let events: ReturnType<typeof createMediaEvents> | undefined;
  try {
    const input = await f.publish(true);
    events = createMediaEvents(
      (v) => emitted.push(v),
      80,
      20,
      100,
      f.records,
      (error) => {
        throw error;
      },
    );
    watcher = watchMediaFiles(f.watched, [], events, (error) => {
      throw error;
    });
    await watcher.ready;
    assert.deepEqual(await undoImage(input, f.records), { success: true, message: 'undo.success' });
    assert.deepEqual(await readFile(f.path), f.raw);
    await sleep(2200);
    assert.equal(emitted.length, 0, 'Undo is not a new compression input');
    assert.deepEqual(await readFile(f.path), f.raw, 'raw original remains byte exact');
    await writeFile(f.path, f.next);
    await until(() => emitted.length === 1);
    assert.equal(emitted[0].fullPath, f.path);
    const compressed = await processPngLossless({
      input_path: f.path,
      process_options: {},
      options: {
        temp_dir: f.temp,
        save: { mode: 'overwrite' },
        watermark_type: 'none',
        watch_version: emitted[0].version,
      },
    });
    assert.ok(compressed.output_size < f.next.byteLength);
    assert.ok(compressed.output_version);
    assert.notDeepEqual(
      await readFile(f.path),
      f.raw,
      'genuine blue export replaces old red restore',
    );
    const pixel = await sharp(f.path).raw().toBuffer();
    assert.deepEqual([...pixel.subarray(0, 3)], [0, 0, 255]);
  } finally {
    watcher?.close();
    events?.close();
    await f.close();
  }
});
test('WATCH-013: a fresh export during backup copy wins over Undo restoration', async () => {
  const f = await fixture();
  const originalCopy = fs.promises.copyFile;
  try {
    const input = await f.publish(true);
    let injected = false;
    fs.promises.copyFile = (async (from: any, to: any, ...rest: any[]) => {
      await originalCopy(from, to, ...rest);
      if (from === input.originalTempPath && !injected) {
        injected = true;
        await writeFile(f.path, f.next);
      }
    }) as typeof originalCopy;
    syncBuiltinESMExports();
    const result = await undoImage(input, f.records);
    assert.ok(injected);
    assert.equal(result.success, false);
    assert.deepEqual(await readFile(f.path), f.next);
  } finally {
    fs.promises.copyFile = originalCopy;
    syncBuiltinESMExports();
    await f.close();
  }
});
test('Undo HTTP route uses the real identity-protected service and validates requests', async () => {
  const f = await fixture();
  try {
    const input = await f.publish();
    const response = await app.request('/undo-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, message: 'undo.success' });
    assert.equal(await exists(input.outputPath), false);
    const invalid = await app.request('/undo-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).success, false);
  } finally {
    await f.close();
  }
});
