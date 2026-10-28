import { copyFile, stat } from 'node:fs/promises';
import { canonicalPath } from './file-version';
import { imageOutputRecords, isWatchInputChanged, OutputRecords } from './output-records';

export interface UndoImageInput {
  path: string;
  outputPath: string;
  originalTempPath: string;
  saveType: 'overwrite' | 'save_as_new_file' | 'save_to_new_folder';
  outputVersion?: string;
  convertResults?: { output_path: string; output_version?: string }[];
}

export interface UndoImageResult {
  success: boolean;
  message: string;
  recoveryPaths?: string[];
}

export async function undoImage(
  input: UndoImageInput,
  records: OutputRecords = imageOutputRecords(),
): Promise<UndoImageResult> {
  const failed = (message: string) => ({ success: false, message });
  // Cards from an older service cannot identify the result they own. Fail closed.
  if (!input.outputVersion) return failed('undo.output_file_changed');
  try {
    if (!(await stat(input.originalTempPath)).isFile())
      return failed('undo.original_file_not_exists');
  } catch {
    return failed('undo.original_file_not_exists');
  }

  const claimed: Awaited<ReturnType<OutputRecords['claim']>>[] = [];
  try {
    const output = await canonicalPath(input.outputPath);
    const source = await canonicalPath(input.path);
    const paths = new Set([output]);
    const targets = [{ path: output, version: input.outputVersion }];
    for (const item of input.convertResults ?? []) {
      const path = await canonicalPath(item.output_path);
      if (paths.has(path)) continue;
      if (!item.output_version) return failed('undo.output_file_changed');
      paths.add(path);
      targets.push({ path, version: item.output_version });
    }
    // Claim the exact current objects, then verify their identities. A stale card
    // must never remove a different object which happens to have the same path.
    for (const target of targets) claimed.push(await records.claim(target.path, target.version));
    if (source === output) {
      // Reuse the directory anchored by claim. If Finder moves that directory,
      // restoring by its old absolute pathname could write into a different one.
      // The anchored publication also refuses a new export occupying the name.
      await claimed[0].publish((temporary) => copyFile(input.originalTempPath, temporary));
    }
    for (const item of claimed) await item.discard();
    return { success: true, message: 'undo.success' };
  } catch (error: any) {
    // restore() never replaces a file created by another writer. A claimed object
    // is retained for recovery if its old path has since become occupied.
    const recoveryPaths = new Set<string>();
    const collectRecovery = (failure: any) => {
      if (typeof failure?.recoveryPath === 'string') recoveryPaths.add(failure.recoveryPath);
      if (failure?.cause) collectRecovery(failure.cause);
    };
    collectRecovery(error);
    let rollbackFailed = false;
    for (const item of claimed.reverse()) {
      try {
        await item.restore();
      } catch (restoreError) {
        collectRecovery(restoreError);
        rollbackFailed ||= !isWatchInputChanged(restoreError);
        // A failure for one target must not prevent the other targets returning.
        if (
          await stat(item.path).then(
            (value) => value.isFile(),
            () => false,
          )
        ) {
          recoveryPaths.add(item.path);
        }
      }
    }
    return {
      ...failed(
        !rollbackFailed && isWatchInputChanged(error) ? 'undo.output_file_changed' : 'undo.failed',
      ),
      ...(recoveryPaths.size ? { recoveryPaths: [...recoveryPaths] } : {}),
    };
  }
}
