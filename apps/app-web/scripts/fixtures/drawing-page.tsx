import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { CollabPageEditor } from '@/components/doc/collab-page-editor';
import { useCollabProvider } from '@/lib/collab/use-collab-provider';
import { WorkspaceContextProvider } from '@/lib/workspace-context';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { ThemeProvider } from '@/lib/theme';
import { yDocToSnapshot } from '@use-brian/doc-model';
import './drawing-library-browser.css';

function Page() {
  const collab = useCollabProvider('page');
  Object.assign(window, { pageProbe: { collab, snapshot: () => collab.doc && yDocToSnapshot(collab.doc) } });
  return <CollabPageEditor collab={collab} viewId="page" canEdit={!new URLSearchParams(location.search).has('readonly')}
    user={{ id: 'same-account', name: 'Synthetic editor' }} />;
}

createRoot(document.getElementById('root')!).render(<StrictMode><MemoryRouter>
  <I18nProvider locale="en" dict={en}><ThemeProvider>
    <WorkspaceContextProvider value={{ workspaceId: 'workspace', name: 'Synthetic', role: 'owner', clearance: 'internal', me: { id: 'same-account' } }}>
      <Page />
    </WorkspaceContextProvider>
  </ThemeProvider></I18nProvider>
</MemoryRouter></StrictMode>);
