import { useEffect, useRef, useContext } from 'react';
import { UnlistenFn } from '@tauri-apps/api/event';
import { isFunction } from 'radash';
import { open } from '@tauri-apps/plugin-dialog';
import { parsePaths } from '../../utils/fs';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { Folder, Upload, History } from 'lucide-react';
import useCompressionStore from '../../store/compression';
import { CompressionContext } from '.';
import { isValidArray, sleep } from '@/utils';
import { useNavigate } from '@/hooks/useNavigate';
import { VALID_MEDIA_EXTS } from '@/constants';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import message from '@/components/message';
import { parseClipboardImages } from '@/utils/clipboard';
import { downloadDir } from '@tauri-apps/api/path';
import { AppContext } from '@/routes';
import UploadWidget from '@/components/animated-icon/upload-widget';
import FormatsTips from './formats-tips';
import { restoreVideoHistory } from '@/utils/video';
import { useReport } from '@/hooks/useReport';

function ClassicCompressionGuide() {
  const { progressRef } = useContext(CompressionContext);
  const dragDropController = useRef<UnlistenFn | null>(null);
  const dropzoneRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const t = useI18n();
  const { messageApi } = useContext(AppContext);
  const r = useReport();

  const handleFiles = async (paths: string[] | null) => {
    if (!isValidArray(paths)) return;
    progressRef.current?.show(true);
    try {
      const files = await parsePaths(paths!, VALID_MEDIA_EXTS);
      if (!isValidArray(files)) {
        progressRef.current?.done();
        message.info({
          title: t('common.no_image_to_compress'),
        });
        return;
      }
      useCompressionStore.getState().setWorking(true);
      useCompressionStore.getState().setFiles(files);
      navigate('/compression/classic/workspace');
      setTimeout(() => {
        progressRef.current?.done();
      }, 100);
    } catch (error) {
      messageApi?.error(String(error));
      progressRef.current?.done();
    }
  };

  const handleSelectFile = async () => {
    const files = await open({
      multiple: true,
      directory: false,
      filters: [
        {
          name: 'Images & Videos',
          extensions: VALID_MEDIA_EXTS,
        },
      ],
    });
    handleFiles(files);
  };

  const handleSelectDirectory = async () => {
    const directory = await open({
      multiple: true,
      directory: true,
      recursive: true,
    });

    if (directory) {
      handleFiles(Array.isArray(directory) ? directory : [directory]);
    }
  };

  useEffect(() => {
    const setupDragDrop = async () => {
      dragDropController.current = await getCurrentWebview().onDragDropEvent(async (event) => {
        if (!dropzoneRef.current) return;

        if (event.payload.type === 'enter') {
          dropzoneRef.current.classList.add('drag-active');
        } else if (event.payload.type === 'leave') {
          dropzoneRef.current.classList.remove('drag-active');
        } else if (event.payload.type === 'drop') {
          dropzoneRef.current.classList.remove('drag-active');
          handleFiles(event.payload.paths);
        }
      });
    };

    const handlePaste = async (event: ClipboardEvent) => {
      let messageKey = 'parse-clipboard-images';
      try {
        event.preventDefault();
        messageApi?.loading({
          key: messageKey,
          content: t('clipboard.parse_clipboard_images'),
        });
        let candidateFormat = 'png';
        if (event.clipboardData) {
          const items = Array.from(event.clipboardData.items);
          const hasImages = items.some(
            (item) => item.kind === 'file' && item.type.startsWith('image/'),
          );
          if (hasImages) {
            candidateFormat =
              items
                .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
                ?.type.split('/')[1] || 'png';
          }
        }
        const tempDir = await downloadDir();
        const { success, paths, error } = await parseClipboardImages(candidateFormat, tempDir);
        if (success) {
          if (isValidArray(paths)) {
            handleFiles(paths as string[]);
          } else {
            messageApi?.info(t('clipboard.parse_clipboard_images_no_images'));
          }
        } else {
          messageApi?.error(
            t('clipboard.parse_clipboard_images_error', { error: error?.toString() }),
          );
        }
      } catch (error) {
        messageApi?.error(t('clipboard.parse_clipboard_images_error', { error: error.toString() }));
      } finally {
        messageApi?.destroy(messageKey);
      }
    };

    const setupPasteListener = () => {
      document.addEventListener('paste', handlePaste);
    };

    setupDragDrop();
    setupPasteListener();

    return () => {
      if (isFunction(dragDropController.current)) {
        dragDropController.current();
      }
      dragDropController.current = null;
      document.removeEventListener('paste', handlePaste);
    };
  }, []);

  useEffect(() => {
    r('classic_guide_imp');
  }, []);

  return (
    <div
      ref={dropzoneRef}
      className='group relative flex h-full flex-col items-center justify-center p-6 transition-all duration-300 [&.drag-active]:from-indigo-50/50 [&.drag-active]:to-indigo-100/50'
    >
      <UploadWidget />
      <div className='relative mt-4 text-center'>
        <p className='mx-auto max-w-2xl text-lg'>
          {t('page.compression.classic.upload_description')}
        </p>
      </div>

      <div className='relative w-full max-w-5xl'>
        <div className='flex flex-col gap-8 md:flex-row'>
          <div className='flex-1'>
            <div className='group relative flex flex-col items-center justify-center gap-6 p-8'>
              <div className='text-center'>
                <div className='flex flex-col items-center justify-center gap-3 sm:flex-row'>
                  <Button onClick={handleSelectFile} variant='secondary'>
                    <Upload size={18} />
                    {t('page.compression.classic.upload_file')}
                  </Button>
                  <Button
                    variant='secondary'
                    onClick={async () => {
                      try {
                        const files = await restoreVideoHistory();
                        if (!files.length) {
                          messageApi?.info(t('video.history_empty'));
                          return;
                        }
                        useCompressionStore.getState().setFiles(files);
                        useCompressionStore.getState().setWorking(true);
                        navigate('/compression/classic/workspace');
                      } catch (error) {
                        messageApi?.error(String(error));
                      }
                    }}
                  >
                    <History size={18} />
                    {t('video.history')}
                  </Button>
                  <Button onClick={handleSelectDirectory} variant='secondary'>
                    <Folder size={18} />
                    {t('page.compression.classic.upload_directory')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className='absolute bottom-2 right-2'>
        <FormatsTips />
      </div>
      <div className='pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-neutral-100/80 opacity-0 backdrop-blur-[2px] transition-opacity duration-200 dark:bg-neutral-800/80 [.drag-active_&]:opacity-100'></div>
    </div>
  );
}

export default ClassicCompressionGuide;
