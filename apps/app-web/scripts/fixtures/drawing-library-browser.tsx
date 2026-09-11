import { StrictMode, useEffect, useState } from 'react';
import { Editor } from '@tiptap/core';
import { docExtensions } from '@use-brian/doc-model';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { ThemeProvider } from '@/lib/theme';
import { BlockDrawing, DrawingLibraryContext } from '@/components/doc/block-drawing';
import { libraryKey } from '@/components/doc/drawing-library';
import { DrawingToolbarProvider, FloatingToolbar } from '@/components/doc/floating-toolbar';
import './drawing-library-browser.css';

const scope = { key: libraryKey('https://api.example.com', 'account', 'workspace'), account: 'account', path: '/w/workspace/p/page' };
Object.assign(window, { scope });
function HostToolbar({ children }: { children: React.ReactNode }) {
  const [editor, setEditor] = useState<Editor | null>(null);
  useEffect(() => {
    const editor = new Editor({ extensions: docExtensions(), content: '<p>Host page text</p>' });
    editor.commands.setTextSelection({ from: 1, to: 5 });
    setEditor(editor);
    Object.assign(window, { hostEditor: editor });
    return () => { editor.destroy(); };
  }, []);
  return <DrawingToolbarProvider><FloatingToolbar editor={editor} onComment={() => {}} />{children}</DrawingToolbarProvider>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><I18nProvider locale="en" dict={en}>
  <ThemeProvider><HostToolbar><DrawingLibraryContext.Provider value={scope}><BlockDrawing editable
    block={{ kind: 'drawing', id: 'drawing', scene: { version: 1, elements: [], files: {}, appState: { viewBackgroundColor: '#fff' } } }}
    onSave={() => { throw new Error('Catalog import must not save the drawing'); }} />
  </DrawingLibraryContext.Provider></HostToolbar></ThemeProvider>
</I18nProvider></StrictMode>);
