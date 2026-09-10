// [COMP:app-web/drawing-library-catalog] Opt-in network/browser regression.
// PLAYWRIGHT_MODULE may point to an external Playwright install. No Next server,
// application auth, real account data or persisted dev cache is used.
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
const screenshots = process.env.DRAWING_SCREENSHOT_DIR || tmpdir();
const cache = await mkdtemp(join(tmpdir(), 'brian-library-browser-'));
const server = await createServer({ configFile: false, root: app, cacheDir: cache,
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
  const port = server.httpServer.address().port;
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // Real HTTP localhost, with no routing interception on the success path.
  let fetches = 0;
  context.on('request', req => { if (req.url().endsWith('software-architecture.excalidrawlib')) fetches++; });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto(`http://localhost:${port}/w/workspace/p/page`);
   await page.getByRole('button', { name: 'Edit drawing', exact: true }).click();
   await page.getByRole('button', { name: 'Browse libraries', exact: true }).waitFor();
   await page.waitForFunction(() => window.h?.app && [...document.querySelectorAll('button')].some(button => button.textContent === 'Browse libraries' && !button.disabled));
   await page.getByRole('textbox', { name: 'Drawing name' }).fill('Unsaved catalog name');
   await page.getByRole('textbox', { name: 'Drawing name' }).press('Enter');
   await page.getByRole('textbox', { name: 'Drawing name' }).fill('Revert this edit');
   await page.getByRole('textbox', { name: 'Drawing name' }).press('Escape');
   assert.equal(await page.getByRole('textbox', { name: 'Drawing name' }).inputValue(), 'Unsaved catalog name');
  await page.locator('.excalidraw').waitFor();
  await page.locator('.excalidraw canvas.interactive').click({ position: { x: 300, y: 300 } });
  await page.keyboard.press('r');
  await page.mouse.move(400, 400); await page.mouse.down(); await page.mouse.move(550, 500); await page.mouse.up();
  const scene = await page.evaluate(() => { window.originalApp = window.h.app; return JSON.stringify(window.h.app.getSceneElements()); });
   assert.equal(JSON.parse(scene).length, 1);
   await page.screenshot({ path: join(screenshots, 'drawing-title-desktop.png') });
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Browse libraries', exact: true }).click();
    assert.equal(await page.locator('iframe').count(), 0);
     await page.getByRole('searchbox', { name: 'Search libraries' }).fill('Software Architecture');
     const image = page.getByRole('img', { name: 'Library preview: Software Architecture', exact: true });
     await image.scrollIntoViewIfNeeded();
     await page.waitForFunction(() => [...document.images].some(img => img.alt === 'Library preview: Software Architecture' && img.naturalWidth > 0));
     assert.equal(fetches, i);
     if (i === 0) {
       assert.equal(await page.evaluate(() => localStorage.getItem(window.scope.key)), null);
       await page.screenshot({ path: join(screenshots, 'drawing-library-desktop.png') });
     }
    await page.getByRole('button', { name: 'Import library: Software Architecture', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.library-unit__active:not(:has(.library-unit__adder))').length === 7);
    await page.getByRole('searchbox', { name: 'Search libraries' }).waitFor({ state: 'detached' });
    assert.equal(context.pages().length, 1);
    assert.equal(await page.evaluate(() => window.originalApp === window.h.app), true);
    assert.equal(await page.evaluate(() => JSON.stringify(window.h.app.getSceneElements())), scene);
    assert.equal(await page.getByRole('textbox', { name: 'Drawing name' }).inputValue(), 'Unsaved catalog name');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem(window.scope.key)).flatMap(item => item.elements).length), 41);
  }
  assert.equal(fetches, 2);
  console.log(`PASS ${page.url()}: live JSON index + Software Architecture, 7 tiles / 41 elements, repeat dedup, one tab, live scene/title/SDK preserved`);
   await page.setViewportSize({ width: 390, height: 844 });
   await page.getByRole('textbox', { name: 'Drawing name' }).fill('Long drawing title '.repeat(10));
   await page.getByRole('textbox', { name: 'Drawing name' }).press('Enter');
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
   await page.screenshot({ path: join(screenshots, 'drawing-title-mobile.png') });
   await page.getByRole('textbox', { name: 'Drawing name' }).fill('Unsaved catalog name');
   await page.getByRole('textbox', { name: 'Drawing name' }).press('Enter');
  await page.getByRole('button', { name: 'Browse libraries', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search libraries' }).fill('Software Architecture');
   await page.getByRole('button', { name: 'Import library: Software Architecture', exact: true }).waitFor();
   await page.getByRole('img', { name: 'Library preview: Software Architecture', exact: true }).scrollIntoViewIfNeeded();
   await page.waitForFunction(() => [...document.images].some(img => img.alt === 'Library preview: Software Architecture' && img.naturalWidth > 0));
   await page.screenshot({ path: join(screenshots, 'drawing-library-mobile.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('dialog').last().getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(await page.locator('iframe').count(), 0);
  assert.equal(await page.getByRole('textbox', { name: 'Drawing name' }).inputValue(), 'Unsaved catalog name');
  console.log('PASS mobile panel fits viewport and Close preserves draft');
  await context.route('https://libraries.excalidraw.com/libraries.json', route => route.abort());
  await page.getByRole('button', { name: 'Browse libraries', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await context.unroute('https://libraries.excalidraw.com/libraries.json');
  await page.getByRole('button', { name: 'Retry catalog', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search libraries' }).fill('Software Architecture');
  await page.getByRole('button', { name: 'Import library: Software Architecture', exact: true }).waitFor();
  await page.getByRole('dialog').last().getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(context.pages().length, 1);
  assert.equal(await page.getByRole('textbox', { name: 'Drawing name' }).inputValue(), 'Unsaved catalog name');
  console.log('PASS blocked catalog network: visible error, in-panel Retry loads real index, Close preserves draft');
} finally {
  await browser?.close(); await server.close(); await rm(cache, { recursive: true, force: true });
}
