import type { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { yUndoPluginKey } from 'y-prosemirror';
import { drawingBlockSchema, type DrawingBlock } from '@use-brian/shared/drawing';

export function saveDrawing(editor: Editor, getPos: () => number | undefined, next: DrawingBlock, original: DrawingBlock): boolean {
  if (!editor.isEditable || editor.isDestroyed || !drawingBlockSchema.safeParse(next).success) return false;
  const pos = getPos();
  if (typeof pos !== 'number') return false;
  const current = editor.state.doc.nodeAt(pos);
  if (current?.type.name !== 'embed' || current.attrs.blockId !== original.id ||
    next.id !== original.id || current.attrs.block !== JSON.stringify(original)) return false;
  // A Save is one page undo step, separate from adjacent prose edits. Drawing
  // gestures have their own editor history and never reach this transaction.
  const undoManager = yUndoPluginKey.getState(editor.state)?.undoManager;
  undoManager?.stopCapturing();
  editor.view.dispatch(closeHistory(editor.state.tr).setNodeMarkup(pos, undefined, {
    ...current.attrs, block: JSON.stringify(next),
  }));
  undoManager?.stopCapturing();
  return true;
}
