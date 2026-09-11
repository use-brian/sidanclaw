// [COMP:app-web/drawing-library] Real cached-canvas grid regression, no network.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { resolveCollabSingletonAliases } from '../../../scripts/collab-singletons.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = fileURLToPath(new URL('..', import.meta.url));
const cache = await mkdtemp(join(tmpdir(), 'brian-grid-browser-'));
const server = await createServer({ configFile: false, root: app, cacheDir: cache,
  define: { 'process.env': '{}' },
  publicDir: join(app, 'public'), plugins: [react(), tailwind()], css: { postcss: { plugins: [] } },
  resolve: { alias: [{ find: '@', replacement: join(app, 'src') },
    ...Object.entries(resolveCollabSingletonAliases(new URL('../package.json', import.meta.url))).map(([find, replacement]) => ({ find, replacement })),
    { find: '@use-brian/shared/drawing', replacement: resolve(app, '../../packages/shared/src/drawing.ts') }] },
  server: { port: 0, host: '127.0.0.1', hmr: false, fs: { allow: [resolve(app, '../../..'), cache] } } });
server.middlewares.stack.unshift({ route: '', handle: (req, _res, next) => {
  if (req.url.startsWith('/w/')) req.url = '/scripts/fixtures/drawing-library-browser.html';
  next();
} });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  for (const deviceScaleFactor of [1, 2]) {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor });
    const page = await context.newPage();
    page.on('pageerror', error => console.error(error));
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    await page.goto(`http://localhost:${server.httpServer.address().port}/w/workspace/p/page`);
    await page.getByRole('button', { name: 'Edit drawing', exact: true }).click();
    await page.waitForFunction(() => window.h?.app && [...document.querySelectorAll('button')].some(b => b.textContent === 'Browse libraries' && !b.disabled));
    for (const size of [160, 173, 240, 320]) {
      const result = await page.evaluate(async size => {
        const app = window.h.app;
        const items = await app.library.getLatestLibrary();
        if (items.length !== 38 || items.some(item => item.name === 'use-brian')) throw new Error('Unexpected defaults');
        const logo = items.find(item => item.name === 'use-brian-bordered');
        const elements = logo.elements.map(e => ({ ...e, x: 300 + e.x * size / 160,
          y: 300 + e.y * size / 160, width: e.width * size / 160, height: e.height * size / 160 }));
        app.updateScene({ elements, appState: { scrollX: 0, scrollY: 0, zoom: { value: 1 } } });
        await new Promise(resolve => setTimeout(resolve, 300));
        const canvas = document.querySelector('canvas.excalidraw__canvas.static');
        const ctx = canvas.getContext('2d');
        const dpr = devicePixelRatio;
        // Sample both pixels straddling each shared edge, away from eyes/corners.
        const green = (x, y) => ctx.getImageData(Math.floor(x * dpr), Math.floor(y * dpr), 1, 1).data[1];
        const borders = elements.filter(e => e.backgroundColor === '#121e33');
        const samples = [];
        for (const e of borders) {
          if (borders.some(n => n.x === e.x + e.width && n.y === e.y)) {
            samples.push(Math.min(green(e.x + e.width - 0.5, e.y + e.height / 2), green(e.x + e.width + 0.5, e.y + e.height / 2)));
          }
          if (borders.some(n => n.y === e.y + e.height && n.x === e.x)) {
            samples.push(Math.min(green(e.x + e.width / 2, e.y + e.height - 0.5), green(e.x + e.width / 2, e.y + e.height + 0.5)));
          }
        }
        const body = green(elements[2].x + 4, elements[2].y + 4);
        return { edges: samples.length, min: Math.min(...samples), max: Math.max(...samples), body };
      }, size);
      console.log({ deviceScaleFactor, size, ...result });
      assert.equal(result.edges, 44);
      assert.equal(result.body, 229, 'Sample the actual rendered cyan body, not an empty canvas');
      assert.ok(result.max < 100, 'Every shared grid edge must remain dark on the real SDK canvas');
    }
    await context.close();
  }
} finally {
  await browser?.close(); await server.close(); await rm(cache, { recursive: true, force: true });
}
