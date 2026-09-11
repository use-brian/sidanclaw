"use client";

import { useEffect, useRef, useState } from 'react';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFiles, LibraryItems } from '@excalidraw/excalidraw/types';
import { Dialog } from '@base-ui/react/dialog';
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';
import { drawingTitleSchema, drawingSceneSchema, drawingPreviewSchema, drawingSceneDigest, MAX_DRAWING_PREVIEW_DIMENSION, type DrawingScene, type DrawingPreview } from '@use-brian/shared/drawing';
import { useLocale, useT } from '@/lib/i18n/client';
import { useTheme } from '@/lib/theme';
import { Button } from '@/components/ui/button';
import { loadDrawingRuntime } from './drawing-runtime';
import { desktopBridge } from '@/lib/desktop-auth-source';
import { LIBRARY_BYTES, mergeLibraries, parseLibrary, persistLibrary, initializeLibrary, validateLibraryItems, isLocalLibraryOrigin,
  type LibraryTarget } from './drawing-library';
import { DrawingLibraryCatalog } from './drawing-library-catalog';
import '@excalidraw/excalidraw/index.css';

export default function DrawingEditor({ scene, title, preview: savedPreview, editable, onSave, onCancel, libraryTarget }: {
  scene: DrawingScene;
  title?: string;
  preview?: DrawingPreview;
  editable: boolean;
  onSave: (scene: DrawingScene, preview?: DrawingPreview, title?: string) => boolean;
  onCancel: () => void;
  libraryTarget?: LibraryTarget;
}) {
  const t = useT().docPage.diagramSource;
  const locale = useLocale();
  const { resolved } = useTheme();
  const [runtime, setRuntime] = useState<Awaited<ReturnType<typeof loadDrawingRuntime>> | null>(null);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title ?? '');
  const titleBeforeFocus = useRef(draftTitle);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryReady, setLibraryReady] = useState(false);
  const [notice, setNotice] = useState('');
  const [catalogOpen, setCatalogOpen] = useState(false);
  useEffect(() => { if (!editable) setCatalogOpen(false); }, [editable]);
  const library = useRef<LibraryItems>([]);
  const libraryWriting = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const desktop = !!desktopBridge() || (typeof window !== 'undefined' && window.location.protocol === 'file:');
  const latest = useRef({ editable, onSave, mounted: true });
  latest.current = { editable, onSave, mounted: latest.current.mounted };
  useEffect(() => { latest.current.mounted = true; return () => { latest.current.mounted = false; }; }, []);
  const [initial] = useState(() => structuredClone(scene));
  const initialScene = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    loadDrawingRuntime().then(value => { if (active) setRuntime(value); })
      .catch(() => { if (active) setError(t.drawingFailed); });
    return () => { active = false; };
  }, [t.drawingFailed]);

  useEffect(() => {
    if (!api || !libraryTarget || !editable) return;
    let active = true;
    setLibraryReady(false);
    try { library.current = initializeLibrary(libraryTarget.key); }
    catch { setError(t.libraryStorageFailed); return; }
    libraryWriting.current = true;
    void api.updateLibrary({ libraryItems: library.current, merge: false }).then(() => {
      if (active) { libraryWriting.current = false; setLibraryReady(true); }
    }).catch(() => { if (active) setError(t.libraryFailed); });
    return () => { active = false; };
  }, [api, libraryTarget?.key, editable]);

  async function install(items: LibraryItems) {
    if (!api || !runtime || !libraryTarget || !latest.current.editable || !latest.current.mounted) return;
    if (!desktop && window.location.pathname !== libraryTarget.path) return;
    if (!items.length) throw new Error('library-empty');
    const restored = runtime.restoreLibraryItems(items, 'published');
    if (restored.length !== items.length || restored.some((item, index) => item.elements.length !== items[index].elements.length)) {
      throw new Error('library-data');
    }
    const merged = mergeLibraries(library.current, validateLibraryItems(restored));
    libraryWriting.current = true;
    try {
      const stored = persistLibrary(libraryTarget.key, library.current, merged);
      library.current = stored;
      await api.updateLibrary({ libraryItems: stored, merge: false, openLibraryMenu: true });
      if (latest.current.mounted) { setError(''); setNotice(t.libraryInstalled); }
    } finally { libraryWriting.current = false; }
  }

  function importError(cause: unknown) {
    setNotice('');
    setError(cause instanceof Error && cause.message === 'library-empty' ? t.libraryEmpty :
      cause instanceof Error && (['library-data', 'library-assets', 'library-size'].includes(cause.message) ||
        cause.name === 'ZodError' || cause.name === 'SyntaxError') ? t.libraryInvalid : t.libraryFailed);
  }

  function libraryChanged(items: LibraryItems) {
    if (!libraryReady || libraryWriting.current || !libraryTarget || !latest.current.editable) return;
    try {
      const next = validateLibraryItems(items);
      persistLibrary(libraryTarget.key, library.current, next);
      // Track what THIS editor saw, not unseen items merged from another tab.
      // Otherwise its next change would mistake those unseen items for deletions.
      library.current = next;
    } catch {
      setError(t.libraryStorageFailed);
      if (api) {
        libraryWriting.current = true;
        void api.updateLibrary({ libraryItems: library.current, merge: false })
          .finally(() => { libraryWriting.current = false; }).catch(() => {});
      }
    }
  }

  async function importFile(file: File) {
    if (!editable || libraryBusy || !libraryReady) return;
    setLibraryBusy(true); setNotice('');
    try {
      if (file.size > LIBRARY_BYTES) throw new Error('library-size');
      await install(parseLibrary(await file.text()));
    } catch (cause) { if (latest.current.mounted) importError(cause); }
    finally { if (latest.current.mounted) setLibraryBusy(false); }
  }

  function browse() {
    if (!api || !libraryTarget || !editable || !libraryReady || libraryBusy || saving) return;
    if (desktop) { window.open('https://libraries.excalidraw.com', '_blank', 'noopener,noreferrer'); return; }
    setError(''); setNotice(''); setCatalogOpen(true);
  }

  async function save() {
    if (!editable || !api || !runtime || saving || libraryBusy) return;
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
    const name = drawingTitleSchema.safeParse(draftTitle);
    if (!result.success || !name.success) { setError(t.drawingError); return; }
    const nextTitle = name.data || (title === undefined ? undefined : '');
    // The SDK restores default element fields on load. Compare against its
    // first scene notification too, so a rename does not persist those defaults.
    const unchanged = JSON.stringify(result.data) === JSON.stringify(drawingSceneSchema.parse(scene)) ||
      (JSON.stringify(initial) === JSON.stringify(scene) && JSON.stringify(result.data) === initialScene.current);
    if (draftTitle !== (title ?? '') && unchanged) {
      if (!onSave(scene, savedPreview, nextTitle)) setError(t.drawingConflict);
      return;
    }
    if (!result.data.elements.some(element => !element.isDeleted)) {
      if (!onSave(result.data, undefined, nextTitle)) setError(t.drawingConflict);
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
      if (!latest.current.editable || !latest.current.onSave(result.data, preview, nextTitle)) setError(t.drawingConflict);
    } catch { if (latest.current.mounted) setError(t.drawingFailed); }
    finally { if (latest.current.mounted) setSaving(false); }
  }

  return <Dialog.Root open onOpenChange={(open) => { if (!open) onCancel(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-background/80" />
      {/* Excalidraw finishes gestures in native window pointerup listeners.
          Keep pointer/mouse events bubbling; DrawingToolbarProvider hides host UI. */}
      <Dialog.Popup
        className="fixed inset-0 z-50 flex flex-col bg-background text-foreground sm:inset-4 sm:rounded-xl sm:border sm:border-border"
        onKeyDown={event => event.stopPropagation()}
        onKeyUp={event => event.stopPropagation()}
        onWheel={event => event.stopPropagation()}
      >
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border p-3">
          <Dialog.Title className="sr-only">{draftTitle.trim() || t.drawing}</Dialog.Title>
          <input aria-label={t.drawingName} className="mr-auto min-w-0 basis-40 flex-1 rounded border border-transparent bg-transparent px-1 py-1 font-semibold hover:border-border focus:border-border focus:outline-none focus:ring-2 focus:ring-ring"
            value={draftTitle} maxLength={200} disabled={!editable || saving || libraryBusy} placeholder={t.drawing}
            onFocus={() => { titleBeforeFocus.current = draftTitle; }}
            onChange={event => setDraftTitle(event.target.value)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || !['Enter', 'Escape'].includes(event.key)) return;
              event.preventDefault(); event.stopPropagation();
              if (event.key === 'Escape') setDraftTitle(titleBeforeFocus.current);
              event.currentTarget.blur();
            }} />
           {libraryTarget && <>
             <Button variant="outline" disabled={!editable || !libraryReady || libraryBusy || saving} onClick={browse}>{t.libraryBrowse}</Button>
             <Button variant="outline" disabled={!editable || !libraryReady || libraryBusy || saving} onClick={() => fileInput.current?.click()}>{t.libraryImport}</Button>
             <input ref={fileInput} type="file" accept=".excalidrawlib" hidden onChange={event => {
               const file = event.target.files?.[0]; event.target.value = '';
               if (file) void importFile(file);
             }} />
           </>}
           <Button variant="outline" onClick={onCancel}>{t.cancel}</Button>
           <Button disabled={!editable || !api || saving || libraryBusy} onClick={save}>{t.drawingSave}</Button>
           <Dialog.Description className="w-full text-xs text-muted-foreground">{t.drawingHelp}</Dialog.Description>
           {libraryTarget && <p className="w-full text-xs text-muted-foreground">{desktop ? t.libraryDesktop : t.libraryLocal}</p>}
           {libraryTarget && !desktop && <p className="w-full text-xs text-muted-foreground">{isLocalLibraryOrigin(window.location.href) ? t.libraryPickerHelp : t.libraryReturnHelp}</p>}
           {notice && <p role="status" className="w-full text-sm">{notice}</p>}
           {libraryBusy && <p role="status" className="w-full text-sm">{t.libraryLoading}</p>}
          {error && <p role="alert" className="w-full text-sm text-destructive">{error}</p>}
        </div>
        <div className="min-h-0 flex-1 [&_.library-menu-browse-button]:hidden"
          onClickCapture={event => {
            if ((event.target as Element).closest('.library-menu-browse-button')) {
              event.preventDefault(); event.stopPropagation(); browse();
              return;
            }
            if ((event.target as Element).closest('[data-testid="lib-dropdown--load"]')) {
              event.preventDefault(); event.stopPropagation();
              if (editable && libraryReady && !libraryBusy) fileInput.current?.click();
            }
          }}
          onDropCapture={event => {
            const file = event.dataTransfer.files[0];
            if (file && !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
              event.preventDefault(); event.stopPropagation();
              if (file.name.endsWith('.excalidrawlib')) void importFile(file);
              else setError(t.libraryFailed);
            }
            const data = event.dataTransfer.getData('application/vnd.excalidrawlib+json');
            if (data) {
              try { parseLibrary(data); }
              catch { event.preventDefault(); event.stopPropagation(); setError(t.libraryFailed); }
            }
          }}>
          {runtime ? <runtime.Excalidraw
            excalidrawAPI={setApi}
            onLibraryChange={libraryChanged}
            onChange={(elements, appState, files) => {
              if (initialScene.current !== null) return;
              const ids = new Set<string>(elements.flatMap(element => element.type === 'image' && !element.isDeleted && element.fileId ? [element.fileId] : []));
              const parsed = drawingSceneSchema.safeParse({ version: 1, elements,
                appState: { viewBackgroundColor: appState.viewBackgroundColor },
                files: Object.fromEntries(Object.entries(files).filter(([id]) => ids.has(id))) });
              if (parsed.success) initialScene.current = JSON.stringify(parsed.data);
            }}
            initialData={{ ...initial, appState: { ...initial.appState, currentItemFontFamily: runtime.FONT_FAMILY.Nunito }, scrollToContent: true } as unknown as ExcalidrawInitialDataState}
            theme={resolved}
            langCode={locale === 'ja' ? 'ja-JP' : locale === 'zh' ? 'zh-TW' : locale === 'zh-CN' ? 'zh-CN' : 'en'}
            viewModeEnabled={!editable || saving || libraryBusy}
            handleKeyboardGlobally={false}
            autoFocus
            UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, toggleTheme: false }, tools: { image: true } }}
          ><runtime.MainMenu /></runtime.Excalidraw> : <p role="status" className="p-4">{t.drawingLoading}</p>}
        </div>
        {catalogOpen && editable && libraryTarget && !desktop && <DrawingLibraryCatalog theme={resolved}
          path={libraryTarget.path} onClose={() => setCatalogOpen(false)} onImport={install} />}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
