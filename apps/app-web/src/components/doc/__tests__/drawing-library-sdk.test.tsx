// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://drawing.example"}
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import type { ExcalidrawImperativeAPI, LibraryItems } from '@excalidraw/excalidraw/types';
import { drawingSceneSchema } from '@use-brian/shared/drawing';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog';
import { BlockDrawing, DrawingLibraryContext } from '../block-drawing';
import { libraryKey, parseLibrary, persistLibrary, readLibrary, validateLibraryItems } from '../drawing-library';
import { defaultDrawingLibrary } from '../drawing-default-library';

vi.mock('@/lib/theme', () => ({ useTheme: () => ({ resolved: 'light' }) }));
const platform = vi.hoisted(() => ({ desktop: false }));
vi.mock('@/lib/desktop-auth-source', () => ({ desktopBridge: () => platform.desktop ? {} : undefined }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each(['v1', 'v2', 'legacy-draw', 'metadata-defaults', 'empty', 'invalid', 'discarded', 'cancel', 'desktop', 'permission', 'closed', 'defaults-deleted', 'seed-capacity',
  'defaults-migration-1', 'defaults-migration-2', 'defaults-migration-3', ...(process.env.LIVE_EXCALIDRAW_LIBRARY === '1' ? ['catalog-v1', 'catalog-v2', 'catalog-software-architecture'] : [])])(
  '[COMP:app-web/drawing-library] iframe callback with real SDK and StrictMode: %s', async format => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  platform.desktop = format === 'desktop';
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  const context = new Proxy({ measureText: () => ({ width: 10 }), getLineDash: () => [], canvas: document.createElement('canvas') }, {
    get: (target, key) => key in target ? target[key as keyof typeof target] : () => {},
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('Path2D', class {});
  vi.stubGlobal('FontFace', class { status = 'loaded'; async load() { return this; } });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  const fonts = Object.getOwnPropertyDescriptor(document, 'fonts');
  Object.defineProperty(document, 'fonts', { configurable: true, value: { check: () => true, load: async () => [], add() {}, has: () => true, addEventListener() {}, removeEventListener() {} } });
  const scope = { key: libraryKey('https://api.example.com', 'account', 'workspace'), account: 'account', path: '/w/workspace/p/page' };
  const item = { id: 'imported', status: 'published', created: 1, elements: [{ id: 'shape', type: 'rectangle', x: 0, y: 0, width: 100, height: 80, versionNonce: 1, boundElementIds: null }] };
  localStorage.clear();
  let existing = validateLibraryItems([{ ...item, id: 'existing', elements: [{ ...item.elements[0], id: 'existing-shape' }] }]);
  if (format === 'seed-capacity') existing = validateLibraryItems([{ ...existing[0],
    elements: Array.from({ length: 4990 }, (_, i) => ({ ...item.elements[0], id: `existing-${i}` })) }]);
  persistLibrary(scope.key, [], existing);
   const migrationVersion = Number(format.split('defaults-migration-')[1]) as 1 | 2 | 3;
   if (migrationVersion) {
     const old = defaultDrawingLibrary(migrationVersion);
     localStorage.setItem(scope.key, JSON.stringify({ defaultsSeeded: true, defaultsVersion: migrationVersion,
       items: [old[0], old[1], { ...old[2], name: 'My edited intern' }, { ...old[0], id: 'my-logo-copy' }] }));
  }
  const storedBeforeOpen = localStorage.getItem(scope.key);
   const scene = drawingSceneSchema.parse({ version: 1, elements: migrationVersion ? defaultDrawingLibrary(migrationVersion)[0].elements :
     [{ ...item.elements[0], type: 'rectangle', id: 'draft-scene' }], files: {}, appState: { viewBackgroundColor: '#fff' } });
  const payload = format === 'v1' || format === 'legacy-draw' ? { type: 'excalidrawlib', version: 1,
    library: [format === 'legacy-draw' ? [{ ...item.elements[0], type: 'draw', points: [[0, 1], [40, 2], [46, -2]],
      startArrowhead: null, endArrowhead: null, lastCommittedPoint: null }] : item.elements] } : {
    type: 'excalidrawlib', version: 2, libraryItems: format === 'empty' ? [] : [
      format === 'metadata-defaults' ? { elements: item.elements } :
        format === 'invalid' ? { ...item, elements: [{ ...item.elements[0], link: 'https://example.com' }] } :
          format === 'discarded' ? { ...item, elements: [{ ...item.elements[0], width: 0, height: 0 }] } : item,
    ],
  };
  const url = `https://libraries.excalidraw.com/libraries/${format === 'catalog-v1' ? 'thijsdev/snowflake' :
    format === 'catalog-software-architecture' ? 'youritjang/software-architecture' :
      format === 'catalog-v2' ? 'inwardmovement/information-architecture' : 'example/shapes'}.excalidrawlib`;
  window.history.replaceState({}, '', scope.path);
  const text = format.startsWith('catalog-') ? execFileSync('curl', ['--fail', '--silent', '--show-error', '--max-time', '30',
    url], { encoding: 'utf8' }) : JSON.stringify(payload);
   const expectedCount = 38 + (format.startsWith('catalog-') ? 1 + parseLibrary(text).length : 2);
  if (format === 'catalog-software-architecture') {
    expect(parseLibrary(text)).toHaveLength(7);
    expect(parseLibrary(text).flatMap(item => item.elements)).toHaveLength(41);
  }
  const fetch = vi.fn(async () => new Response(text));
  let release: ((response: Response) => void) | undefined;
  if (format === 'permission' || format === 'closed') fetch.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  vi.stubGlobal('fetch', fetch);
  const save = vi.fn(() => true);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const render = async (editable = true) => {
    await act(async () => root.render(<StrictMode><I18nProvider locale="en" dict={en}>
      <DrawingLibraryContext.Provider value={scope}><BlockDrawing editable={editable} onSave={save} block={{ kind: 'drawing', id: 'drawing', title: 'Saved name', scene }} /></DrawingLibraryContext.Provider>
      <ConfirmDialogProvider />
    </I18nProvider></StrictMode>));
  };
  try {
    await render();
    async function wait(check: () => void) {
      for (let i = 0; i < 1000; i++) {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
        try { check(); return; } catch {}
      }
      check();
    }
    const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)!;
    await act(async () => button(en.docPage.diagramSource.drawingEdit).click());
    await wait(() => expect(button(en.docPage.diagramSource.libraryBrowse)?.disabled).toBe(false));
     if (migrationVersion) {
       const old = defaultDrawingLibrary(migrationVersion);
       const expected = [defaultDrawingLibrary()[0], { ...old[2], name: 'My edited intern' }, { ...old[0], id: 'my-logo-copy' }];
       const sdk = () => (window as unknown as { h: { app: Pick<ExcalidrawImperativeAPI, 'getSceneElements'> & { library: { getLatestLibrary: () => Promise<LibraryItems> } } } }).h.app;
      expect(readLibrary(scope.key)).toEqual(expected);
      const loaded = await sdk().library.getLatestLibrary();
      expect(loaded).toHaveLength(3);
       expect(loaded[0].elements[2]).toMatchObject({ x: 51, y: 21, width: 18, height: 18 });
       expect(loaded[1].name).toBe('My edited intern');
       expect(loaded[2].id).toBe('my-logo-copy');
       // Scene restoration normalizes SDK bookkeeping; library migration must not change the artwork.
       const expectedScene = old[0].elements.map(e => ({ id: e.id, type: e.type, x: e.x, y: e.y,
         width: e.width, height: e.height, backgroundColor: e.backgroundColor, groupIds: e.groupIds,
         ...('points' in e ? { points: e.points } : {}) }));
       expect(sdk().getSceneElements()).toMatchObject(expectedScene);
      await act(async () => button(en.docPage.diagramSource.cancel).click());
      await act(async () => button(en.docPage.diagramSource.drawingEdit).click());
      await wait(() => expect(button(en.docPage.diagramSource.libraryBrowse)?.disabled).toBe(false));
      expect(readLibrary(scope.key)).toEqual(expected);
       expect(await sdk().library.getLatestLibrary()).toHaveLength(3);
       expect(sdk().getSceneElements()).toMatchObject(expectedScene);
      expect(fetch).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      return;
    }
    if (format === 'seed-capacity') {
      const sdk = (window as unknown as { h: { app: { library: { getLatestLibrary: () => Promise<LibraryItems> } } } }).h.app;
      const loaded = await sdk.library.getLatestLibrary();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].elements.map(element => element.id)).toEqual(existing[0].elements.map(element => element.id));
      expect(document.querySelector('[role="alert"]')).toBeNull();
      expect(localStorage.getItem(scope.key)).toBe(storedBeforeOpen);
      expect(fetch).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      return;
    }
    existing = readLibrary(scope.key);
     expect(existing).toHaveLength(39);
     expect(existing[1].name).toBe('use-brian-bordered');
    if (format === 'defaults-deleted') {
      const sdk = () => (window as unknown as { h: { app: { library: {
        setLibrary: (items: LibraryItems) => Promise<LibraryItems>;
        getLatestLibrary: () => Promise<LibraryItems>;
      } } } }).h.app;
      await act(async () => { await sdk().library.setLibrary(existing.slice(0, 1)); });
      await wait(() => expect(readLibrary(scope.key)).toHaveLength(1));
      await render();
      expect(readLibrary(scope.key)).toHaveLength(1);
      await act(async () => { await sdk().library.setLibrary([]); });
      await wait(() => expect(readLibrary(scope.key)).toEqual([]));
      await act(async () => button(en.docPage.diagramSource.cancel).click());
      await act(async () => button(en.docPage.diagramSource.drawingEdit).click());
      await wait(() => expect(button(en.docPage.diagramSource.libraryBrowse)?.disabled).toBe(false));
      expect(await sdk().library.getLatestLibrary()).toEqual([]);
      expect(readLibrary(scope.key)).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      return;
    }
    await act(async () => button(en.docPage.diagramSource.libraryBrowse).click());
    if (format === 'desktop') {
      expect(open).toHaveBeenCalledWith('https://libraries.excalidraw.com', '_blank', 'noopener,noreferrer');
      expect(document.querySelector('iframe')).toBeNull();
      const file = new File([text], 'shapes.excalidrawlib');
      Object.defineProperty(file, 'text', { value: async () => text });
      const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, 'files', { value: [file] });
      await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
      await wait(() => expect(readLibrary(scope.key)).toHaveLength(expectedCount));
      expect(fetch).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
      return;
    }
    expect(open).not.toHaveBeenCalled();
    // The installed development SDK exposes its mounted App for its own tests.
    // Read the real scene/tool state without replacing the API callback or engine.
    const app = () => (window as unknown as { h: { app: Pick<ExcalidrawImperativeAPI, 'getSceneElements'> & {
      state: ReturnType<ExcalidrawImperativeAPI['getAppState']>;
    } } }).h.app;
    expect(app().getSceneElements().map(element => element.id)).toEqual(['draft-scene']);
    expect(app().state.currentItemFontFamily).toBe(6);
    expect(fetch).not.toHaveBeenCalled();
    expect(readLibrary(scope.key)).toEqual(existing);
    expect(document.querySelector<HTMLInputElement>('input[maxlength="200"]')?.value).toBe('Saved name');
    async function select(source: string) {
      const frame = document.querySelector('iframe')!;
      const browse = new URL(frame.src);
      await act(async () => window.dispatchEvent(new MessageEvent('message', { origin: location.origin,
        source: frame.contentWindow, data: { type: 'brian:drawing-library', token: browse.searchParams.get('token'), url: source } })));
    }
    if (format === 'permission' || format === 'closed') {
      await select(url);
      if (format === 'permission') await render(false);
      else {
        const close = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === en.docPage.diagramSource.close)!;
        await act(async () => close.click());
      }
      expect(document.querySelector('iframe')).toBeNull();
      await act(async () => release!(new Response(text)));
      expect(readLibrary(scope.key)).toEqual(existing);
      expect(app().getSceneElements().map(element => element.id)).toEqual(['draft-scene']);
      expect(save).not.toHaveBeenCalled();
      return;
    }
    if (format === 'cancel') {
      const close = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === en.docPage.diagramSource.close)!;
      await act(async () => close.click());
    } else await select(url);
    if (format === 'cancel') {
      expect(fetch).not.toHaveBeenCalled();
      expect(readLibrary(scope.key)).toEqual(existing);
    } else if (['empty', 'invalid', 'discarded'].includes(format)) {
      await wait(() => expect(document.querySelector('[role="alert"]')?.textContent).toBe(en.docPage.diagramSource.libraryFailed));
      expect(readLibrary(scope.key)).toEqual(existing);
      expect(document.body.textContent).not.toContain(en.docPage.diagramSource.libraryInstalled);
    } else {
      await wait(() => expect(readLibrary(scope.key)).toHaveLength(expectedCount));
      if (format === 'legacy-draw') expect(readLibrary(scope.key).at(-1)!.elements[0].type).toBe('line');
      await wait(() => expect(document.querySelectorAll('.library-unit__active')).toHaveLength(expectedCount));
      expect(document.body.textContent).toContain(en.docPage.diagramSource.libraryInstalled);
      expect(app().getSceneElements().map(element => element.id)).toEqual(['draft-scene']);
      expect(document.querySelector<HTMLInputElement>('input[maxlength="200"]')?.value).toBe('Saved name');
      expect(save).not.toHaveBeenCalled();
      await act(async () => button(en.docPage.diagramSource.cancel).click());
      await act(async () => button(en.docPage.diagramSource.drawingEdit).click());
      await wait(() => expect(button(en.docPage.diagramSource.libraryBrowse).disabled).toBe(false));
      const libraryButton = document.querySelector<HTMLInputElement>('.sidebar-trigger__label-element input')!;
      expect(libraryButton).not.toBeNull();
      await act(async () => libraryButton.click());
      await wait(() => expect(document.querySelectorAll('.library-unit__active')).toHaveLength(expectedCount));
      expect(readLibrary(scope.key)).toHaveLength(expectedCount);
      expect(app().getSceneElements().map(element => element.id)).toEqual(['draft-scene']);
      expect(fetch).toHaveBeenCalledOnce();
      const ids = readLibrary(scope.key).map(item => item.id);
      for (let selection = 0; selection < 3; selection++) {
        const different = selection === 2;
        if (different) fetch.mockResolvedValueOnce(new Response(JSON.stringify({ type: 'excalidrawlib', version: 2,
          libraryItems: [{ elements: [{ ...item.elements[0], id: 'different-library', width: 200 }] }] })));
        await act(async () => button(en.docPage.diagramSource.libraryBrowse).click());
        await select(different ? 'https://libraries.excalidraw.com/libraries/example/different.excalidrawlib' : url);
        await wait(() => {
          expect(fetch).toHaveBeenCalledTimes(selection + 2);
          expect(button(en.docPage.diagramSource.libraryBrowse).disabled).toBe(false);
        });
        expect(readLibrary(scope.key).slice(0, ids.length).map(item => item.id)).toEqual(ids);
        expect(readLibrary(scope.key)).toHaveLength(expectedCount + Number(different));
        await wait(() => expect(document.querySelectorAll('.library-unit__active')).toHaveLength(expectedCount + Number(different)));
        expect(app().getSceneElements().map(element => element.id)).toEqual(['draft-scene']);
      }
    }
    expect(save).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount()); host.remove();
    if (fonts) Object.defineProperty(document, 'fonts', fonts); else Reflect.deleteProperty(document, 'fonts');
  }
}, 45_000);
