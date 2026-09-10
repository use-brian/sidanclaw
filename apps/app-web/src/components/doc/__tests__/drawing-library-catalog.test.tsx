// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://drawing.example"}
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { DrawingLibraryCatalog } from '../drawing-library-catalog';
import { catalogAnchor, officialHtml, officialScript } from './official-library-catalog';

const path = '/w/workspace/p/page';
const url = 'https://libraries.excalidraw.com/libraries/example/shapes.excalidrawlib';
const text = JSON.stringify({ type: 'excalidrawlib', version: 2, libraryItems: [{ id: 'shape', status: 'published', created: 1,
  elements: [{ id: 'shape', type: 'rectangle', x: 0, y: 0, width: 100, height: 80 }] }] });
let root: Root;
let host: HTMLDivElement;
const imported = vi.fn(async () => {});
const close = vi.fn();
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState({}, '', path);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(text)));
  vi.spyOn(window, 'open').mockImplementation(() => null);
  imported.mockClear(); close.mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function render() {
  await act(async () => root.render(<StrictMode><I18nProvider locale="en" dict={en}>
    <DrawingLibraryCatalog theme="dark" path={path} onClose={close} onImport={imported} />
  </I18nProvider></StrictMode>));
}
function message() {
  const frame = document.querySelector('iframe')!;
  return { origin: location.origin, source: frame.contentWindow, data: {
    type: 'brian:drawing-library', token: new URL(frame.src).searchParams.get('token'), url } };
}
async function send(value = message()) {
  await act(async () => window.dispatchEvent(new MessageEvent('message', value)));
}
describe('[COMP:app-web/drawing-library-catalog] iframe boundary', () => {
  it('uses the real catalog protocol, minimal sandbox and a private-data-free same-origin callback', async () => {
    await render();
    const frame = document.querySelector('iframe')!;
    const browse = new URL(frame.src);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.title).toBe(en.docPage.diagramSource.libraryBrowse);
    expect(browse.searchParams.get('referrer')).toBe(`${location.origin}/drawing-library-callback.html`);
    expect(browse.searchParams.get('theme')).toBe('dark');
    expect(browse.searchParams.get('token')).toMatch(/^[a-f0-9]{32}$/);
    let anchor!: Awaited<ReturnType<typeof catalogAnchor>>;
    // The mounted dialog's transition effects can finish during catalog parsing.
    await act(async () => { anchor = await catalogAnchor(frame.src); });
    expect(anchor.target).toBe('_self');
    expect(new URL(anchor.href).origin).toBe(location.origin);
    expect(new URL(anchor.href).pathname).toBe('/drawing-library-callback.html');
    expect(new URLSearchParams(new URL(anchor.href).hash.slice(1)).get('addLibrary')).toBe(url);
    expect(location.pathname).toBe(path); expect(location.search).toBe('');
    expect(window.open).not.toHaveBeenCalled();
    await send();
    expect(imported).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    await send(); expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(['origin', 'null', 'source', 'token', 'type', 'extra', 'url', 'size', 'route', 'expired'])('rejects %s without fetching', async kind => {
    await render(); const event = message();
    if (kind === 'origin') event.origin = 'https://libraries.excalidraw.com';
    if (kind === 'null') event.origin = 'null';
    if (kind === 'source') event.source = window;
    if (kind === 'token') event.data.token = '0'.repeat(32);
    if (kind === 'type') event.data.type = 'other';
    if (kind === 'extra') Object.assign(event.data, { account: 'unexpected' });
    if (kind === 'url') event.data.url = 'https://evil.example/a.excalidrawlib';
    if (kind === 'size') event.data.url = 'x'.repeat(2049);
    if (kind === 'route') window.history.replaceState({}, '', '/other');
    if (kind === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_001);
    await send(event);
    expect(fetch).not.toHaveBeenCalled(); expect(imported).not.toHaveBeenCalled();
  });
  it('serializes one selection, aborts on close/unmount, and rejects a stale frame after reopening', async () => {
    let resolve!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await render(); const stale = message();
    await send(stale); await send(stale); expect(fetch).toHaveBeenCalledOnce();
    const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!;
    await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
    await render();
    expect(message().data.token).not.toBe(stale.data.token);
    await send(stale);
    await act(async () => resolve(new Response(text)));
    expect(imported).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    await send(); expect(imported).toHaveBeenCalledOnce();
  });
  it('shows a failure and manual fallback, retaining an explicit close action', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    await render(); await send();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(en.docPage.diagramSource.libraryFailed);
    expect(document.body.textContent).toContain(en.docPage.diagramSource.libraryReturnHelp);
    const button = [...document.querySelectorAll('button')].find(button => button.textContent === en.docPage.diagramSource.close)!;
    await act(async () => button.click()); expect(close).toHaveBeenCalledOnce();
    expect(imported).not.toHaveBeenCalled();
  });
  it('runs only the hash-pinned static callback script, without app, auth or external resources', () => {
    const html = readFileSync(resolve(__dirname, '../../../../public/drawing-library-callback.html'), 'utf8');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
    expect(html).toContain(`script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'`);
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/src=|<iframe|<link|<form/);
    const postMessage = vi.fn();
    const location = { protocol: 'https:', origin: 'https://brian.example', hash: `#${new URLSearchParams({ token: 'a'.repeat(32), addLibrary: url })}` };
    const window = { parent: { postMessage } };
    runInNewContext(script, { window, location, URLSearchParams });
    expect(postMessage).toHaveBeenCalledWith({ type: 'brian:drawing-library', token: 'a'.repeat(32), url }, location.origin);
    postMessage.mockClear();
    runInNewContext(script, { window, location: { ...location, protocol: 'file:', origin: 'null' }, URLSearchParams });
    runInNewContext(script, { window, location: { ...location, hash: '#token=bad' }, URLSearchParams });
    expect(postMessage).not.toHaveBeenCalled();
  });
  it.runIf(process.env.LIVE_EXCALIDRAW_CATALOG === '1')('checks deployed catalog fixtures and framing headers', () => {
    const get = (path: string) => execFileSync('curl', ['--fail', '--silent', '--show-error', '--max-time', '30', `https://libraries.excalidraw.com/${path}`], { encoding: 'utf8' });
    expect(get('script.js')).toBe(officialScript); expect(get('')).toBe(officialHtml);
    const headers = execFileSync('curl', ['--fail', '--silent', '--show-error', '--head', 'https://libraries.excalidraw.com'], { encoding: 'utf8' });
    expect(headers.toLowerCase()).not.toMatch(/x-frame-options:|frame-ancestors/);
  }, 120_000);
});
