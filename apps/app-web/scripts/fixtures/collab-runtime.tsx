"use client";

import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { pageToYDoc, yDocToSnapshot, FRAGMENT_FIELD, docSchema } from '@use-brian/doc-model';
import { prosemirrorJSONToYDoc, ySyncPluginKey } from 'y-prosemirror';
import { DecorationSet } from '@tiptap/pm/view';
import { Node } from '@tiptap/pm/model';
import { CollabPageEditor } from '@/components/doc/collab-page-editor';
import { WorkspaceContextProvider } from '@/lib/workspace-context';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { syncCommentDraft } from '@/components/doc/comment-decorations';
import { setFindQuery } from '@/components/doc/find-in-page';
import required from 'collab-require-probe';

export default function Fixture() {
  const [bundles, setBundles] = useState<any[]>([]);
  const [active, setActive] = useState(0);
  const [mounted, setMounted] = useState(true);
  useEffect(() => {
    const socket = new HocuspocusProviderWebsocket({ url: 'ws://127.0.0.1:1', autoConnect: false });
    const encodingErrors: string[] = [];
    const docs = ['Alpha', 'Beta'].map(text => {
      try {
        return pageToYDoc({ blocks: [{ kind: 'text', id: text, text: `${text} collaborative document` }] }, text);
      } catch (error) {
        // Baseline only: record the encoder failure and independently exercise
        // the editor crash using synthetic Yjs XML, without the broken encoder.
        encodingErrors.push(String(error));
        const doc = new Y.Doc();
        const paragraph = new Y.XmlElement('paragraph');
        paragraph.insert(0, [new Y.XmlText(`${text} collaborative document`)]);
        doc.getXmlFragment(FRAGMENT_FIELD).insert(0, [paragraph]);
        return doc;
      }
    });
    const next = docs.map((doc, i) => ({ doc,
      provider: new HocuspocusProvider({ websocketProvider: socket, name: `synthetic-${i}`, document: doc }),
      synced: true, status: 'connected' as const,
    }));
    setBundles(next);
    const generated = new HocuspocusProvider({ websocketProvider: socket, name: 'constructor-probe' });
    let converted: Y.Doc | undefined;
    try { converted = prosemirrorJSONToYDoc(docSchema(), { type: 'doc' }); }
    catch (error) { encodingErrors.push(String(error)); }
    (window as any).collabProbe = {
      encodingErrors,
      identities: { modelDoc: encodingErrors.length === 0 && docs[0] instanceof Y.Doc, providerDoc: generated.document instanceof Y.Doc,
        converterDoc: converted instanceof Y.Doc, schemaNode: docSchema().topNodeType.create() instanceof Node,
        requireDoc: required.Doc === Y.Doc, requireDecoration: required.DecorationSet === DecorationSet, requireNode: required.Node === Node },
      switchDoc: () => setActive(i => 1 - i), toggle: () => setMounted(m => !m),
      snapshot: (i: number) => yDocToSnapshot(docs[i]),
      decorate: () => {
        const editor = (document.querySelector('.tiptap') as any).editor;
        if (ySyncPluginKey.getState(editor.state).type !== docs[(window as any).collabProbe.active ?? 0].getXmlFragment(FRAGMENT_FIELD)) throw new Error('wrong collaboration binding');
        syncCommentDraft(editor.view, { from: 1, to: 6 });
        setFindQuery(editor.view, 'collaborative');
        const sets: boolean[] = [];
        editor.view.someProp('decorations', (f: any) => {
          const set = f(editor.state);
          if (set) sets.push(set instanceof DecorationSet);
        });
        return sets;
      },
    };
    return () => { next.forEach(b => { b.provider.destroy(); b.doc.destroy(); }); generated.destroy(); generated.document.destroy(); converted?.destroy(); socket.destroy(); };
  }, []);
  // Update this closure without recreating the actual documents/providers.
  useEffect(() => { if ((window as any).collabProbe) (window as any).collabProbe.active = active; }, [active]);
  return <I18nProvider locale="en" dict={en}><WorkspaceContextProvider value={{ workspaceId: 'synthetic-workspace', name: 'Synthetic', role: 'owner', clearance: 'internal', me: { id: 'synthetic-user' } }}>
    <div data-active={active}>{mounted && bundles[active] && <CollabPageEditor collab={bundles[active]} />}</div>
  </WorkspaceContextProvider></I18nProvider>;
}
