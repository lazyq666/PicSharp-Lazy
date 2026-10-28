import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { ICompressor } from './compressor';
import { isValidArray } from '.';
import { VALID_VIDEO_EXTS } from '@/constants';
import { isMac, isLinux } from '.';
import useSettingsStore from '@/store/settings';
import useAppStore from '@/store/app';

const mags = ' KMGTPEZY';
export function humanSize(bytes: number) {
  if (bytes === 0) {
    return '0B';
  }

  let base = 1024;
  let precision = 1;
  // mac or linux use Base-10 for file size
  if (isMac || isLinux) {
    base = 1000;
  }
  const magnitude = Math.min((Math.log(bytes) / Math.log(base)) | 0, mags.length - 1);
  if (magnitude <= 1) {
    precision = 0;
  }
  const result = bytes / Math.pow(base, magnitude);
  const suffix = mags[magnitude].trim() + 'B';
  return `${Number(result.toFixed(precision))}${suffix}`;
}

export interface ParsePathsItem {
  id: string;
  name: string;
  path: string;
  base_dir: string;
  bytes_size: number;
  disk_size: number;
  ext: string;
  mime_type: string;
}

export async function parsePaths(
  paths: string[],
  validExts: string[],
  excludedPaths?: ReadonlySet<string>,
  isCurrent: () => boolean = () => true,
) {
  const parsed = await invoke<ParsePathsItem[]>('ipc_parse_paths', {
    paths,
    validExts,
  });
  if (!isCurrent()) return [];
  // Filter after directory expansion, before registration can reset an existing video job.
  const candidates = parsed?.filter((item) => !excludedPaths?.has(item.path));
  if (isValidArray(candidates)) {
    const videos = candidates.filter((item) => VALID_VIDEO_EXTS.includes(item.ext));
    if (videos.length) {
      const { video_preset, video_output_folder } = useSettingsStore.getState();
      await invoke('ipc_register_videos', {
        paths: [...new Set(videos.map((file) => file.path))],
        preset: video_preset,
        directory: video_output_folder || null,
      });
    }
    return [...new Map(candidates.map((item) => [item.path, item])).values()].map<FileInfo>(
      (item) => {
        return {
          mediaType: VALID_VIDEO_EXTS.includes(item.ext) ? 'video' : 'image',
          id: item.id,
          path: item.path,
          assetPath: convertFileSrc(item.path),
          name: item.name,
          parentDir: item.base_dir,
          bytesSize: item.bytes_size,
          formattedBytesSize: humanSize(item.bytes_size),
          diskSize: item.disk_size,
          formattedDiskSize: humanSize(item.disk_size),
          mimeType: item.mime_type,
          ext: item.ext,
          compressedBytesSize: 0,
          formattedCompressedBytesSize: '',
          compressedDiskSize: 0,
          formattedCompressedDiskSize: '',
          compressRate: '',
          outputPath: '',
          status: ICompressor.Status.Pending,
          originalTempPath: '',
          originalTempPathConverted: '',
          ssim: 0,
        };
      },
    );
  }
  return [];
}

export async function countValidFiles(paths: string[], validExts: string[]) {
  const count = await invoke<number>('ipc_count_valid_files', {
    paths,
    validExts,
  });
  return count;
}

export function getFilename(path: string): string {
  if (typeof path !== 'string' || !path.trim()) {
    return '';
  }

  const cleanPath = path.trim().replace(/[/\\]+$/, '');

  if (!cleanPath) {
    return '';
  }

  const pathParts = cleanPath.split(/[/\\]+/).filter((part) => part.length > 0);

  if (pathParts.length === 0) {
    return '';
  }

  const filename = pathParts[pathParts.length - 1];

  if (filename.startsWith('.') && filename.indexOf('.', 1) === -1) {
    return filename;
  }

  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex === -1 || dotIndex === 0) {
    return filename;
  }

  return filename;
}

export async function undoSave(file: FileInfo) {
  if (
    file.status === ICompressor.Status.Completed &&
    file.outputPath &&
    file.originalTempPath &&
    file.originalTempPathConverted &&
    file.saveType
  ) {
    const { origin } = useAppStore.getState().sidecar ?? {};
    if (!origin) return { success: false, message: 'undo.service_unavailable' };
    // The service owns both the identity check and the filesystem operation.
    // Checking here then deleting by path would leave a second export unprotected.
    try {
      const response = await fetch(`${origin}/stream/watch/undo-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: file.path,
          outputPath: file.outputPath,
          originalTempPath: file.originalTempPath,
          saveType: file.saveType,
          outputVersion: file.outputVersion,
          convertResults: file.convertResults
            ?.filter((item) => item.success)
            .map((item) => ({
              output_path: item.output_path,
              output_version: item.output_version,
            })),
        }),
      });
      if (!response.ok) return { success: false, message: 'undo.service_unavailable' };
      return (await response.json()) as {
        success: boolean;
        message: string;
        recoveryPaths?: string[];
      };
    } catch {
      return { success: false, message: 'undo.service_unavailable' };
    }
  }
  return {
    success: false,
    message: 'undo.no_allow_undo',
  };
}
