import { StrictMode, useEffect, useState } from 'react';
import { Editor } from '@tiptap/core';
import { DrawingCollaboration, docExtensions, pageToYDocUpdate, yDocToSnapshot, snapshotFromUpdate, findDrawing, applyOpsToYDoc } from '@use-brian/doc-model';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { ThemeProvider } from '@/lib/theme';
import { BlockDrawing, DrawingLibraryContext, DrawingPageContext } from '@/components/doc/block-drawing';
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
const block = { kind: 'drawing' as const, id: 'drawing', scene: { version: 1 as const, elements: [], files: {}, appState: { viewBackgroundColor: '#fff' } } };
const liveDoc = new Y.Doc();
const seeded = new URLSearchParams(location.search).has('seed') ? { ...block, scene: { ...block.scene,
  elements: [{ id: 'saved-shape', type: 'rectangle' as const, x: 20, y: 20, width: 100, height: 80 }] } } : block;
Y.applyUpdate(liveDoc, pageToYDocUpdate({ blocks: [seeded, { kind: 'text', id: 'text', text: 'Host text' }] }, 'Test'));
function LiveDrawing() {
  const [editable, setEditable] = useState(true);
  const [drawingId, setDrawingId] = useState('drawing');
  const [mounted, setMounted] = useState(true);
  const [provider, setProvider] = useState<HocuspocusProvider>();
  const [connected, setConnected] = useState(false);
  useEffect(() => () => provider?.destroy(), [provider]);
  const [current, setCurrent] = useState(() => findDrawing(liveDoc, 'drawing'));
  useEffect(() => {
    const refresh = () => setCurrent(findDrawing(liveDoc, drawingId));
    refresh();
    liveDoc.on('update', refresh);
    Object.assign(window, { drawingTest: {
      connect: (url: string) => {
        const peer = new HocuspocusProvider({ url, name: 'drawing-test', document: liveDoc,
          onStatus: ({ status }) => setConnected(status === 'connected') });
        peer.awareness?.setLocalStateField('user', { id: 'same-account', name: 'Synthetic editor', color: '#3E63DD' });
        peer.awareness?.setLocalStateField('cursor', { anchor: 'host-cursor' });
        Object.assign(window, { drawingProvider: peer });
        setProvider(peer);
      },
      encode: () => [...Y.encodeStateAsUpdate(liveDoc)],
      receive: (bytes: number[]) => Y.applyUpdate(liveDoc, new Uint8Array(bytes)),
      snapshot: () => yDocToSnapshot(liveDoc),
      persistedSnapshot: () => snapshotFromUpdate(Y.encodeStateAsUpdate(liveDoc)),
      oversizedUnion: () => {
        const peers = [new Y.Doc(), new Y.Doc()];
        const seed = Y.encodeStateAsUpdate(liveDoc);
        for (const [index, peer] of peers.entries()) {
          Y.applyUpdate(peer, seed);
          const base = findDrawing(peer, 'drawing')!;
          const drawing = new DrawingCollaboration(peer, base, () => true);
          drawing.write(base.scene, { ...base.scene, elements: Array.from({ length: 2501 }, (_, i) => ({
            id: `peer-${index}-${i}`, type: 'rectangle', x: (i % 50) * 4, y: Math.floor(i / 50) * 4, width: 2, height: 2,
          })) });
          drawing.dispose();
        }
        for (const peer of peers) { Y.applyUpdate(liveDoc, Y.encodeStateAsUpdate(peer)); peer.destroy(); }
      },
      elementWrites: () => [...liveDoc.share.keys()].filter(key => key.startsWith('drawing:')).flatMap(key => [...liveDoc.getMap(key).keys()].filter(key => key.startsWith('element:'))),
      permission: setEditable,
      showDrawing: (id: string) => {
        if (!findDrawing(liveDoc, id)) applyOpsToYDoc(liveDoc, [{ op: 'add', after: 'end', block: { ...block, id } }]);
        setDrawingId(id);
      },
      route: () => { history.pushState(null, '', '/w/workspace/p/other'); setMounted(false); },
      replace: () => applyOpsToYDoc(liveDoc, [{ op: 'edit', blockId: 'drawing', patch: { scene: block.scene } }]),
      delete: () => applyOpsToYDoc(liveDoc, [{ op: 'delete', blockId: 'drawing' }]),
      text: () => applyOpsToYDoc(liveDoc, [{ op: 'edit', blockId: 'text', patch: { text: 'Changed text' } }]),
    } });
    return () => { liveDoc.off('update', refresh); };
  }, [drawingId]);
  return <DrawingPageContext.Provider value={{ doc: liveDoc, canEdit: editable, provider, connected }}>
    {current && mounted && <BlockDrawing key={current.id} editable={editable} block={current} />}
  </DrawingPageContext.Provider>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><I18nProvider locale="en" dict={en}>
  <ThemeProvider><HostToolbar><DrawingLibraryContext.Provider value={scope}>{new URLSearchParams(location.search).has('live') ? <LiveDrawing /> : <BlockDrawing editable
    block={{ kind: 'drawing', id: 'drawing', scene: { version: 1, elements: [], files: {}, appState: { viewBackgroundColor: '#fff' } } }}
    onSave={() => { throw new Error('Catalog import must not save the drawing'); }} />}
  </DrawingLibraryContext.Provider></HostToolbar></ThemeProvider>
</I18nProvider></StrictMode>);
