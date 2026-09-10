import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// Verbatim full deployed HTML and script, MIT (c) 2020 Excalidraw.
// https://github.com/excalidraw/excalidraw-libraries/blob/main/script.js
// Git blob 7de6b11fd5b9b6fc697c0d566383368c6eafe0e7, verified 2026-09-09.
// The live contract test verifies both files against the deployed source.
export const officialScript = readFileSync(resolve(__dirname, 'fixtures/official-library-script.js.txt'), 'utf8');
export const officialHtml = readFileSync(resolve(__dirname, 'fixtures/official-library-index.html.txt'), 'utf8');
const { JSDOM, VirtualConsole } = createRequire(import.meta.url)('jsdom');

async function catalogPage(browse: string, source = 'example/shapes.excalidrawlib', referrer?: string, denyStorage = false) {
  const errors: Error[] = [];
  const requests: string[] = [];
  const history: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error: Error) => errors.push(error));
  let domContentLoaded = false;
  const dom = new JSDOM(officialHtml.replace('<script src="script.js"></script>', () => `<script>${officialScript}</script>`), {
    url: browse, referrer, runScripts: 'dangerously', virtualConsole,
    // No external subresources are loaded. Only catalog data XHR is substituted.
    beforeParse(window: Window & typeof globalThis) {
      window.document.addEventListener('DOMContentLoaded', () => { domContentLoaded = true; });
      for (const method of ['pushState', 'replaceState'] as const) {
        const original = window.history[method].bind(window.history);
        window.history[method] = (...args) => { original(...args); history.push(window.location.href); };
      }
      // jsdom has no layout-backed innerText implementation.
      Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
        get() { return this.textContent; }, set(value) { this.textContent = value; }, configurable: true,
      });
      if (denyStorage) {
        for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(window, name, {
          get() { throw new Error('catalog-storage-access'); },
        });
      }
      window.XMLHttpRequest = class {
        readyState = 0; status = 0; responseText = ''; path = '';
        onreadystatechange = () => {};
        open(_method: string, path: string) { this.path = path; requests.push(path); }
        send() {
          window.setTimeout(() => {
            this.responseText = JSON.stringify(this.path === 'libraries.json'
              ? [{ name: 'Shapes', source, authors: [], version: 2 }] : {});
            this.readyState = 4; this.status = 200; this.onreadystatechange();
          }, 0);
        }
      } as unknown as typeof XMLHttpRequest;
    },
  });
  const window = dom.window as Window & typeof globalThis;
  const anchor = () => window.document.querySelector<HTMLAnchorElement>('.library:not(#template) .install-library');
  for (let i = 0; i < 100 && (!domContentLoaded || !anchor()) && !errors.length; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  if (errors.length || !anchor() || !domContentLoaded) {
    window.close();
    throw errors[0] ?? new Error('catalog-startup-incomplete');
  }
  return { window, anchor: () => anchor()!, requests, history, errors, domContentLoaded, close: () => window.close() };
}

export async function catalogAnchor(browse: string, source?: string) {
  const page = await catalogPage(browse, source);
  try { return page.anchor().cloneNode(true) as HTMLAnchorElement; }
  finally { page.close(); }
}
