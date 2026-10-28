import { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { UnlistenFn } from '@tauri-apps/api/event';
import { CompressionContext } from '.';
import { AppContext } from '@/routes';
import { useI18n } from '@/i18n';
import { VALID_MEDIA_EXTS } from '@/constants';
import { parsePaths } from '@/utils/fs';
import useCompressionStore from '@/store/compression';
import message from '@/components/message';

export const ClassicImportContext = createContext<{
  importFiles: (paths: string[] | null) => Promise<void>;
}>({ importFiles: async () => {} });

export default function ClassicCompressionLayout() {
  const { progressRef } = useContext(CompressionContext);
  const { messageApi } = useContext(AppContext);
  const t = useI18n();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const batchRevision = useCompressionStore((state) => state.batchRevision);
  const current = useRef({ pathname, navigate, t, messageApi });
  current.current = { pathname, navigate, t, messageApi };
  const dropzoneRef = useRef<HTMLDivElement>(null);
  const lifetime = useRef(0);
  const active = useRef(false);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const importFiles = useCallback(
    (paths: string[] | null) => {
      if (
        !paths?.length ||
        !active.current ||
        batchRevision !== useCompressionStore.getState().batchRevision
      )
        return Promise.resolve();
      const inputs = [...paths];
      const session = lifetime.current;
      const revision = batchRevision;
      const isCurrent = () =>
        active.current &&
        session === lifetime.current &&
        revision === useCompressionStore.getState().batchRevision;

      // Serialize native parsing too: a repeated video must not be registered twice.
      const importing = queue.current.then(async () => {
        if (!isCurrent()) return;
        progressRef.current?.show(true);
        try {
          const excludedPaths = new Set(useCompressionStore.getState().fileMap.keys());
          const files = await parsePaths(inputs, VALID_MEDIA_EXTS, excludedPaths, isCurrent);
          if (!isCurrent()) return;
          if (!files.length) {
            if (current.current.pathname === '/compression/classic/guide') {
              message.info({ title: current.current.t('common.no_image_to_compress') });
            }
            return;
          }
          const state = useCompressionStore.getState();
          state.appendFiles(files);
          state.setWorking(true);
          if (current.current.pathname === '/compression/classic/guide') {
            current.current.navigate('/compression/classic/workspace');
          }
        } catch (error) {
          if (isCurrent()) current.current.messageApi?.error(String(error));
        } finally {
          if (session === lifetime.current) progressRef.current?.done();
        }
      });
      queue.current = importing;
      return importing;
    },
    [progressRef, batchRevision],
  );
  const currentImport = useRef(importFiles);
  currentImport.current = importFiles;

  useEffect(() => {
    active.current = true;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (disposed) return;
        const dropzone = dropzoneRef.current;
        if (event.payload.type === 'enter') {
          dropzone?.classList.add('drag-active');
        } else if (event.payload.type === 'leave' || event.payload.type === 'drop') {
          dropzone?.classList.remove('drag-active');
          if (event.payload.type === 'drop') void currentImport.current(event.payload.paths);
        }
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error) => {
        if (!disposed) current.current.messageApi?.error(String(error));
      });
    return () => {
      disposed = true;
      active.current = false;
      lifetime.current++;
      unlisten?.();
      progressRef.current?.done();
    };
  }, [progressRef]);

  return (
    <ClassicImportContext.Provider value={{ importFiles }}>
      <div ref={dropzoneRef} className='group relative h-full'>
        <Outlet />
        <div className='pointer-events-none absolute inset-0 z-50 bg-neutral-100/80 opacity-0 backdrop-blur-[2px] transition-opacity duration-200 dark:bg-neutral-800/80 [.drag-active_&]:opacity-100' />
      </div>
    </ClassicImportContext.Provider>
  );
}
