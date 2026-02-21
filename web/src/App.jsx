import { useQuery } from '@tanstack/react-query';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import NewCollection from './pages/NewCollection';
import Explore from './pages/V2/FullScreenExplore';
import { apiService } from './lib/apiService';
import { queryKeys } from './query/keys';
import './App.css';

import 'react-element-forge/dist/style.css';
import './latentscope--brand-theme.scss';

const env = import.meta.env;
console.log('ENV', env);
const readonly = import.meta.env.MODE == 'read_only';
const docsUrl = 'https://enjalot.observablehq.cloud/latent-scope/';

function App() {
  const appConfigQuery = useQuery({
    queryKey: queryKeys.appConfig(),
    queryFn: ({ signal }) => apiService.fetchAppConfig({ signal }),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  if (readonly) {
    return (
      <div>
        <a className="docs-banner" href={docsUrl}>
          {' '}
          👉 Navigate to the documentation site
        </a>
        <iframe src={docsUrl} style={{ width: '100%', height: '100vh', border: 'none' }} />
      </div>
    );
  }
  const appConfig =
    appConfigQuery.data ??
    (appConfigQuery.isError
      ? {
          mode: 'hosted',
          read_only: false,
          features: {
            can_explore: true,
            can_ingest: true,
            can_compare: false,
            can_setup: false,
            can_jobs: false,
            can_export: false,
            can_settings: false,
            twitter_import: true,
            generic_file_ingest: false,
          },
          limits: {
            max_upload_mb: null,
          },
          public_dataset_id: null,
          public_scope_id: null,
        }
      : null);

  if (!appConfig) {
    return <div>Loading...</div>;
  }

  const isSingleProfile = appConfig.mode === 'single_profile';
  const publicPath =
    appConfig.public_dataset_id && appConfig.public_scope_id
      ? `/datasets/${appConfig.public_dataset_id}/explore/${appConfig.public_scope_id}`
      : null;

  return (
    <Router basename={env.BASE_NAME}>
      <div className="page">
        <Routes>
          {isSingleProfile ? (
            <>
              {publicPath ? (
                <>
                  <Route path="/" element={<Navigate to={publicPath} replace />} />
                  <Route path={publicPath} element={<Explore />} />
                  <Route path="*" element={<Navigate to={publicPath} replace />} />
                </>
              ) : (
                <>
                  <Route path="/" element={<div>Missing public scope config</div>} />
                  <Route path="*" element={<div>Missing public scope config</div>} />
                </>
              )}
            </>
          ) : (
            <>
              <Route path="/" element={<Dashboard appConfig={appConfig} />} />
              <Route path="/new" element={<NewCollection appConfig={appConfig} />} />
              <Route path="/import" element={<Navigate to="/new" replace />} />
              <Route path="/datasets/:dataset/explore/:scope" element={<Explore />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </>
          )}
        </Routes>
      </div>
    </Router>
  );
}

export default App;
