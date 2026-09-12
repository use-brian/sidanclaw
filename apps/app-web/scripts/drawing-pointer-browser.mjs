// [COMP:app-web/drawing] Real modal + SDK + host toolbar, no catalog network.
// PLAYWRIGHT_MODULE / CHROMIUM_EXECUTABLE may use external browser dependencies.
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
const cache = await mkdtemp(join(tmpdir(), 'brian-pointer-browser-'));
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
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.setDefaultTimeout(90_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${server.httpServer.address().port}/w/workspace/p/page`, { waitUntil: 'domcontentloaded' });
  const bubbleMounted = () => page.evaluate(() => window.hostEditor.state.plugins.some(p => p.key.startsWith('bubbleMenu')));
  await page.waitForFunction(() => window.hostEditor?.state.plugins.some(p => p.key.startsWith('bubbleMenu')));
  await page.getByRole('button', { name: 'Edit drawing', exact: true }).click();
  await page.waitForFunction(() => window.h?.app && [...document.querySelectorAll('button')].some(b => b.textContent === 'Browse libraries' && !b.disabled));
  assert.equal(await bubbleMounted(), false);
  const canvas = await page.locator('canvas.interactive').boundingBox();
  const x = canvas.x + 400, y = canvas.y + 250;
  const snapshot = () => page.evaluate(() => {
    const app = window.h.app, state = app.state;
    return { cursor: state.cursorButton, marquee: state.selectionElement, dragging: state.selectedElementsAreBeingDragged,
      resizing: state.isResizing, newElement: state.newElement,
      selected: state.selectedElementIds, elements: JSON.stringify(app.getSceneElements()) };
  });
  async function released(label) {
    await page.waitForTimeout(100);
    const before = await snapshot();
    assert.equal(before.cursor, 'up', `${label}: release reaches SDK window listener`);
    assert.equal(before.marquee, null, `${label}: marquee cleared`);
    assert.equal(before.dragging, false, `${label}: drag finished`);
    assert.equal(before.resizing, false, `${label}: resize finished`);
    assert.equal(before.newElement, null, `${label}: creation finished`);
    await page.mouse.move(x + 250, y + 180, { steps: 4 });
    await page.waitForTimeout(100);
    assert.deepEqual(await snapshot(), before, `${label}: no-button motion cannot continue gesture`);
    assert.equal(await bubbleMounted(), false);
    assert.equal(await page.locator('[data-selection-comment-chip]').count(), 0);
    console.log(`PASS ${label}: cursor up, gesture cleared, no hover mutation, host toolbar suppressed`);
    return before;
  }
  // Optional negative control recreates only the faulty release boundary, not SDK behavior.
  if (process.env.DRAWING_BLOCK_RELEASE === '1') {
    await page.evaluate(() => document.querySelector('[role="dialog"]').addEventListener('pointerup', e => e.stopPropagation()));
  }
  await page.mouse.click(x, y);
  await released('single left click');
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 100, y + 80, { steps: 5 });
  assert.notEqual((await snapshot()).marquee, null);
  await page.mouse.up();
  await released('marquee drag');
  await page.keyboard.press('r');
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 100, y + 80, { steps: 5 }); await page.mouse.up();
  const drawn = await released('rectangle draw');
  assert.equal(JSON.parse(drawn.elements).length, 1);
  await page.keyboard.press('v');
  await page.mouse.move(x + 50, y); await page.mouse.down();
  await page.mouse.move(x + 100, y + 40, { steps: 5 }); await page.mouse.up();
  const moved = await released('shape move');
  assert.notEqual(moved.elements, drawn.elements);
  await page.mouse.click(x - 30, y - 30);
  await page.mouse.move(x - 30, y - 30); await page.mouse.down();
  await page.mouse.move(x + 200, y + 150, { steps: 5 }); await page.mouse.up();
  const selected = await released('marquee selects shape');
  assert.equal(Object.values(selected.selected).filter(Boolean).length, 1);
  // Release on modal header, outside the canvas, must also finish the window gesture.
  await page.mouse.move(x - 100, y + 150); await page.mouse.down();
  await page.mouse.move(x, canvas.y - 10, { steps: 5 }); await page.mouse.up();
  await released('outside-canvas release');
  // Network-free UI feedback regression with the actual SDK and compiled theme CSS.
  assert.equal(await page.locator('.main-menu-trigger').isVisible(), false);
  assert.equal(await page.locator('.dropdown-menu-container').count(), 0);
  await page.route('https://libraries.excalidraw.com/libraries.json', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify([{ name: 'Example shapes', authors: [{ name: 'Example Author' }], source: 'example/shapes.excalidrawlib' }]),
  }));
  const draft = (await snapshot()).elements;
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 360, height: 740 }, { width: 740, height: 360 }]) {
      await page.setViewportSize(viewport);
      await page.getByRole('button', { name: 'Browse libraries', exact: true }).click();
      const catalog = page.getByRole('dialog', { name: 'Browse libraries', exact: true });
      await catalog.getByRole('button', { name: 'Import library: Example shapes', exact: true }).waitFor();
      const bounds = await catalog.boundingBox();
      assert.ok(bounds.x >= 8 && bounds.y >= 8 && bounds.x + bounds.width <= viewport.width - 8 && bounds.y + bounds.height <= viewport.height - 8);
      assert.ok(bounds.width <= 1152 && bounds.height <= 896);
      const style = await catalog.evaluate(el => {
        const s = getComputedStyle(el);
        return { border: s.borderTopWidth, shadow: s.boxShadow, overflow: s.overflow, background: s.backgroundColor };
      });
      assert.equal(style.border, '1px');
      assert.notEqual(style.shadow, 'none');
      assert.equal(style.overflow, 'hidden');
      assert.notEqual(style.background, 'rgba(0, 0, 0, 0)');
      assert.notEqual(await page.locator('.backdrop-blur-sm').evaluate(el => getComputedStyle(el).backdropFilter), 'none');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (viewport.width < 640) {
        for (const name of ['Close', 'Import library: Example shapes']) {
          assert.ok((await catalog.getByRole('button', { name, exact: true }).boundingBox()).height >= 44);
        }
        assert.equal(await catalog.getByRole('searchbox').evaluate(el => getComputedStyle(el).fontSize), '16px');
      }
      if (process.env.DRAWING_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.DRAWING_SCREENSHOT_DIR, `drawing-catalog-${theme}-${viewport.width}.png`) });
      await catalog.getByRole('button', { name: 'Close', exact: true }).focus();
      await page.keyboard.press('Escape');
      await catalog.waitFor({ state: 'detached' });
      assert.equal((await snapshot()).elements, draft);
      assert.equal(await bubbleMounted(), false);
    }
  }
  console.log('PASS empty SDK menu hidden; bounded catalog, scrim, border/shadow, phone targets and nested Escape in light/dark at desktop, phone and landscape sizes');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForFunction(() => window.hostEditor.state.plugins.some(p => p.key.startsWith('bubbleMenu')));
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.deepEqual(await page.evaluate(() => ({ text: window.hostEditor.getText(), from: window.hostEditor.state.selection.from, to: window.hostEditor.state.selection.to })),
    { text: 'Host page text', from: 1, to: 5 });
  assert.deepEqual(errors, []);
  console.log('PASS Cancel restores host bubble plugin and preserves host text selection; no page errors');
} finally {
  await browser?.close(); await server.close(); await rm(cache, { recursive: true, force: true });
}
