// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost:3003/w/workspace/p/page"}
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { DrawingLibraryCatalog } from '../drawing-library-catalog';
import { fetchLibraryIndex, isLocalLibraryOrigin, LIBRARY_BYTES, officialLibraryPreviewUrl } from '../drawing-library';

const index = [{ name: 'Architecture kit', authors: [{ name: 'Example Author' }], source: 'example/architecture.excalidrawlib', preview: 'example/architecture.png' },
  { name: 'Charts', authors: [{ name: 'Another Author' }], source: 'example/charts.excalidrawlib' }];
const text = JSON.stringify({ type: 'excalidrawlib', version: 2, libraryItems: [{ id: 'shape', status: 'published', created: 1,
  elements: [{ id: 'shape', type: 'rectangle', x: 0, y: 0, width: 100, height: 80 }] }] });
const imported = vi.fn(async () => {});
const close = vi.fn();
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState({}, '', '/w/workspace/p/page');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(url.endsWith('libraries.json') ? JSON.stringify(index) : text)));
  imported.mockClear(); close.mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render() {
  await act(async () => root.render(<StrictMode><I18nProvider locale="en" dict={en}>
    <DrawingLibraryCatalog theme="light" path="/w/workspace/p/page" onClose={close} onImport={imported} />
  </I18nProvider></StrictMode>));
}
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label)!;
describe('[COMP:app-web/drawing-library-catalog] direct local catalog', () => {
  it('renders lazy official previews without importing and falls back on missing/broken images', async () => {
    await render();
    const image = document.querySelector('img')!;
    expect(image.src).toBe('https://libraries.excalidraw.com/libraries/example/architecture.png');
    expect(image.alt).toBe('Library preview: Architecture kit');
    expect(image.getAttribute('loading')).toBe('lazy');
    expect(image.getAttribute('decoding')).toBe('async');
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(document.body.textContent).toContain(en.docPage.diagramSource.libraryPreviewUnavailable);
    expect(imported).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).endsWith('libraries.json'))).toBe(true);
    await act(async () => image.dispatchEvent(new Event('error')));
    expect(document.querySelector('img')).toBeNull();
    await act(async () => button('Import library: Architecture kit').click());
    expect(imported).toHaveBeenCalledOnce();
  });
  it.each(['https://evil.example/a.png', '//evil.example/a.png', '../a.png', 'example/../a.png',
    'example/%2e%2e/a.png', 'example/a.png?track=1', 'example/a.png#x', 'example\\a.png',
    'https://user:pass@libraries.excalidraw.com/libraries/a.png', 'javascript:bad', 'example/a.html'])('ignores unsafe preview %s without failing catalog', async preview => {
    expect(() => officialLibraryPreviewUrl(preview)).toThrow();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([{ ...index[0], preview }])));
    expect((await fetchLibraryIndex(new AbortController().signal))[0].preview).toBeUndefined();
  });
  it.each(['http://home-desktop-nixos:3003', 'http://public.example', 'https://localhost', 'https://test.localhost',
    'https://127.0.0.2', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://[fd00::1]', 'https://[fe80::1]',
    'https://10.0.0.1', 'https://172.16.0.1', 'https://192.168.1.1', 'https://169.254.1.1', 'https://machine', 'https://machine.local'])('uses direct JSON at %s', href => {
    expect(isLocalLibraryOrigin(href)).toBe(true);
  });
  it.each(['https://drawing.example', 'https://localhost.example', 'https://172.32.0.1'])('retains iframe at %s', href => {
    expect(isLocalLibraryOrigin(href)).toBe(false);
  });
  it('searches author/name and directly imports without iframe, postMessage or navigation', async () => {
    const open = vi.spyOn(window, 'open');
    await render();
    expect(document.querySelector('iframe')).toBeNull();
    const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'example author');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button('Import library: Charts')).toBeUndefined();
    await act(async () => button('Import library: Architecture kit').click());
    expect(imported).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled();
    expect(location.pathname).toBe('/w/workspace/p/page'); expect(location.hash).toBe('');
    expect(fetch).toHaveBeenCalledWith('https://libraries.excalidraw.com/libraries/example/architecture.excalidrawlib',
      expect.objectContaining({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' }));
  });
  it('keeps errors visible and retries a blocked catalog in place', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    await render(); expect(document.querySelector('[role="alert"]')).not.toBeNull();
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(index)));
    await act(async () => button(en.docPage.diagramSource.libraryRetry).click());
    expect(button('Import library: Charts')).toBeDefined();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
  it.each(['close', 'unmount', 'route'])('ignores a pending import after %s and prevents concurrent selections', async kind => {
    await render();
    let release!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(new Promise(resolve => { release = resolve; }));
    const calls = vi.mocked(fetch).mock.calls.length;
    await act(async () => { button('Import library: Charts').click(); button('Import library: Architecture kit').click(); });
    expect(fetch).toHaveBeenCalledTimes(calls + 1);
    if (kind === 'close') await act(async () => button(en.docPage.diagramSource.close).click());
    if (kind === 'unmount') await act(async () => root.render(null));
    if (kind === 'route') window.history.replaceState({}, '', '/other');
    await act(async () => release(new Response(text)));
    expect(imported).not.toHaveBeenCalled();
  });
  it('retains the searchable list after unsupported data and permits another import attempt', async () => {
    await render();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(text.replace('"height":80', '"height":80,"link":"https://evil.example"')));
    await act(async () => button('Import library: Charts').click());
    expect(imported).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(en.docPage.diagramSource.libraryFailed);
    expect(button('Import library: Architecture kit').disabled).toBe(false);
    await act(async () => button('Import library: Architecture kit').click());
    expect(imported).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });
  it.each(['https://evil.example/a.excalidrawlib', '//evil.example/a.excalidrawlib', '../a.excalidrawlib',
    'example/%2e%2e/a.excalidrawlib', 'example/a.excalidrawlib?x=1', 'example/a.svg'])('rejects malformed index source %s', async source => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify([{ ...index[0], source }])));
    await expect(fetchLibraryIndex(new AbortController().signal)).rejects.toThrow();
  });
  it.each([{}, [], [{ ...index[0], authors: [{ name: 12 }] }], [{ ...index[0], name: 'x'.repeat(201) }],
    Array.from({ length: 2001 }, () => index[0])])('rejects malformed/bloated index fields', async value => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(value)));
    await expect(fetchLibraryIndex(new AbortController().signal)).rejects.toThrow();
  });
  it('bounds index streaming and strips non-rendered metadata', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new Uint8Array(LIBRARY_BYTES + 1)));
    await expect(fetchLibraryIndex(new AbortController().signal)).rejects.toThrow();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify([{ ...index[0], preview: 'javascript:bad', description: '<script>bad</script>' }])));
    expect(await fetchLibraryIndex(new AbortController().signal)).toEqual([{ name: index[0].name, authors: 'Example Author',
      url: 'https://libraries.excalidraw.com/libraries/example/architecture.excalidrawlib', preview: undefined }]);
    expect(fetch).toHaveBeenCalledWith('https://libraries.excalidraw.com/libraries.json',
      expect.objectContaining({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' }));
  });
});
