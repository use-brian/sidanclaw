"use client";

import { createContext, lazy, Suspense, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFiles } from '@excalidraw/excalidraw/types';
import { drawingSceneSchema, type DrawingBlock, type DrawingScene, type DrawingPreview } from '@use-brian/shared/drawing';
import { useT } from '@/lib/i18n/client';
import { useTheme } from '@/lib/theme';
import { loadDrawingRuntime } from './drawing-runtime';
import type { LibraryTarget } from './drawing-library';
import { DrawingToolbarContext } from './floating-toolbar';

export const DrawingLibraryContext = createContext<Omit<LibraryTarget, 'block'> | null>(null);

const DrawingEditor = lazy(() => import('./drawing-editor'));

export function BlockDrawing({ block, editable = false, onSave }: {
  block: DrawingBlock;
  editable?: boolean;
  onSave?: (next: DrawingBlock, original: DrawingBlock) => boolean;
}) {
  const t = useT().docPage.diagramSource;
  const { resolved } = useTheme();
  const libraryScope = useContext(DrawingLibraryContext);
  const target = libraryScope ? { ...libraryScope, block: block.id } : undefined;
  const canvasHost = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<DrawingBlock | null>(null);
  const setDrawingActive = useContext(DrawingToolbarContext)?.setActive;
  const drawingOpen = draft !== null;
  useLayoutEffect(() => {
    if (!drawingOpen || !setDrawingActive) return;
    setDrawingActive(count => count + 1);
    return () => setDrawingActive(count => count - 1);
  }, [drawingOpen, setDrawingActive]);
  const [failed, setFailed] = useState(false);
  const scopeIdentity = `${libraryScope?.key}:${libraryScope?.path}:${block.id}`;
  const previousScope = useRef(scopeIdentity);
  useEffect(() => {
    if (previousScope.current !== scopeIdentity) {
      previousScope.current = scopeIdentity;
      setDraft(null);
    }
  }, [scopeIdentity]);
  useEffect(() => {
    let active = true;
    const host = canvasHost.current;
    host?.replaceChildren();
    setFailed(false);
    async function preview() {
      const scene = drawingSceneSchema.parse(block.scene);
      if (!scene.elements.some(element => !element.isDeleted)) return;
      const { exportToCanvas, restoreElements } = await loadDrawingRuntime();
      const canvas = await exportToCanvas({
        elements: restoreElements(scene.elements as unknown as ExcalidrawElement[], null),
        appState: { ...scene.appState, exportWithDarkMode: resolved === 'dark' },
        files: scene.files as unknown as BinaryFiles,
        maxWidthOrHeight: 1600,
      });
      if (active) {
        canvas.style.width = '100%';
        canvas.style.height = 'auto';
        canvas.style.maxHeight = '480px';
        canvas.style.objectFit = 'contain';
        host?.replaceChildren(canvas);
      }
    }
    void preview().catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [block.scene, resolved]);

  function save(scene: DrawingScene, preview?: DrawingPreview, title?: string) {
    if (!editable || !draft || !onSave || JSON.stringify(block) !== JSON.stringify(draft)) return false;
    if (!onSave({ ...draft, scene, preview, ...(title !== undefined ? { title } : {}) }, draft)) return false;
    setDraft(null);
    return true;
  }

  return <div className="rounded-lg border border-border p-2" contentEditable={false}>
    <div ref={canvasHost} role="img" aria-label={block.title?.trim() || t.drawing} />
    {failed && <p role="alert">{t.drawingFailed}</p>}
    <div className="flex items-center justify-between gap-2 p-1 text-sm">
      <span className="min-w-0 break-words">{block.title?.trim() || t.drawing}</span>
      {editable && <button type="button" className="rounded px-3 py-2 text-primary hover:bg-muted" onClick={() => {
        if (!drawingSceneSchema.safeParse(block.scene).success) { setFailed(true); return; }
        setDraft(structuredClone(block));
      }}>{t.drawingEdit}</button>}
    </div>
    {draft && <Suspense fallback={<p role="status">{t.drawingLoading}</p>}>
      <DrawingEditor key={scopeIdentity} scene={draft.scene} title={draft.title} preview={draft.preview} editable={editable} libraryTarget={target} onSave={save} onCancel={() => setDraft(null)} />
    </Suspense>}
  </div>;
}
