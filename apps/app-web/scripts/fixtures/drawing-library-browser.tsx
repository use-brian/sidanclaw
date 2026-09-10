import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { ThemeProvider } from '@/lib/theme';
import { BlockDrawing, DrawingLibraryContext } from '@/components/doc/block-drawing';
import { libraryKey } from '@/components/doc/drawing-library';
import './drawing-library-browser.css';

const scope = { key: libraryKey('https://api.example.com', 'account', 'workspace'), account: 'account', path: '/w/workspace/p/page' };
Object.assign(window, { scope });
createRoot(document.getElementById('root')!).render(<StrictMode><I18nProvider locale="en" dict={en}>
  <ThemeProvider><DrawingLibraryContext.Provider value={scope}><BlockDrawing editable
    block={{ kind: 'drawing', id: 'drawing', scene: { version: 1, elements: [], files: {}, appState: { viewBackgroundColor: '#fff' } } }}
    onSave={() => { throw new Error('Catalog import must not save the drawing'); }} />
  </DrawingLibraryContext.Provider></ThemeProvider>
</I18nProvider></StrictMode>);
