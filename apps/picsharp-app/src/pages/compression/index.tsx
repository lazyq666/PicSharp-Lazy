import { useRef, createContext, useEffect } from 'react';
import { listenVideoJobs } from '@/utils/video';
import { Outlet } from 'react-router';
import { PageProgress, PageProgressRef } from '@/components/fullscreen-progress';
import { useI18n } from '@/i18n';

export const CompressionContext = createContext<{
  progressRef: React.RefObject<PageProgressRef>;
}>({
  progressRef: null,
});

export default function Compression() {
  const progressRef = useRef<PageProgressRef>(null);
  const t = useI18n();
  useEffect(() => {
    const listening = listenVideoJobs();
    return () => {
      listening.then((unlisten) => unlisten()).catch(console.error);
    };
  }, []);
  return (
    <CompressionContext.Provider value={{ progressRef }}>
      <div className='relative h-full overflow-auto'>
        <PageProgress ref={progressRef} description={t('tips.import_files')} />
        <Outlet />
      </div>
    </CompressionContext.Provider>
  );
}
