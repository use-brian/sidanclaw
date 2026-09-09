"use client";

import { useEffect, useRef, useState } from 'react';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFiles } from '@excalidraw/excalidraw/types';
import { Dialog } from '@base-ui/react/dialog';
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';
import { drawingSceneSchema, drawingPreviewSchema, drawingSceneDigest, MAX_DRAWING_PREVIEW_DIMENSION, type DrawingScene, type DrawingPreview } from '@use-brian/shared/drawing';
import { useLocale, useT } from '@/lib/i18n/client';
import { useTheme } from '@/lib/theme';
import { Button } from '@/components/ui/button';
import { loadDrawingRuntime } from './drawing-runtime';
import '@excalidraw/excalidraw/index.css';

export default function DrawingEditor({ scene, editable, onSave, onCancel }: {
  scene: DrawingScene;
  editable: boolean;
  onSave: (scene: DrawingScene, preview?: DrawingPreview) => boolean;
  onCancel: () => void;
}) {
  const t = useT().docPage.diagramSource;
  const locale = useLocale();
  const { resolved } = useTheme();
  const [runtime, setRuntime] = useState<Awaited<ReturnType<typeof loadDrawingRuntime>> | null>(null);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const latest = useRef({ editable, onSave, mounted: true });
  latest.current = { editable, onSave, mounted: latest.current.mounted };
  useEffect(() => { latest.current.mounted = true; return () => { latest.current.mounted = false; }; }, []);
  const [initial] = useState(() => structuredClone(scene));
  useEffect(() => {
    let active = true;
    loadDrawingRuntime().then(value => { if (active) setRuntime(value); })
      .catch(() => { if (active) setError(t.drawingFailed); });
    return () => { active = false; };
  }, [t.drawingFailed]);

  async function save() {
    if (!editable || !api || !runtime || saving) return;
    const elements = api.getSceneElements();
    const fileIds = new Set<string>();
    for (const element of elements) {
      if (element.type === 'image' && !element.isDeleted && element.fileId) fileIds.add(element.fileId);
    }
    // Excalidraw retains deleted assets for its local undo history. Persist
    // only live references so deleting an unsupported/oversized image recovers.
    const files = Object.fromEntries(Object.entries(api.getFiles()).filter(([id]) => fileIds.has(id)));
    const result = drawingSceneSchema.safeParse({
      version: 1,
      elements,
      appState: { viewBackgroundColor: api.getAppState().viewBackgroundColor },
      files,
    });
    if (!result.success) { setError(t.drawingError); return; }
    if (!result.data.elements.some(element => !element.isDeleted)) {
      if (!onSave(result.data)) setError(t.drawingConflict);
      return;
    }
    setSaving(true);
    try {
      const canvas = await runtime.exportToCanvas({
        elements: runtime.restoreElements(result.data.elements as unknown as ExcalidrawElement[], null),
        appState: { ...result.data.appState, exportWithDarkMode: false, exportBackground: true },
        files: result.data.files as unknown as BinaryFiles,
        maxWidthOrHeight: MAX_DRAWING_PREVIEW_DIMENSION,
      });
      const preview = drawingPreviewSchema.parse({ mimeType: 'image/png',
        data: canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''),
        width: canvas.width, height: canvas.height, sceneDigest: await drawingSceneDigest(result.data) });
      if (!latest.current.mounted) return;
      if (!latest.current.editable || !latest.current.onSave(result.data, preview)) setError(t.drawingConflict);
    } catch { if (latest.current.mounted) setError(t.drawingFailed); }
    finally { if (latest.current.mounted) setSaving(false); }
  }

  return <Dialog.Root open onOpenChange={(open) => { if (!open) onCancel(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-background/80" />
      <Dialog.Popup
        className="fixed inset-0 z-50 flex flex-col bg-background text-foreground sm:inset-4 sm:rounded-xl sm:border sm:border-border"
        onKeyDown={event => event.stopPropagation()}
        onKeyUp={event => event.stopPropagation()}
        onPointerDown={event => event.stopPropagation()}
        onWheel={event => event.stopPropagation()}
      >
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border p-3">
          <Dialog.Title className="mr-auto font-semibold">{t.drawing}</Dialog.Title>
          <Button variant="outline" onClick={onCancel}>{t.cancel}</Button>
          <Button disabled={!editable || !api || saving} onClick={save}>{t.drawingSave}</Button>
          <Dialog.Description className="w-full text-xs text-muted-foreground">{t.drawingHelp}</Dialog.Description>
          {error && <p role="alert" className="w-full text-sm text-destructive">{error}</p>}
        </div>
        <div className="min-h-0 flex-1">
          {runtime ? <runtime.Excalidraw
            excalidrawAPI={setApi}
            initialData={{ ...initial, scrollToContent: true } as unknown as ExcalidrawInitialDataState}
            theme={resolved}
            langCode={locale === 'ja' ? 'ja-JP' : locale === 'zh' ? 'zh-TW' : locale === 'zh-CN' ? 'zh-CN' : 'en'}
            viewModeEnabled={!editable || saving}
            handleKeyboardGlobally={false}
            autoFocus
            UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, toggleTheme: false }, tools: { image: true } }}
          ><runtime.MainMenu /></runtime.Excalidraw> : <p role="status" className="p-4">{t.drawingLoading}</p>}
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
