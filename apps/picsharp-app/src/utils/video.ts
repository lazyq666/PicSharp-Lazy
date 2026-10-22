import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import useCompressionStore from '@/store/compression';
import useSettingsStore from '@/store/settings';
import { ICompressor } from './compressor';
import { humanSize } from './fs';
import { correctFloat } from '.';

export interface VideoInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  audio: string[];
  hdr: boolean;
}
export interface VideoProgress {
  fraction: number;
  seconds: number;
  speed: number;
  remaining: number | null;
}
interface VideoOutput {
  path: string;
  bytes: number;
  elapsed: number;
  log: string;
}
interface VideoJob {
  id: string;
  path: string;
  status: string;
  input_bytes: number;
  progress: VideoProgress;
  info?: VideoInfo;
  thumbnail?: string;
  output?: VideoOutput;
  error?: string;
}
export const videoTime = (seconds: number) => {
  const value = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
};
const activeRequests = new Set<string>();
const cancellationRequests = new Set<string>();
export const cancelVideo = (path: string) => {
  if (activeRequests.has(path)) cancellationRequests.add(path);
  return invoke('ipc_cancel_video', { path });
};

export function applyJob(file: FileInfo, job: VideoJob) {
  if (job.input_bytes > 0) {
    file.bytesSize = job.input_bytes;
    file.formattedBytesSize = humanSize(job.input_bytes);
  }
  file.videoPhase = job.status;
  file.videoProgress = job.progress;
  file.videoInfo = job.info || file.videoInfo;
  file.status =
    job.status === 'ready'
      ? ICompressor.Status.Pending
      : job.status === 'pending'
        ? ICompressor.Status.Processing
        : (job.status as ICompressor.Status);
  file.errorMessage = job.error || '';
  if (job.output) {
    file.outputPath = job.output.path;
    file.compressedBytesSize = job.output.bytes;
    file.compressedDiskSize = job.output.bytes;
    file.formattedCompressedBytesSize = humanSize(job.output.bytes);
    file.compressRate = `${correctFloat(Math.abs(1 - job.output.bytes / Math.max(1, file.bytesSize)) * 100)}%`;
  }
}

export async function compressVideo(file: FileInfo): Promise<ICompressor.ResultItem> {
  const { eventEmitter } = useCompressionStore.getState();
  const { video_preset, video_output_folder } = useSettingsStore.getState();
  activeRequests.add(file.path);
  cancellationRequests.delete(file.path);
  file.status = ICompressor.Status.Processing;
  file.videoPhase = 'submitting';
  file.errorMessage = '';
  file.videoProgress = { fraction: 0, seconds: 0, speed: 0, remaining: null };
  eventEmitter.emit('update_file_item', file.path);
  let unlisten: UnlistenFn | undefined;
  try {
    unlisten = await listen<VideoJob>('video-job', ({ payload }) => {
      if (payload.path !== file.path) return;
      applyJob(file, payload);
      if (payload.status === 'pending' && cancellationRequests.has(file.path)) {
        void invoke('ipc_cancel_video', { path: file.path });
      }
      eventEmitter.emit('update_file_item', file.path);
    });
    if (cancellationRequests.has(file.path)) {
      file.videoPhase = 'cancelled';
      throw new Error('已取消，未完成的文件已清理。');
    }
    const output = await invoke<VideoOutput>('ipc_compress_video', {
      path: file.path,
      preset: video_preset,
      directory: video_output_folder || null,
    });
    applyJob(file, {
      id: file.id,
      path: file.path,
      input_bytes: file.bytesSize,
      status: 'completed',
      progress: { fraction: 1, seconds: file.videoInfo?.duration || 0, speed: 0, remaining: 0 },
      output,
    });
    return {
      input_path: file.path,
      input_size: file.bytesSize,
      output_path: output.path,
      output_size: output.bytes,
      compression_rate: 1 - output.bytes / Math.max(1, file.bytesSize),
      output_converted_path: '',
      original_temp_path: '',
      original_temp_converted_path: '',
      available_compress_rate: true,
      hash: '',
      ssim: 0,
    };
  } catch (error) {
    file.status =
      file.videoPhase === 'cancelled' || cancellationRequests.has(file.path)
        ? ICompressor.Status.Cancelled
        : ICompressor.Status.Failed;
    file.videoPhase = file.status;
    file.errorMessage = String(error);
    throw error;
  } finally {
    activeRequests.delete(file.path);
    cancellationRequests.delete(file.path);
    unlisten?.();
    eventEmitter.emit('update_file_item', file.path);
  }
}

export async function restoreVideoHistory(): Promise<FileInfo[]> {
  const jobs = await invoke<VideoJob[]>('ipc_video_history');
  return jobs.map((job) => {
    const file: FileInfo = {
      id: job.id,
      mediaType: 'video',
      path: job.path,
      name: job.path.split(/[/\\]/).pop(),
      parentDir: job.path.replace(/[/\\][^/\\]+$/, ''),
      assetPath: convertFileSrc(job.path),
      ext: job.path.split('.').pop().toLowerCase(),
      mimeType: 'video/*',
      bytesSize: job.input_bytes,
      diskSize: job.input_bytes,
      formattedBytesSize: humanSize(job.input_bytes),
      formattedDiskSize: humanSize(job.input_bytes),
      compressedBytesSize: 0,
      compressedDiskSize: 0,
      formattedCompressedBytesSize: '',
      formattedCompressedDiskSize: '',
      compressRate: '',
      outputPath: '',
      originalTempPath: '',
      originalTempPathConverted: '',
      ssim: 0,
      status: ICompressor.Status.Pending,
    };
    applyJob(file, job);
    return file;
  });
}

export function listenVideoJobs() {
  return listen<VideoJob>('video-job', ({ payload }) => {
    const { fileMap, eventEmitter } = useCompressionStore.getState();
    const file = fileMap.get(payload.path);
    if (file?.mediaType === 'video') {
      applyJob(file, payload);
      eventEmitter.emit('update_file_item', file.path);
    }
  });
}
