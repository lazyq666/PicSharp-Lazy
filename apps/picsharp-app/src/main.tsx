import './utils/apm';
import './utils/tray';
import './utils/menu';
import './i18n';
import './store/settings';
import './index.css';
import { AptabaseProvider } from '@aptabase/react';
import { isDev } from './utils';
import ReactDOM from 'react-dom/client';
import App from './App';

const app = <App />;

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  __PICSHARP_ABE_KEY__ ? (
    <AptabaseProvider
      appKey={__PICSHARP_ABE_KEY__}
      options={{ isDebug: isDev, appVersion: __PICSHARP_VERSION__ }}
    >
      {app}
    </AptabaseProvider>
  ) : (
    app
  ),
);
