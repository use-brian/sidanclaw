"use client";

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFiles } from '@excalidraw/excalidraw/types';
import { drawingSceneSchema, type DrawingBlock, type DrawingScene } from '@use-brian/shared/drawing';
import { useT } from '@/lib/i18n/client';
import { useTheme } from '@/lib/theme';
import { loadDrawingRuntime } from './drawing-runtime';

const DrawingEditor = lazy(() => import('./drawing-editor'));

export function BlockDrawing({ block, editable = false, onSave }: {
  block: DrawingBlock;
  editable?: boolean;
  onSave?: (next: DrawingBlock, original: DrawingBlock) => boolean;
}) {
  const t = useT().docPage.diagramSource;
  const { resolved } = useTheme();
  const canvasHost = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<DrawingBlock | null>(null);
  const [failed, setFailed] = useState(false);
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

  function save(scene: DrawingScene) {
    if (!editable || !draft || !onSave || JSON.stringify(block) !== JSON.stringify(draft)) return false;
    if (!onSave({ ...draft, scene }, draft)) return false;
    setDraft(null);
    return true;
  }

  return <div className="rounded-lg border border-border p-2" contentEditable={false}>
    <div ref={canvasHost} role="img" aria-label={t.drawing} />
    {failed && <p role="alert">{t.drawingFailed}</p>}
    <div className="flex items-center justify-between gap-2 p-1 text-sm">
      <span>{t.drawing}</span>
      {editable && <button type="button" className="rounded px-3 py-2 text-primary hover:bg-muted" onClick={() => {
        if (!drawingSceneSchema.safeParse(block.scene).success) { setFailed(true); return; }
        setDraft(structuredClone(block));
      }}>{t.drawingEdit}</button>}
    </div>
    {draft && <Suspense fallback={<p role="status">{t.drawingLoading}</p>}>
      <DrawingEditor scene={draft.scene} editable={editable} onSave={save} onCancel={() => setDraft(null)} />
    </Suspense>}
  </div>;
}
