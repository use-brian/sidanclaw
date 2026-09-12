// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, StrictMode, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Editor, Extension } from '@tiptap/core';
import { history, undo } from '@tiptap/pm/history';
import { docExtensions } from '@use-brian/doc-model';
import type { DrawingBlock } from '@use-brian/shared/drawing';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { BlockDrawing, DrawingLibraryContext } from '../block-drawing';
import { DrawingToolbarProvider, FloatingToolbar } from '../floating-toolbar';
import { saveDrawing } from '../drawing-transaction';
import { executeSlashItem } from '../slash-execute';
import { SLASH_MENU_ITEMS, filterSlashMenuItems } from '../slash-menu';
import { drawingBlockSchema, drawingSceneDigest } from '@use-brian/shared/drawing';
import { webcrypto } from 'node:crypto';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==';
const exporting = vi.hoisted(() => ({ wait: null as Promise<void> | null, invalid: false, restoreDefaults: false }));
const captureInitialData = vi.hoisted(() => vi.fn());

vi.mock('@/lib/theme', () => ({ useTheme: () => ({ resolved: 'light' }) }));
vi.mock('@/lib/viewport', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/viewport')>(), useCoarsePointer: () => true,
}));
// Mock only the canvas engine. The real dialog, Save/Cancel, validation, and
// lazy boundary run in the DOM; persistence uses an actual ProseMirror editor.
vi.mock('../drawing-runtime', () => ({ loadDrawingRuntime: async () => ({
  FONT_FAMILY: { Nunito: 6 },
  Excalidraw: ({ initialData, excalidrawAPI, onChange }: { initialData: DrawingBlock['scene']; excalidrawAPI: (api: unknown) => void; onChange: (elements: unknown, appState: unknown, files: unknown) => void }) => {
    captureInitialData(initialData);
    const [elements, setElements] = useState(() => initialData.elements.map(element => exporting.restoreDefaults ? { ...element, roughness: 1 } : element));
    const [files, setFiles] = useState<Record<string, unknown>>(initialData.files);
    const [appState] = useState(initialData.appState);
    useEffect(() => { onChange(elements, appState, files); }, [elements, appState, files, onChange]);
    useEffect(() => { excalidrawAPI({ getSceneElements: () => elements, getFiles: () => files,
      getAppState: () => appState, updateLibrary: async () => [] }); }, [elements, excalidrawAPI, files, appState]);
    return <>
      <button onClick={() => setElements([{ id: 'shape', type: 'rectangle', x: 0, y: 0, width: 100, height: 80 }])}>engine draw {elements.length}</button>
      <button onClick={() => setElements([{ id: 'image', type: 'image', x: 0, y: 0, width: 100, height: 80, fileId: 'missing' }])}>engine missing image</button>
      {['svg', 'oversized'].map(kind => <button key={kind} onClick={() => {
        setFiles({ ...files, retained: { id: 'retained', mimeType: kind === 'svg' ? 'image/svg+xml' : 'image/png',
          dataURL: kind === 'svg' ? 'data:image/svg+xml;base64,YQ==' : `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}`, created: 1 } });
        setElements([...initialData.elements, { id: 'retained-image', type: 'image', x: 0, y: 0, width: 10, height: 10, fileId: 'retained' }]);
      }}>engine add {kind}</button>)}
      <button onClick={() => setElements(initialData.elements)}>engine delete retained image</button>
    </>;
  },
  MainMenu: () => null,
  restoreElements: (elements: unknown) => elements,
  exportToCanvas: async () => {
    if (exporting.wait) await exporting.wait;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    canvas.toDataURL = () => exporting.invalid ? 'data:,' : `data:image/png;base64,${png}`;
    return canvas;
  },
}) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const original: DrawingBlock = { kind: 'drawing', id: 'd1', scene: { version: 1, elements: [], appState: { viewBackgroundColor: '#fff' }, files: {} } };
const t = en.docPage.diagramSource;
let root: Root;
let host: HTMLDivElement;
let editor: Editor | undefined;
it('[COMP:app-web/drawing] displays quarantined register errors without offering a stale scene editor', async () => {
  await render(<BlockDrawing editable block={{ ...original, collaborationError: 'invalid-registers' }} />);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(t.drawingError);
  expect([...host.querySelectorAll('button')].some(button => button.textContent === t.drawingEdit)).toBe(false);
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); editor?.destroy(); editor = undefined; exporting.wait = null; exporting.invalid = false; exporting.restoreDefaults = false; captureInitialData.mockClear(); });
async function render(node: React.ReactNode) {
  if (!host?.isConnected) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); }
  await act(async () => { root.render(<I18nProvider locale="en" dict={en}>{node}</I18nProvider>); });
}
async function click(label: string) {
  let button: HTMLButtonElement | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    button = [...document.querySelectorAll('button')].find(b => b.textContent === label);
    if (button) break;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  }
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
async function settle(check: () => void) {
  for (let i = 0; i < 100; i++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    try { check(); return; } catch { /* Flush lazy loading and async export state. */ }
  }
  check();
}

describe('[COMP:app-web/drawing] editor lifecycle and authority', () => {
  it.each(['cancel', 'save', 'conflict', 'unmount', 'scope'])('removes the real host bubble plugin during drawing and restores it after %s', async close => {
    editor = new Editor({ extensions: docExtensions(), content: '<p>Page text</p>' });
    editor.commands.setTextSelection({ from: 1, to: 5 });
    const comment = vi.fn();
    const windowRelease = vi.fn();
    function Page({ visible = true, path = '/page' }: { visible?: boolean; path?: string }) {
      return <StrictMode><DrawingToolbarProvider>
        <FloatingToolbar editor={editor!} onComment={comment} />
        <DrawingLibraryContext.Provider value={{ key: 'test', account: 'test', path }}>
          {visible && <BlockDrawing block={original} editable onSave={() => close !== 'conflict'} />}
        </DrawingLibraryContext.Provider>
      </DrawingToolbarProvider></StrictMode>;
    }
    const bubbleMounted = () => editor!.state.plugins.some(plugin => (plugin as unknown as { key: string }).key.startsWith('bubbleMenu'));
    await render(<Page />);
    expect(bubbleMounted()).toBe(true);
    await click(t.drawingEdit);
    expect(bubbleMounted()).toBe(false);
    await settle(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    const dialog = document.querySelector('[role="dialog"]')!;
    // Boundary contract only; the browser harness proves real SDK gesture cleanup.
    const events = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove', 'mouseup', 'click', 'dblclick'];
    for (const type of events) window.addEventListener(type, windowRelease);
    try {
      await act(async () => {
        for (const type of events) dialog.dispatchEvent(new MouseEvent(type, { bubbles: true }));
        document.dispatchEvent(new Event('selectionchange'));
        document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }));
      });
      expect(windowRelease.mock.calls.map(([event]) => event.type)).toEqual(events);
    } finally {
      for (const type of events) window.removeEventListener(type, windowRelease);
    }
    expect(bubbleMounted()).toBe(false);
    expect(document.querySelector('[data-selection-comment-chip]')).toBeNull();
    expect(document.querySelector('[aria-label="Bold"]')).toBeNull();
    if (close === 'conflict') {
      await click(t.drawingSave);
      expect(document.querySelector('[role="alert"]')?.textContent).toBe(t.drawingConflict);
      expect(bubbleMounted()).toBe(false);
    }
    if (close === 'cancel' || close === 'conflict') await click(t.cancel);
    else if (close === 'save') await click(t.drawingSave);
    else await render(<Page visible={close !== 'unmount'} path={close === 'scope' ? '/other' : '/page'} />);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(bubbleMounted()).toBe(true);
    expect(editor.getText()).toBe('Page text');
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(5);
  });

  it('saves and reopens a trimmed name, cancels a rename, and preserves scene and PNG on title-only edits', async () => {
    exporting.restoreDefaults = true;
    const scene: DrawingBlock['scene'] = { ...original.scene, elements: [{ id: 'shape', type: 'rectangle', x: 0, y: 0, width: 100, height: 80 }] };
    const block: DrawingBlock = { ...original, scene, preview: { mimeType: 'image/png', data: png, width: 1, height: 1, sceneDigest: await drawingSceneDigest(scene) } };
    const write = vi.fn();
    function Page() {
      const [saved, setSaved] = useState(block);
      return <BlockDrawing block={saved} editable onSave={next => { write(next); setSaved(next); return true; }} />;
    }
    async function name(value: string) {
      await settle(() => expect(document.querySelector('input[maxlength="200"]')).not.toBeNull());
      const input = document.querySelector<HTMLInputElement>('input[maxlength="200"]')!;
      expect(input.getAttribute('aria-label')).toBe(t.drawingName);
      expect(input.closest('label')).toBeNull();
      expect(document.querySelectorAll('input[maxlength="200"]')).toHaveLength(1);
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    await render(<Page />);
    expect(host.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(t.drawing);
    await click(t.drawingEdit);
    await name('  Architecture sketch  ');
    const input = document.querySelector<HTMLInputElement>('input[maxlength="200"]')!;
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => input.focus());
    await name('Reverted edit');
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(input.value).toBe('  Architecture sketch  ');
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Architecture sketch');
    expect(document.activeElement).not.toBe(input);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(write).not.toHaveBeenCalled();
    exporting.invalid = true; // A rename must not depend on exporting a new PNG.
    await click(t.drawingSave);
    expect(write).toHaveBeenCalledWith({ ...block, title: 'Architecture sketch' });
    expect(write.mock.calls[0][0].scene).toEqual(scene);
    expect(write.mock.calls[0][0].preview).toEqual(block.preview);
    expect(host.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Architecture sketch');
    await click(t.drawingEdit);
    expect(document.querySelector<HTMLInputElement>('input[maxlength="200"]')?.value).toBe('Architecture sketch');
    await name('Cancelled name');
    await click(t.cancel);
    expect(write).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Architecture sketch');
    await click(t.drawingEdit);
    expect(document.querySelector<HTMLInputElement>('input[maxlength="200"]')?.value).toBe('Architecture sketch');
    await name('   ');
    await click(t.drawingSave);
    expect(write.mock.calls[1][0]).toEqual({ ...block, title: '' });
    expect(host.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(t.drawing);
    await render(<BlockDrawing block={{ ...block, title: 'Read-only name' }} />);
    expect(host.textContent).toContain('Read-only name');
    expect(host.querySelector('input, button')).toBeNull();
  });
  it.each(['svg', 'oversized'])('recovers after deleting a %s asset and preserves live image bytes', async kind => {
    const liveFile = { id: 'live', mimeType: 'image/png' as const, dataURL: 'data:image/png;base64,YQ==', created: 1 };
    const block: DrawingBlock = { ...original, scene: { ...original.scene,
      elements: [{ id: 'live-image', type: 'image', x: 0, y: 0, width: 10, height: 10, fileId: 'live' }], files: { live: liveFile } } };
    const write = vi.fn(() => true);
    await render(<BlockDrawing block={block} editable onSave={write} />);
    await click(t.drawingEdit);
    await click(`engine add ${kind}`);
    await click(t.drawingSave);
    expect(write).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(t.drawingError);
    await click('engine delete retained image');
    await click(t.drawingSave);
    await act(async () => { await vi.waitFor(() => expect(write).toHaveBeenCalledWith(expect.objectContaining({ ...block, preview: expect.objectContaining({ data: png }) }), block)); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('discovers Drawing by alias and slash-inserts a schema-valid canonical embed', () => {
    const item = SLASH_MENU_ITEMS.find(item => item.id === 'drawing')!;
    expect(filterSlashMenuItems('excalidraw')).toContain(item);
    editor = new Editor({ extensions: docExtensions(), content: '<p></p>' });
    expect(executeSlashItem(editor, item)).toBe(true);
    expect(drawingBlockSchema.safeParse(JSON.parse(editor.state.doc.nodeAt(0)!.attrs.block)).success).toBe(true);
    editor.setEditable(false);
    expect(executeSlashItem(editor, item)).toBe(false);
  });
  it('saves, embeds a preview, reopens the persisted scene, and cancels without writes', async () => {
    const write = vi.fn();
    function Page() {
      const [block, setBlock] = useState(original);
      return <BlockDrawing block={block} editable onSave={next => { write(next); setBlock(next); return true; }} />;
    }
    await render(<Page />);
    await click(t.drawingEdit);
    await click('engine draw 0');
    await click(t.drawingSave);
    await act(async () => { await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1)); });
    expect(captureInitialData).toHaveBeenLastCalledWith({ ...original.scene,
      appState: { ...original.scene.appState, currentItemFontFamily: 6 }, scrollToContent: true });
    expect(write.mock.calls[0][0].scene.appState).toEqual(original.scene.appState);
    expect(write.mock.calls[0][0].preview).toEqual({ mimeType: 'image/png', data: png, width: 1, height: 1,
      sceneDigest: await drawingSceneDigest(write.mock.calls[0][0].scene) });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector('canvas')).toBeTruthy();
    await click(t.drawingEdit);
    expect(document.body.textContent).toContain('engine draw 1');
    expect(captureInitialData).toHaveBeenLastCalledWith({ ...write.mock.calls[0][0].scene,
      appState: { ...original.scene.appState, currentItemFontFamily: 6 }, scrollToContent: true });
    await click(t.cancel);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('defaults to Normal without changing existing text fonts on open or save', async () => {
    const block: DrawingBlock = { ...original, scene: { ...original.scene,
      elements: [{ id: 'text', type: 'text', x: 0, y: 0, width: 100, height: 25,
        text: 'Existing text', fontFamily: 1, fontSize: 20, lineHeight: 1.25 }] } };
    const write = vi.fn(() => true);
    await render(<BlockDrawing block={block} editable onSave={write} />);
    await click(t.drawingEdit);
    await click(t.drawingSave);
    await act(async () => { await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1)); });
    expect(captureInitialData).toHaveBeenLastCalledWith({ ...block.scene,
      appState: { ...block.scene.appState, currentItemFontFamily: 6 }, scrollToContent: true });
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ scene: block.scene }), block);
  });
  it('offers no edit in read-only mode and disables save after permission loss', async () => {
    const write = vi.fn(() => true);
    await render(<BlockDrawing block={original} onSave={write} />);
    expect(host.querySelector('button')).toBeNull();
    await render(<BlockDrawing block={original} editable onSave={write} />);
    await click(t.drawingEdit);
    await render(<BlockDrawing block={original} editable={false} onSave={write} />);
    expect(document.querySelector<HTMLInputElement>('input[maxlength="200"]')?.disabled).toBe(true);
    await click(t.drawingSave);
    expect(write).not.toHaveBeenCalled();
    await click(t.cancel);
  });
  it.each(['cancel', 'permission', 'remote'])('rejects an in-flight export after %s changes authority', async reason => {
    const write = vi.fn(() => true);
    await render(<BlockDrawing block={original} editable onSave={write} />);
    await click(t.drawingEdit);
    await click('engine draw 0');
    let release!: () => void;
    exporting.wait = new Promise<void>(resolve => { release = resolve; });
    await click(t.drawingSave);
    expect(write).not.toHaveBeenCalled();
    if (reason === 'cancel') await click(t.cancel);
    else await render(<BlockDrawing block={reason === 'remote' ? { ...original, scene: { ...original.scene, appState: { viewBackgroundColor: '#000' } } } : original} editable={reason !== 'permission'} onSave={write} />);
    await act(async () => { release(); await drawingSceneDigest(original.scene); });
    expect(write).not.toHaveBeenCalled();
  });
  it('keeps failed exports open and saves empty scenes without retaining an old image', async () => {
    const write = vi.fn(() => true);
    await render(<BlockDrawing block={original} editable onSave={write} />);
    await click(t.drawingEdit);
    await click('engine draw 0');
    exporting.invalid = true;
    await click(t.drawingSave);
    expect(write).not.toHaveBeenCalled();
    await settle(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe(t.drawingFailed));
    await click('engine delete retained image');
    await click(t.drawingSave);
    expect(write).toHaveBeenCalledWith({ ...original, preview: undefined }, original);
  });
  it('keeps a stale draft open with an error instead of overwriting a remote scene', async () => {
    const write = vi.fn(() => true);
    await render(<BlockDrawing block={original} editable onSave={write} />);
    await click(t.drawingEdit);
    await render(<BlockDrawing block={{ ...original, scene: { ...original.scene, appState: { viewBackgroundColor: '#000' } } }} editable onSave={write} />);
    await click(t.drawingSave);
    expect(write).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe(t.drawingConflict));
    await click(t.cancel);
  });
  it('refuses incomplete images without writing or closing, and isolates drawing shortcuts', async () => {
    const write = vi.fn(() => true);
    const outerKey = vi.fn();
    await render(<div onKeyDown={outerKey}><BlockDrawing block={original} editable onSave={write} /></div>);
    await click(t.drawingEdit);
    await click('engine missing image');
    const dialog = document.querySelector('[role="dialog"]')!;
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })));
    expect(outerKey).not.toHaveBeenCalled();
    await click(t.drawingSave);
    expect(write).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(t.drawingError);
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    await click(t.cancel);
    expect(write).not.toHaveBeenCalled();
  });
  it('commits one actual embed transaction; undo restores it, and stale/deleted/read-only nodes reject writes', () => {
    editor = new Editor({ extensions: [...docExtensions(), Extension.create({ name: 'testHistory', addProseMirrorPlugins: () => [history()] })], content: { type: 'doc', content: [{ type: 'embed', attrs: { blockId: original.id, block: JSON.stringify(original) } }] } });
    const next = { ...original, scene: { ...original.scene, appState: { viewBackgroundColor: '#000' } } };
    expect(saveDrawing(editor, () => 0, next, original)).toBe(true);
    expect(JSON.parse(editor.state.doc.nodeAt(0)!.attrs.block)).toEqual(next);
    expect(saveDrawing(editor, () => 0, original, original)).toBe(false);
    undo(editor.state, editor.view.dispatch);
    expect(JSON.parse(editor.state.doc.nodeAt(0)!.attrs.block)).toEqual(original);
    editor.setEditable(false);
    expect(saveDrawing(editor, () => 0, next, original)).toBe(false);
    editor.setEditable(true);
    editor.commands.clearContent();
    expect(saveDrawing(editor, () => 0, next, original)).toBe(false);
    expect(saveDrawing(editor, () => undefined, next, original)).toBe(false);
  });
});
