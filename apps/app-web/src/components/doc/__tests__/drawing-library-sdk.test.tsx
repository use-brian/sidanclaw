// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://drawing.example"}
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog';
import { BlockDrawing, DrawingLibraryContext } from '../block-drawing';
import { libraryKey, parseLibrary, persistLibrary, readLibrary, validateLibraryItems } from '../drawing-library';

vi.mock('@/lib/theme', () => ({ useTheme: () => ({ resolved: 'light' }) }));
const platform = vi.hoisted(() => ({ desktop: false }));
vi.mock('@/lib/desktop-auth-source', () => ({ desktopBridge: () => platform.desktop ? {} : undefined }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each(['v1', 'v2', 'legacy-draw', 'metadata-defaults', 'empty', 'invalid', 'discarded', 'cancel', 'desktop', 'permission', 'closed',
  ...(process.env.LIVE_EXCALIDRAW_LIBRARY === '1' ? ['catalog-v1', 'catalog-v2', 'catalog-software-architecture'] : [])])(
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
  const existing = validateLibraryItems([{ ...item, id: 'existing', elements: [{ ...item.elements[0], id: 'existing-shape' }] }]);
  persistLibrary(scope.key, [], existing);
  const scene = { version: 1 as const, elements: [{ ...item.elements[0], type: 'rectangle' as const, id: 'draft-scene' }], files: {}, appState: { viewBackgroundColor: '#fff' } };
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
  const expectedCount = format.startsWith('catalog-') ? 1 + parseLibrary(text).length : 2;
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
    await act(async () => button(en.docPage.diagramSource.libraryBrowse).click());
    if (format === 'desktop') {
      expect(open).toHaveBeenCalledWith('https://libraries.excalidraw.com', '_blank', 'noopener,noreferrer');
      expect(document.querySelector('iframe')).toBeNull();
      const file = new File([text], 'shapes.excalidrawlib');
      Object.defineProperty(file, 'text', { value: async () => text });
      const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, 'files', { value: [file] });
      await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
      await wait(() => expect(readLibrary(scope.key)).toHaveLength(2));
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
      if (format === 'legacy-draw') expect(readLibrary(scope.key)[1].elements[0].type).toBe('line');
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
