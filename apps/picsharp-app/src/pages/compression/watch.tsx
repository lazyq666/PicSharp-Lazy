import { useEffect, useRef, useContext } from 'react';
import { debounce } from 'radash';
import useCompressionStore from '@/store/compression';
import WatchFileManager from './watch-file-manager';
import { parsePaths, humanSize } from '@/utils/fs';
import { VALID_MEDIA_EXTS } from '@/constants';
import { isValidArray, correctFloat } from '@/utils';
import Compressor, { ICompressor } from '@/utils/compressor';
import { SettingsKey, CompressionMode, CompressionOutputMode } from '@/constants';
import { exists } from '@tauri-apps/plugin-fs';
import { isString } from 'radash';
import { useI18n } from '@/i18n';
import useSettingsStore from '@/store/settings';
import { useNavigate } from '../../hooks/useNavigate';
import { sendTextNotification } from '@/utils/notification';
import useAppStore from '@/store/app';
import { convertFileSrc } from '@tauri-apps/api/core';
import { AppContext } from '@/routes';
import { CompressionContext } from '.';
import { message } from '@/components/message';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useReport } from '@/hooks/useReport';
import { captureError } from '@/utils';
import { excludeVideoOutputs } from '@/utils/video';
import { WatchQueue, WatchCandidate, filterWatchInputs } from '@/utils/watch-queue';

function CompressionWatch() {
  const { progressRef } = useContext(CompressionContext);
  const navigate = useNavigate();
  const queueRef = useRef(new WatchQueue());
  const t = useI18n();
  const { messageApi } = useContext(AppContext);
  const isFirstInit = useRef(true);
  const ctrlRef = useRef<AbortController | null>(null);
  const r = useReport();
  const drainingRef = useRef(false);
  const activeRef = useRef(true);
  const runningRef = useRef(new Map<string, FileInfo>());

  const handleCompress = async (files: FileInfo[]) => {
    const inputs = new Map(files.map((file) => [file.path, file]));
    const finish = (path: string) => {
      if (runningRef.current.get(path) === inputs.get(path)) {
        runningRef.current.delete(path);
      }
      if (activeRef.current) throttledProcessData();
    };
    let fulfilled = 0;
    let rejected = 0;
    const rejectedList = [];
    let startTime = Date.now();
    try {
      const { sidecar, imageTempDir } = useAppStore.getState();
      const { fileMap, eventEmitter } = useCompressionStore.getState();

      const {
        [SettingsKey.TinypngApiKeys]: tinypngApiKeys,
        [SettingsKey.CompressionMode]: compressionMode,
        [SettingsKey.CompressionOutput]: outputMode,
        [SettingsKey.CompressionOutputSaveToFolder]: saveToFolder,
        [SettingsKey.CompressionOutputSaveAsFileSuffix]: saveAsFileSuffix,
        [SettingsKey.CompressionThresholdEnable]: thresholdEnable,
        [SettingsKey.CompressionThresholdValue]: thresholdValue,
        [SettingsKey.CompressionLevel]: compressionLevel,
        [SettingsKey.CompressionType]: compressionType,
        [SettingsKey.CompressionConvertEnable]: convertEnable,
        [SettingsKey.CompressionConvert]: convertTypes,
        [SettingsKey.CompressionConvertAlpha]: convertAlpha,
        [SettingsKey.CompressionResizeEnable]: resizeEnable,
        [SettingsKey.CompressionResizeDimensions]: resizeDimensions,
        [SettingsKey.CompressionResizeFit]: resizeFit,
        [SettingsKey.CompressionWatermarkType]: watermarkType,
        [SettingsKey.CompressionWatermarkPosition]: watermarkPosition,
        [SettingsKey.CompressionWatermarkText]: watermarkText,
        [SettingsKey.CompressionWatermarkTextColor]: watermarkTextColor,
        [SettingsKey.CompressionWatermarkFontSize]: watermarkFontSize,
        [SettingsKey.CompressionWatermarkImagePath]: watermarkImagePath,
        [SettingsKey.CompressionWatermarkImageOpacity]: watermarkImageOpacity,
        [SettingsKey.CompressionWatermarkImageScale]: watermarkImageScale,
        [SettingsKey.CompressionKeepMetadata]: keepMetadata,
      } = useSettingsStore.getState();

      // Image-only preflight errors must not block locally encoded videos.
      const { watchingFolder } = useCompressionStore.getState();
      let imageError = '';
      if (compressionMode !== CompressionMode.Local && !isValidArray(tinypngApiKeys)) {
        imageError = t('tips.tinypng_api_keys_not_configured');
      } else if (outputMode === CompressionOutputMode.SaveToNewFolder) {
        if (!saveToFolder) imageError = t('tips.save_to_folder_not_configured');
        else if (saveToFolder === watchingFolder) imageError = t('tips.watch_and_save_same_folder');
        else if (!(await exists(saveToFolder)))
          imageError = t('tips.save_to_folder_not_exists', { path: saveToFolder });
      }
      const tasks = files.filter((file) => {
        if (file.mediaType === 'video' || !imageError) return true;
        file.status = ICompressor.Status.Failed;
        file.errorMessage = imageError;
        rejected++;
        return false;
      });
      eventEmitter.emit('update_file_item', 'all');

      await new Compressor({
        compressionMode,
        compressionLevel,
        compressionType,
        limitCompressRate: thresholdEnable ? thresholdValue : undefined,
        tinifyApiKeys: tinypngApiKeys.map((key) => key.api_key),
        save: {
          mode: outputMode,
          newFileSuffix: saveAsFileSuffix,
          newFolderPath: saveToFolder,
        },
        tempDir: imageTempDir,
        sidecarDomain: sidecar?.origin,
        convertEnable,
        convertTypes,
        convertAlpha,
        resizeDimensions,
        resizeEnable,
        resizeFit,
        watermarkType,
        watermarkPosition,
        watermarkText,
        watermarkTextColor,
        watermarkFontSize,
        watermarkImagePath,
        watermarkImageOpacity,
        watermarkImageScale,
        keepMetadata,
      }).compress(
        tasks,
        (res) => {
          finish(res.input_path);
          if (res.skipped) {
            const state = useCompressionStore.getState();
            if (state.fileMap.get(res.input_path) === inputs.get(res.input_path))
              state.removeFile(res.input_path);
            return;
          }
          const targetFile = fileMap.get(res.input_path);
          if (targetFile) {
            fulfilled++;
            targetFile.status = ICompressor.Status.Completed;
            if (res.compression_rate > 0 || targetFile.mediaType === 'video') {
              targetFile.compressedBytesSize = res.output_size;
              targetFile.compressedDiskSize = res.output_size;
              targetFile.formattedCompressedBytesSize = humanSize(res.output_size);
              targetFile.compressRate = `${correctFloat(Math.abs(res.compression_rate) * 100)}%`;
            } else {
              targetFile.compressedBytesSize = targetFile.bytesSize;
              targetFile.compressedDiskSize = targetFile.diskSize;
              targetFile.formattedCompressedBytesSize = humanSize(targetFile.bytesSize);
              targetFile.compressRate = '0%';
            }
            if (targetFile.mediaType !== 'video')
              targetFile.assetPath = convertFileSrc(res.output_path);
            targetFile.outputPath = res.output_path;
            targetFile.originalTempPath = res.original_temp_path;
            targetFile.originalTempPathConverted = res.original_temp_path
              ? convertFileSrc(res.original_temp_path)
              : '';
            targetFile.saveType = outputMode;
            if (isValidArray(res.convert_results)) {
              targetFile.convertResults = res.convert_results;
            }
          } else {
            rejected++;
            rejectedList.push(res);
            r('file_not_found_after_compression', {
              success: true,
              data: res,
            });
          }
          eventEmitter.emit('update_file_item', res.input_path);
        },
        (res) => {
          finish(res.input_path);
          rejected++;
          rejectedList.push(res);
          const targetFile = fileMap.get(res.input_path);
          if (targetFile) {
            targetFile.status =
              targetFile.videoPhase === 'cancelled'
                ? ICompressor.Status.Cancelled
                : ICompressor.Status.Failed;
            if (isString(res.error)) {
              targetFile.errorMessage = res.error;
            } else {
              targetFile.errorMessage = res.error.toString();
            }
            eventEmitter.emit('update_file_item', res.input_path);
          } else {
            r('file_not_found_after_compression', {
              success: false,
              data: res,
            });
          }
        },
      );
      if (!fulfilled && !rejected) return;
      messageApi?.success(
        t('tips.compress_completed', {
          fulfilled,
          rejected,
          total: files.length,
        }),
      );
      sendTextNotification(
        t('common.compress_completed'),
        t('tips.compress_completed', {
          fulfilled,
          rejected,
          total: files.length,
        }),
      );
      r('classic_compress_completed', {
        fulfilled,
        rejected,
        total: files.length,
        rejectedList: rejectedList.slice(0, 10),
        costTime: Date.now() - startTime,
      });
    } catch (error) {
      captureError(error);
      r('classic_compress_failed', {
        fulfilled,
        rejected,
        total: files.length,
        error: error.toString(),
        rejectedList: rejectedList.slice(0, 10),
        costTime: Date.now() - startTime,
      });
      messageApi?.error(t('common.compress_failed_msg'));
      sendTextNotification(t('common.compress_failed'), t('common.compress_failed_msg'));
    } finally {
      for (const file of files) {
        if (runningRef.current.get(file.path) === file) runningRef.current.delete(file.path);
      }
      useCompressionStore.getState().trimWatchHistory();
      if (activeRef.current) throttledProcessData();
    }
  };

  const throttledProcessData = debounce({ delay: 1000 }, async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    let batch: WatchCandidate[] = [];
    const isBusy = (path: string) =>
      runningRef.current.has(path) ||
      useCompressionStore.getState().fileMap.get(path)?.status === ICompressor.Status.Processing;
    try {
      while (activeRef.current && queueRef.current.hasReady(isBusy)) {
        batch = queueRef.current.take(isBusy);
        const { sidecar } = useAppStore.getState();
        // Read the current preference for each batch so toggling it also affects a live watch.
        const eligible = await filterWatchInputs(sidecar?.origin, batch, {
          signal: ctrlRef.current?.signal,
          ignoreNinePatch: useSettingsStore.getState()[SettingsKey.CompressionWatchIgnoreNinePatch],
        });
        const paths = new Set(await excludeVideoOutputs(eligible.map((entry) => entry.path)));
        if (!activeRef.current) break;
        const versions = new Map(
          eligible
            .filter((entry) => paths.has(entry.path) && !queueRef.current.hasNewer(entry))
            .map((entry) => [entry.path, entry.version]),
        );
        const candidates = await parsePaths([...versions.keys()], VALID_MEDIA_EXTS);
        if (!activeRef.current) break;
        if (candidates.length) {
          const { files, setFiles } = useCompressionStore.getState();
          // Replacing a changed source keeps one card per path.
          const incoming = new Set(candidates.map((file) => file.path));
          candidates.forEach((file) => {
            file.status = ICompressor.Status.Processing;
            file.watchVersion = versions.get(file.path);
            runningRef.current.set(file.path, file);
          });
          setFiles([...files.filter((file) => !incoming.has(file.path)), ...candidates]);
          void handleCompress(candidates);
        }
        batch = [];
      }
    } catch (error) {
      if (activeRef.current) {
        queueRef.current.retry(batch);
        captureError(error);
      }
    } finally {
      drainingRef.current = false;
      if (activeRef.current && queueRef.current.hasReady(isBusy)) throttledProcessData();
    }
  });

  const alert = async (title: string, content: string = '') => {
    sendTextNotification(title, content);
    message?.error({
      title,
      description: content,
    });
  };

  function regain() {
    const { reset } = useCompressionStore.getState();
    ctrlRef.current?.abort();
    reset();
    navigate('/compression/watch/guide');
    progressRef.current?.done();
  }

  useEffect(() => {
    activeRef.current = true;
    const { watchingFolder } = useCompressionStore.getState();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    async function handleWatch() {
      const { compression_watch_file_ignore: ignores = [] } = useSettingsStore.getState();
      const { sidecar } = useAppStore.getState();
      fetchEventSource(`${sidecar?.origin}/stream/watch/new-images`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer picsharp_sidecar`,
        },
        body: JSON.stringify({
          path: watchingFolder,
          ignores,
        }),
        signal: ctrl.signal,
        openWhenHidden: true,
        onopen: async (response) => {
          if (response.ok && response.headers.get('content-type') === 'text/event-stream') {
            console.log('[Sidecar] Watch EventSource opened');
            isFirstInit.current = false;
          } else {
            alert(t('tips.watch_service_startup_failed'));
          }
        },
        async onmessage(msg) {
          if (msg.event === 'ready') {
            console.log('[Sidecar] Watch EventSource ready');
            progressRef.current?.done();
          } else if (msg.event === 'add') {
            const payload = JSON.parse(msg.data);
            const path = payload.fullPath;
            if (typeof payload.version !== 'string') return;
            queueRef.current.add({ path, version: payload.version });
            throttledProcessData();
          } else if (msg.event === 'self-enoent') {
            console.log('[Sidecar] Watch EventSource self-enoent');
            ctrl.abort();
            regain();
            alert(t('tips.file_watch_target_changed'));
            getCurrentWebviewWindow().show();
            getCurrentWebviewWindow().setFocus();
          } else if (msg.event === 'fault') {
            console.log('[Sidecar] Watch EventSource fault', msg);
          }
        },
        onerror(error) {
          console.log('[Sidecar] Watch EventSource error', error);
          setTimeout(() => {
            if (!ctrl.signal.aborted) {
              regain();
              if (isFirstInit.current) {
                alert(t('tips.watch_service_startup_failed'));
              } else {
                alert(t('tips.file_watch_abort'));
              }
              getCurrentWebviewWindow().show();
              getCurrentWebviewWindow().setFocus();
            }
          }, 1000);
          captureError(error);
        },
        onclose() {
          console.log('[Sidecar] Watch EventSource closed');
          regain();
          if (isFirstInit.current) {
            alert(t('tips.watch_service_startup_failed'));
          } else {
            alert(t('tips.file_watch_abort'));
          }
          getCurrentWebviewWindow().show();
          getCurrentWebviewWindow().setFocus();
        },
      });
    }
    function handlePageVisible() {
      if (document.visibilityState === 'visible') {
        if (ctrl.signal.aborted && !isFirstInit.current) {
          regain();
          alert(t('tips.file_watch_abort'));
          getCurrentWebviewWindow().show();
          getCurrentWebviewWindow().setFocus();
        }
      }
    }
    if (!watchingFolder) {
      regain();
      alert(t('tips.file_watch_abort'));
      getCurrentWebviewWindow().show();
      getCurrentWebviewWindow().setFocus();
      return;
    }
    handleWatch();
    window.addEventListener('visibilitychange', handlePageVisible);
    return () => {
      activeRef.current = false;
      queueRef.current.clear();
      throttledProcessData.cancel();
      ctrl.abort();
      ctrlRef.current = null;
      window.removeEventListener('visibilitychange', handlePageVisible);
    };
  }, []);

  useEffect(() => {
    const { watchingFolder } = useCompressionStore.getState();
    r('watch_imp', {
      has_folder: !!watchingFolder,
    });
  }, []);

  return (
    <div className='h-full'>
      <WatchFileManager />
    </div>
  );
}

export default CompressionWatch;
