// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { DecorationSet } from '@tiptap/pm/view';
import { Node } from '@tiptap/pm/model';
import { ySyncPluginKey } from 'y-prosemirror';
import { docExtensions, docSchema, FRAGMENT_FIELD, pageToYDoc, yDocToSnapshot } from '@use-brian/doc-model';
import { createCommentDecorationsExtension, syncCommentDraft } from '../comment-decorations';
import { docFindExtension, setFindQuery } from '../find-in-page';

describe('[COMP:app-web/collab-runtime] real collaboration constructors', () => {
  it('renders doc-model Y.Docs, edits with multiple decorations and remounts without crossing documents', () => {
    const socket = new HocuspocusProviderWebsocket({ url: 'ws://127.0.0.1:1', autoConnect: false });
    const generated = new HocuspocusProvider({ websocketProvider: socket, name: 'constructor' });
    const docs = ['Alpha', 'Beta'].map(text => pageToYDoc({ blocks: [
      { kind: 'text', id: text, text: `${text} collaborative document` },
    ] }, text));
    let editor: Editor | undefined;
    const providers = docs.map((document, i) => new HocuspocusProvider({ websocketProvider: socket, name: `synthetic-${i}`, document }));
    try {
      expect(generated.document).toBeInstanceOf(Y.Doc);
      expect(docSchema().topNodeType.create()).toBeInstanceOf(Node);
      for (let round = 0; round < 4; round++) {
        const index = round % 2;
        const doc = docs[index];
        expect(doc).toBeInstanceOf(Y.Doc);
        const otherBefore = yDocToSnapshot(docs[1 - index]);
        editor = new Editor({ extensions: [
          ...docExtensions(), Collaboration.configure({ document: doc, field: FRAGMENT_FIELD }),
          CollaborationCursor.configure({ provider: providers[index], user: { name: 'Synthetic', color: '#123456' } }),
          createCommentDecorationsExtension({ onOpenThread() {} }), docFindExtension(),
        ] });
        expect(ySyncPluginKey.getState(editor.state).type).toBe(doc.getXmlFragment(FRAGMENT_FIELD));
        syncCommentDraft(editor.view, { from: 1, to: 6 });
        setFindQuery(editor.view, 'collaborative');
        const sets: unknown[] = [];
        editor.view.someProp('decorations', f => { const set = f(editor!.state); if (set) sets.push(set); });
        expect(sets.length).toBeGreaterThanOrEqual(2);
        sets.forEach(set => expect(set).toBeInstanceOf(DecorationSet));
        expect(editor.view.dom.querySelector('[data-comment-draft]')).not.toBeNull();
        editor.commands.insertContentAt(1, `edit${round} `);
        expect(JSON.stringify(yDocToSnapshot(doc))).toContain(`edit${round}`);
        expect(yDocToSnapshot(docs[1 - index])).toEqual(otherBefore);
        editor.destroy();
      }
      expect(JSON.stringify(yDocToSnapshot(docs[0]))).toContain('edit0');
      expect(JSON.stringify(yDocToSnapshot(docs[1]))).toContain('edit1');
    } finally {
      editor?.destroy();
      providers.forEach(provider => provider.destroy());
      generated.destroy();
      generated.document.destroy();
      docs.forEach(doc => doc.destroy());
      socket.destroy();
    }
  });
});
