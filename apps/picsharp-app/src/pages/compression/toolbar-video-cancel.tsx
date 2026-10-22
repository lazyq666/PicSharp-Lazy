import { useEffect } from 'react';
import { useUpdate } from 'ahooks';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import useCompressionStore from '@/store/compression';
import { ICompressor } from '@/utils/compressor';
import { cancelVideo } from '@/utils/video';
import { useI18n } from '@/i18n';

export default function ToolbarVideoCancel() {
  const update = useUpdate();
  const files = useCompressionStore((state) => state.files);
  const events = useCompressionStore((state) => state.eventEmitter);
  const t = useI18n();
  useEffect(() => {
    events.on('update_file_item', update);
    return () => {
      events.off('update_file_item', update);
    };
  }, [events]);
  const active = files.filter(
    (file) => file.mediaType === 'video' && file.status === ICompressor.Status.Processing,
  );
  if (!active.length) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant='ghost'
          size='icon'
          aria-label={t('video.cancel_all')}
          disabled={active.some((file) => !['pending', 'processing'].includes(file.videoPhase))}
          onClick={() => {
            void Promise.all(active.map((file) => cancelVideo(file.path))).catch(console.error);
          }}
        >
          <X className='h-4 w-4' />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('video.cancel_all')}</TooltipContent>
    </Tooltip>
  );
}
