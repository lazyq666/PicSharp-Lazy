import { memo } from 'react';
import { useI18n } from '@/i18n';
import useSettingsStore from '@/store/settings';
import useSelector from '@/hooks/useSelector';
import { SettingsKey } from '@/constants';
import SettingItem from '../setting-item';
import { Switch } from '@/components/ui/switch';
import { PathTagsInput } from '@/components/path-tags-input';

function SettingsCompressionWatchIgnore() {
  const t = useI18n();
  const {
    compression_watch_file_ignore: ignores = [],
    compression_watch_ignore_nine_patch: ignoreNinePatch = true,
    set,
  } = useSettingsStore(
    useSelector([
      SettingsKey.CompressionWatchFileIgnore,
      SettingsKey.CompressionWatchIgnoreNinePatch,
      'set',
    ]),
  );

  return (
    <>
      <SettingItem
        title={t('settings.compression.ignore_nine_patch.title')}
        description={t('settings.compression.ignore_nine_patch.description')}
      >
        <Switch
          aria-label={t('settings.compression.ignore_nine_patch.title')}
          checked={ignoreNinePatch}
          onCheckedChange={(checked) => set(SettingsKey.CompressionWatchIgnoreNinePatch, checked)}
        />
      </SettingItem>
      <SettingItem
        title={t('settings.compression.file_ignore.title')}
        description={t('settings.compression.file_ignore.description')}
      >
        <PathTagsInput
          title={t('settings.compression.file_ignore.title')}
          value={ignores}
          onChange={(value) => {
            set(SettingsKey.CompressionWatchFileIgnore, value);
          }}
          className='max-h-[100px] w-[350px] overflow-y-auto'
        />
      </SettingItem>
    </>
  );
}

export default memo(SettingsCompressionWatchIgnore);
