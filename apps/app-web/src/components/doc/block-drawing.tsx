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
import type * as Y from 'yjs';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { DrawingCollaboration, drawingRegisters, projectDrawing } from '@use-brian/doc-model';

export const DrawingLibraryContext = createContext<Omit<LibraryTarget, 'block'> | null>(null);
export const DrawingPageContext = createContext<{ doc: Y.Doc; canEdit: boolean; provider?: HocuspocusProvider; connected?: boolean } | null>(null);

const DrawingEditor = lazy(() => import('./drawing-editor'));

export function BlockDrawing({ block: base, editable = false, onSave }: {
  block: DrawingBlock;
  editable?: boolean;
  onSave?: (next: DrawingBlock, original: DrawingBlock) => boolean;
}) {
  const t = useT().docPage.diagramSource;
  const { resolved } = useTheme();
  const libraryScope = useContext(DrawingLibraryContext);
  const page = useContext(DrawingPageContext);
  const authority = useRef(false);
  authority.current = editable && (!page || page.canEdit);
  const [block, setBlock] = useState(base);
  const [live, setLive] = useState<DrawingCollaboration | null>(null);
  useEffect(() => {
    const registers = page ? drawingRegisters(page.doc, base) : null;
    const refresh = () => {
      try {
        const next = registers ? projectDrawing(base, registers) : base;
        setBlock(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : {
          ...next, scene: JSON.stringify(previous.scene) === JSON.stringify(next.scene) ? previous.scene : next.scene,
        });
      }
      catch { setFailed(true); }
    };
    refresh();
    registers?.observe(refresh);
    return () => { registers?.unobserve(refresh); };
  }, [base, page?.doc]);
  const target = libraryScope ? { ...libraryScope, block: block.id } : undefined;
  const canvasHost = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<DrawingBlock | null>(null);
  const setDrawingActive = useContext(DrawingToolbarContext)?.setActive;
  const drawingOpen = draft !== null;
  useEffect(() => { if (block.collaborationError) setDraft(null); }, [block.collaborationError]);
  useEffect(() => {
    if (!drawingOpen || !page) return;
    const session = new DrawingCollaboration(page.doc, base, () => authority.current &&
      (!target || window.location.pathname === target.path));
    setLive(session);
    const check = () => { if (!session.valid()) setDraft(null); };
    page.doc.on('update', check);
    return () => { page.doc.off('update', check); session.dispose(); setLive(null); };
  }, [drawingOpen, page?.doc, base.scene, base.id]);
  useEffect(() => { if (page && !authority.current) setDraft(null); }, [editable, page?.canEdit]);
  useLayoutEffect(() => {
    if (!drawingOpen || !setDrawingActive) return;
    setDrawingActive(count => count + 1);
    return () => setDrawingActive(count => count - 1);
  }, [drawingOpen, setDrawingActive]);
  const [failed, setFailed] = useState(false);
  const scopeIdentity = `${libraryScope?.key}:${libraryScope?.path}:${block.id}`;
  const previousScope = useRef(scopeIdentity);
  const previewScene = useRef(block.scene);
  previewScene.current = block.scene;
  const requestPreview = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (previousScope.current !== scopeIdentity) {
      previousScope.current = scopeIdentity;
      setDraft(null);
    }
  }, [scopeIdentity]);
  useEffect(() => {
    if (drawingOpen) return;
    let active = true;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const host = canvasHost.current;
    setFailed(false);
    if (block.collaborationError) { host?.replaceChildren(); return; }
    async function preview() {
      const scene = drawingSceneSchema.parse(previewScene.current);
      if (!scene.elements.some(element => !element.isDeleted)) { host?.replaceChildren(); setFailed(false); return; }
      const { exportToCanvas, restoreElements } = await loadDrawingRuntime();
      const canvas = await exportToCanvas({
        elements: restoreElements(scene.elements as unknown as ExcalidrawElement[], null),
        appState: { ...scene.appState, exportWithDarkMode: resolved === 'dark' },
        files: scene.files as unknown as BinaryFiles,
        maxWidthOrHeight: 1600,
      });
      if (active) {
        setFailed(false);
        canvas.style.width = '100%';
        canvas.style.height = 'auto';
        canvas.style.maxHeight = '480px';
        canvas.style.objectFit = 'contain';
        host?.replaceChildren(canvas);
      }
    }
    const render = () => {
      if (pending || !active) return;
      pending = true;
      const run = async () => {
        const source = previewScene.current;
        try { await preview(); }
        catch { if (active) { host?.replaceChildren(); setFailed(true); } }
        finally {
          pending = false;
          if (active && source !== previewScene.current) render();
        }
      };
      if (page) timer = setTimeout(run, 120);
      else void run();
    };
    // Throttle, rather than debounce: continuous remote gestures must paint.
    requestPreview.current = render;
    render();
    return () => { active = false; clearTimeout(timer); requestPreview.current = null; host?.replaceChildren(); };
  }, [block.collaborationError, resolved, drawingOpen, page?.doc]);
  useEffect(() => { requestPreview.current?.(); }, [block.scene]);

  function save(scene: DrawingScene, preview?: DrawingPreview, title?: string) {
    if (!editable || !draft || !onSave || JSON.stringify(block) !== JSON.stringify(draft)) return false;
    if (!onSave({ ...draft, scene, preview, ...(title !== undefined ? { title } : {}) }, draft)) return false;
    setDraft(null);
    return true;
  }

  return <div className="rounded-lg border border-border p-2" contentEditable={false}>
    <div ref={canvasHost} role="img" aria-label={block.title?.trim() || t.drawing} />
    {failed && <p role="alert">{t.drawingFailed}</p>}
    {block.collaborationError && <p role="alert">{t.drawingError}</p>}
    <div className="flex items-center justify-between gap-2 p-1 text-sm">
      <span className="min-w-0 break-words">{block.title?.trim() || t.drawing}</span>
      {authority.current && !block.collaborationError && <button type="button" className="rounded px-3 py-2 text-primary hover:bg-muted" onClick={() => {
        if (!page && !drawingSceneSchema.safeParse(block.scene).success) { setFailed(true); return; }
        setDraft(structuredClone(block));
      }}>{t.drawingEdit}</button>}
    </div>
    {draft && <Suspense fallback={<p role="status">{t.drawingLoading}</p>}>
      {(!page || live) && <DrawingEditor key={scopeIdentity} scene={page ? block.scene : draft.scene} title={page ? block.title : draft.title} preview={block.preview} editable={authority.current} live={live ?? undefined} libraryTarget={target} onSave={save} onCancel={() => setDraft(null)} />}
    </Suspense>}
  </div>;
}
