// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Editor, Extension } from '@tiptap/core';
import { ySyncPlugin } from 'y-prosemirror';
import { DrawingCollaboration, docExtensions, pageToYDoc, yDocToSnapshot } from '@use-brian/doc-model';
import { browserDocExtensions } from '../doc-schema';
import { duplicateBlockAt } from '../block-actions';

describe('[COMP:app-web/drawing] canonical copy boundaries', () => {
  it('copies and duplicates live geometry rather than stale attrs, without sharing the duplicate map', () => {
    const base = { kind: 'drawing' as const, id: 'drawing', scene: { version: 1 as const,
      elements: [{ id: 'shape', type: 'rectangle' as const, x: 0, y: 0, width: 50, height: 50 }],
      files: {}, appState: { viewBackgroundColor: '#fff' } } };
    const doc = pageToYDoc({ blocks: [base] }, 'Page');
    const live = new DrawingCollaboration(doc, base, () => true);
    const bridge = Extension.create({ name: 'testDrawingBridge', addProseMirrorPlugins: () => [ySyncPlugin(doc.getXmlFragment('default'))] });
    const clipboard = browserDocExtensions().find(extension => extension.name === 'drawingClipboard')!;
    const editor = new Editor({ extensions: [...docExtensions(), clipboard, bridge] });
    try {
      live.write(base.scene, { ...base.scene, elements: [{ ...base.scene.elements[0], x: 99 }] });
      expect(JSON.parse(editor.state.doc.firstChild!.attrs.block).scene.elements[0].x).toBe(0);
      let copied = editor.state.doc.slice(0, editor.state.doc.firstChild!.nodeSize);
      editor.view.someProp('transformCopied', transform => { copied = transform(copied, editor.view); });
      expect(JSON.parse(copied.content.firstChild!.attrs.block).scene.elements[0].x).toBe(99);
      expect(copied.content.firstChild!.attrs.blockId).not.toBe(base.id);
      editor.view.someProp('handleDOMEvents', handlers => { handlers.dragstart?.(editor.view, new MouseEvent('dragstart') as DragEvent); });
      let moved = editor.state.doc.slice(0, editor.state.doc.firstChild!.nodeSize);
      editor.view.someProp('transformCopied', transform => { moved = transform(moved, editor.view); });
      expect(moved.content.firstChild!.attrs.blockId).toBe(base.id);
      expect(JSON.parse(moved.content.firstChild!.attrs.block).scene.elements[0].x).toBe(0);
      expect(duplicateBlockAt(editor, 0)).toBe(true);
      const drawings = () => yDocToSnapshot(doc).page.blocks.filter(block => block.kind === 'drawing');
      expect(drawings()).toHaveLength(2);
      expect(drawings()[1].id).not.toBe(base.id);
      expect(drawings()[1].scene.elements[0].x).toBe(99);
      const before = live.read().scene;
      live.write(before, { ...before, elements: [{ ...before.elements[0], x: 123 }] });
      expect(drawings().map(block => block.scene.elements[0].x)).toEqual([123, 99]);
    } finally { editor.destroy(); live.dispose(); doc.destroy(); }
  });
});
