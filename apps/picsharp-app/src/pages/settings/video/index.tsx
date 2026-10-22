import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { Folder, RefreshCw, X } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SettingsKey, VideoPreset } from '@/constants';
import useSettingsStore from '@/store/settings';
import useSelector from '@/hooks/useSelector';
import { useI18n } from '@/i18n';
import Section from '../section';
import SettingItem from '../setting-item';

export default function SettingsVideo() {
  const t = useI18n();
  const {
    video_preset: preset,
    video_output_folder: folder,
    set,
  } = useSettingsStore(
    useSelector([SettingsKey.VideoPreset, SettingsKey.VideoOutputFolder, 'set']),
  );
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const checkEngine = async () => {
    setChecking(true);
    try {
      await invoke('ipc_video_engine_status');
      setReady(true);
      setError('');
    } catch (error) {
      setReady(false);
      setError(String(error));
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    checkEngine();
  }, []);
  return (
    <Section>
      <Card>
        <SettingItem title={t('video.preset')}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <Select
                  value={preset}
                  onValueChange={(value: VideoPreset) => set(SettingsKey.VideoPreset, value)}
                >
                  <SelectTrigger className='min-w-[180px]'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['compact', 'balanced', 'compatible'] as const).map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`video.preset.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </TooltipTrigger>
            <TooltipContent className='max-w-xs'>
              {t(`video.preset.${preset}.detail`)}
            </TooltipContent>
          </Tooltip>
        </SettingItem>
        <SettingItem title={t('video.output')}>
          <div className='flex items-center gap-1'>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant='outline'
                  className='max-w-[260px]'
                  onClick={async () => {
                    const path = await open({ directory: true, multiple: false });
                    if (path) await set(SettingsKey.VideoOutputFolder, path);
                  }}
                >
                  <Folder className='h-4 w-4 shrink-0' />
                  <span className='truncate'>
                    {folder
                      ? folder.split(/[/\\]/).filter(Boolean).pop()
                      : t('video.output.default')}
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent className='max-w-sm break-all'>
                {folder || t('video.output.protection')}
              </TooltipContent>
            </Tooltip>
            {folder && (
              <Button
                variant='ghost'
                size='icon'
                aria-label={t('video.output.reset')}
                onClick={() => set(SettingsKey.VideoOutputFolder, '')}
              >
                <X className='h-4 w-4' />
              </Button>
            )}
          </div>
        </SettingItem>
      </Card>
      <Card>
        <SettingItem title={t('video.engine')} description={error || undefined}>
          <div className='flex items-center gap-2'>
            <Badge variant={ready ? 'success' : 'minor'}>
              {checking
                ? t('video.engine.checking')
                : ready
                  ? t('video.engine.ready')
                  : t('video.engine.unavailable')}
            </Badge>
            <Button
              variant='ghost'
              size='icon'
              disabled={checking}
              onClick={checkEngine}
              aria-label={t('video.engine.check')}
            >
              <RefreshCw className={`h-4 w-4 ${checking ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </SettingItem>
      </Card>
    </Section>
  );
}
