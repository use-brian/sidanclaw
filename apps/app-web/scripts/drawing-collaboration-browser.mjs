// [COMP:app-web/drawing] Offline Yjs exchange plus real Hocuspocus WebSocket SDK clients.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const syncRequire = createRequire(new URL('../../doc-sync/package.json', import.meta.url));
const { Server } = syncRequire('@hocuspocus/server');
import { resolveCollabSingletonAliases } from '../../../scripts/collab-singletons.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = fileURLToPath(new URL('..', import.meta.url));
const cache = await mkdtemp(join(tmpdir(), 'brian-drawing-collab-'));
const server = await createServer({ configFile: false, root: app, cacheDir: cache,
  define: { 'process.env': '{}' }, publicDir: join(app, 'public'),
  plugins: [react(), tailwind()], css: { postcss: { plugins: [] } },
  resolve: { alias: [{ find: '@', replacement: join(app, 'src') },
    ...Object.entries(resolveCollabSingletonAliases(new URL('../package.json', import.meta.url))).map(([find, replacement]) => ({ find, replacement })),
    { find: '@use-brian/shared/drawing', replacement: resolve(app, '../../packages/shared/src/drawing.ts') }] },
  server: { port: 0, host: '127.0.0.1', hmr: false, fs: { allow: [resolve(app, '../../..'), cache] } } });
server.middlewares.stack.unshift({ route: '', handle: (req, _res, next) => {
  if (req.url.startsWith('/w/')) req.url = '/scripts/fixtures/drawing-library-browser.html';
  next();
} });
let browser;
let websocket;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  const pages = await Promise.all([browser.newPage({ viewport: { width: 1200, height: 900 } }), browser.newPage({ viewport: { width: 1200, height: 900 } })]);
  const errors = [];
  for (const page of pages) {
    page.setDefaultTimeout(60_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.cursorPaints = 0;
      window.selectionPaints = 0;
      const fillText = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(text, ...args) {
        if (text === 'Synthetic editor') window.cursorPaints++;
        return fillText.call(this, text, ...args);
      };
      const strokeRect = CanvasRenderingContext2D.prototype.strokeRect;
      CanvasRenderingContext2D.prototype.strokeRect = function(...args) {
        if (this.canvas.classList.contains('interactive') && this.getLineDash().length) window.selectionPaints++;
        return strokeRect.apply(this, args);
      };
    });
    await page.goto(`http://localhost:${server.httpServer.address().port}/w/workspace/p/page?live=1`);
    await page.getByRole('button', { name: 'Edit drawing', exact: true }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).waitFor();
    await page.waitForFunction(() => window.h?.app);
    assert.equal(await page.getByRole('button', { name: 'Save drawing', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Cancel', exact: true }).count(), 0);
  }
  const [a, b] = pages;
  const snapshot = page => page.evaluate(() => window.drawingTest.snapshot());
  const elements = page => page.evaluate(() => window.h.app.getSceneElements().map(e => ({ id: e.id, x: e.x, y: e.y, isDeleted: e.isDeleted })));
  async function sync() {
    const updates = await Promise.all(pages.map(page => page.evaluate(() => window.drawingTest.encode())));
    await a.evaluate(bytes => window.drawingTest.receive(bytes), updates[1]);
    await b.evaluate(bytes => window.drawingTest.receive(bytes), updates[0]);
    await a.waitForTimeout(150);
  }
  async function draw(page, offset) {
    const canvas = await page.locator('canvas.interactive').boundingBox();
    await page.keyboard.press('r');
    await page.mouse.move(canvas.x + 350 + offset, canvas.y + 250);
    await page.mouse.down();
    await page.mouse.move(canvas.x + 450 + offset, canvas.y + 330, { steps: 4 });
    await page.mouse.up();
    await page.waitForFunction(() => window.drawingTest.snapshot().page.blocks[0].scene.elements.length > 0);
  }
  await draw(a, 0); await draw(b, 180);
  await sync();
  assert.equal((await elements(a)).length, 2);
  assert.deepEqual(await elements(a), await elements(b));
  assert.deepEqual((await snapshot(a)).page, (await snapshot(b)).page);
  console.log('PASS two offline SDK shape creations converge without Save');

  const initial = await elements(a);
  async function move(page, id, x) {
    await page.evaluate(({ id, x }) => {
      const app = window.h.app;
      app.updateScene({ elements: app.getSceneElements().map(e => e.id === id ? { ...e, x, version: e.version + 1, versionNonce: Math.floor(Math.random() * 100000) } : e) });
    }, { id, x });
    await page.waitForTimeout(150);
  }
  await move(a, initial[0].id, 120); await move(b, initial[1].id, 600);
  await sync();
  assert.deepEqual((await elements(a)).map(e => e.x), [120, 600]);
  assert.deepEqual(await elements(a), await elements(b));
  await a.evaluate(() => window.drawingTest.text());
  await a.keyboard.press('Control+z');
  await sync();
  assert.equal((await elements(b))[1].x, 600);
  assert.equal((await snapshot(a)).page.blocks[1].text, 'Changed text');
  assert.notEqual((await elements(a))[0].x, 120);
  await a.getByRole('button', { name: 'Redo drawing', exact: true }).click();
  await sync();
  assert.deepEqual((await elements(a)).map(e => e.x), [120, 600]);
  console.log('PASS independent SDK moves and local-only drawing undo/redo');

  await move(a, initial[0].id, 220); await move(b, initial[0].id, 320);
  await sync();
  assert.deepEqual(await elements(a), await elements(b));
  await a.evaluate(id => {
    const app = window.h.app;
    app.updateScene({ elements: app.getSceneElements().map(e => e.id === id ? { ...e, isDeleted: true, version: e.version + 1 } : e) });
  }, initial[0].id);
  await move(b, initial[0].id, 420);
  await sync();
  assert.equal((await elements(a)).length, 1);
  assert.deepEqual(await elements(a), await elements(b));
  console.log('PASS same-element register conflict and delete-wins reconciliation');

  await a.getByRole('textbox', { name: 'Drawing name', exact: true }).fill('Shared sketch');
  await a.getByRole('button', { name: 'Close', exact: true }).click();
  await sync();
  assert.equal((await snapshot(b)).page.blocks[0].title, 'Shared sketch');
  await a.getByRole('button', { name: 'Edit drawing', exact: true }).click();
  await a.waitForFunction(() => window.h?.app?.getSceneElements().length === 1);
  assert.deepEqual(await elements(a), await elements(b));
  await sync();
  const bytes = await a.evaluate(() => window.drawingTest.encode());
  await a.waitForTimeout(1500);
  await sync();
  const settled = await a.evaluate(() => window.drawingTest.encode());
  await a.waitForTimeout(300);
  await sync();
  assert.deepEqual(await a.evaluate(() => window.drawingTest.encode()), settled, 'no remote render feedback writes');
  assert.ok(settled.length >= bytes.length);
  console.log('PASS shared title, Close/reopen, and quiescent CRDT after rendering');
  // Unlike sync() above, this phase uses actual Hocuspocus WebSocket messages.
  websocket = new Server({ port: 0, address: '127.0.0.1', quiet: true, stopOnSignals: false });
  await websocket.listen();
  const wsUrl = `ws://127.0.0.1:${websocket.address.port}`;
  for (const page of pages) await page.evaluate(url => window.drawingTest.connect(url), wsUrl);
  for (const page of pages) await page.waitForFunction(() => window.h.app.state.collaborators.size === 1);
  const liveId = (await elements(a))[0].id;
  async function startDrag(page, id) {
    await page.keyboard.press('v');
    const point = await page.evaluate(id => {
      const app = window.h.app, state = app.state, element = app.getSceneElements().find(e => e.id === id);
      app.updateScene({ appState: { selectedElementIds: {} } });
      return { x: (element.x + 10 + state.scrollX) * state.zoom.value + state.offsetLeft,
        y: (element.y + state.scrollY) * state.zoom.value + state.offsetTop };
    }, id);
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    return point;
  }
  const beforeDrag = (await elements(a))[0];
  await b.evaluate(() => { window.cursorPaints = 0; window.selectionPaints = 0; });
  const point = await startDrag(a, liveId);
  await a.mouse.move(point.x + 40, point.y + 30, { steps: 8 });
  await b.waitForFunction(({ id, x }) => window.h.app.getSceneElements().find(e => e.id === id)?.x > x + 20, { id: liveId, x: beforeDrag.x });
  await b.waitForFunction(id => [...window.h.app.state.collaborators.values()].some(c => c.button === 'down' && c.selectedElementIds[id] && c.pointer), liveId);
  await b.waitForFunction(() => window.cursorPaints > 0);
  await b.waitForFunction(() => window.selectionPaints > 0);
  assert.equal(await a.evaluate(() => window.h.app.state.cursorButton), 'down');
  await a.mouse.move(point.x + 80, point.y + 60, { steps: 8 });
  await b.waitForFunction(({ id, x }) => window.h.app.getSceneElements().find(e => e.id === id)?.x > x + 60, { id: liveId, x: beforeDrag.x });
  await a.mouse.up();
  await b.waitForFunction(() => [...window.h.app.state.collaborators.values()][0]?.button === 'up');
  console.log('PASS WebSocket cursor canvas painting, collaborator selection and two intermediate held-drag positions');

  await draw(b, 0);
  await a.waitForFunction(() => window.h.app.getSceneElements().length === 2);
  const ids = (await elements(a)).map(e => e.id);
  const beforeBoth = await elements(a);
  const pa = await startDrag(a, ids[0]);
  const pb = await startDrag(b, ids[1]);
  await a.mouse.move(pa.x + 30, pa.y + 20, { steps: 5 });
  await b.mouse.move(pb.x + 40, pb.y + 20, { steps: 5 });
  await a.waitForTimeout(200);
  assert.ok((await elements(a)).find(e => e.id === ids[1]).x > beforeBoth[1].x + 20, 'remote element moves while local mouse is down');
  assert.ok((await elements(b)).find(e => e.id === ids[0]).x > beforeBoth[0].x + 20, 'both clients receive intermediate geometry');
  assert.equal(await a.evaluate(() => window.h.app.state.cursorButton), 'down');
  assert.equal(await b.evaluate(() => window.h.app.state.cursorButton), 'down');
  await a.mouse.move(pa.x + 60, pa.y + 40, { steps: 5 });
  await b.mouse.move(pb.x + 80, pb.y + 40, { steps: 5 });
  await a.mouse.up(); await b.mouse.up();
  await a.waitForTimeout(300);
  assert.deepEqual(await elements(a), await elements(b));
  assert.ok((await elements(a))[0].x > beforeBoth[0].x + 40);
  assert.ok((await elements(a))[1].x > beforeBoth[1].x + 60);
  assert.deepEqual((await snapshot(a)).page, (await snapshot(b)).page);
  console.log('PASS WebSocket simultaneous local/remote held drags converge');

  const sameA = await startDrag(a, ids[0]);
  const sameB = await startDrag(b, ids[0]);
  const sameBefore = (await elements(a))[0].x;
  await a.mouse.move(sameA.x + 30, sameA.y + 15, { steps: 5 });
  await b.waitForTimeout(150);
  assert.equal((await elements(b))[0].x, sameBefore, 'remote edit cannot stomp local held selection');
  await b.mouse.move(sameB.x + 60, sameB.y + 30, { steps: 5 });
  await a.waitForTimeout(150);
  assert.ok(Math.abs((await elements(a))[0].x - sameBefore - 30) < 1);
  await a.mouse.up(); await b.mouse.up();
  await a.waitForTimeout(300);
  assert.deepEqual(await elements(a), await elements(b));
  assert.deepEqual((await snapshot(a)).page, (await snapshot(b)).page);
  console.log('PASS WebSocket same-element active gesture protection and release convergence');

  await a.waitForTimeout(1500); // Let the derived preview settle first.
  const persistedBeforePresence = await Promise.all(pages.map(page => page.evaluate(() => window.drawingTest.encode())));
  await b.evaluate(id => window.h.app.updateScene({ appState: { selectedElementIds: { [id]: true } } }), ids[1]);
  await b.mouse.move(800, 500, { steps: 20 });
  await a.waitForFunction(id => [...window.h.app.state.collaborators.values()][0]?.selectedElementIds[id], ids[1]);
  assert.deepEqual(await Promise.all(pages.map(page => page.evaluate(() => window.drawingTest.encode()))), persistedBeforePresence,
    'pointer and selection awareness never persist or echo scene writes');
  console.log('PASS WebSocket pointer/selection traffic leaves both Y.Doc encodings unchanged');

  await b.evaluate(() => {
    const awareness = window.drawingProvider.awareness;
    awareness.setLocalStateField('drawing', { ...awareness.getLocalState().drawing, scope: 'drawing:other:epoch' });
  });
  await a.waitForFunction(() => window.h.app.state.collaborators.size === 0);
  await b.evaluate(() => window.drawingTest.showDrawing('second-drawing'));
  await b.getByRole('button', { name: 'Edit drawing', exact: true }).click();
  await b.waitForFunction(() => window.drawingProvider.awareness.getLocalState().drawing?.scope.includes('second-drawing'));
  await a.waitForTimeout(150);
  assert.equal(await a.evaluate(() => window.h.app.state.collaborators.size), 0);
  assert.equal(await b.evaluate(() => window.h.app.state.collaborators.size), 0);
  await b.evaluate(() => window.drawingTest.showDrawing('drawing'));
  await b.getByRole('button', { name: 'Edit drawing', exact: true }).click();
  await a.waitForFunction(() => window.h.app.state.collaborators.size === 1);
  await b.evaluate(() => window.drawingProvider.configuration.websocketProvider.disconnect());
  await a.waitForFunction(() => window.h.app.state.collaborators.size === 0);
  await b.waitForFunction(() => window.h.app.state.collaborators.size === 0 && window.drawingProvider.awareness.getLocalState().drawing === null);
  assert.deepEqual(await b.evaluate(() => window.drawingProvider.awareness.getLocalState().cursor), { anchor: 'host-cursor' });
  await b.evaluate(() => window.drawingProvider.configuration.websocketProvider.connect());
  await a.waitForFunction(() => window.h.app.state.collaborators.size === 1);
  await b.getByRole('button', { name: 'Close', exact: true }).click();
  await a.waitForFunction(() => window.h.app.state.collaborators.size === 0);
  await b.getByRole('button', { name: 'Edit drawing', exact: true }).click();
  await a.waitForFunction(() => window.h.app.state.collaborators.size === 1);
  console.log('PASS WebSocket drawing/epoch isolation, Close, disconnect and reconnect cleanup');
  for (const viewport of [{ width: 360, height: 740 }, { width: 740, height: 360 }]) {
    await a.setViewportSize(viewport);
    const bounds = await a.getByRole('dialog', { name: 'Shared sketch', exact: true }).boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height);
    assert.equal(await a.getByRole('button', { name: 'Close', exact: true }).isVisible(), true);
    assert.equal(await a.locator('canvas.interactive').isVisible(), true);
  }
  console.log('PASS live editor fits phone and landscape viewports');
  await b.evaluate(() => window.drawingTest.permission(false));
  await b.getByRole('button', { name: 'Close', exact: true }).waitFor({ state: 'hidden' });
  await a.waitForFunction(() => window.h.app.state.collaborators.size === 0);
  await b.evaluate(() => window.drawingTest.permission(true));
  await b.getByRole('button', { name: 'Edit drawing', exact: true }).click();
  await a.waitForFunction(() => window.h.app.state.collaborators.size === 1);
  await b.evaluate(() => window.drawingTest.route());
  await a.waitForFunction(() => window.h.app.state.collaborators.size === 0);
  assert.equal(await b.evaluate(() => window.drawingProvider.awareness.getLocalState().drawing), null);
  await a.evaluate(() => window.drawingTest.replace());
  await a.getByRole('button', { name: 'Close', exact: true }).waitFor({ state: 'hidden' });
  assert.equal((await snapshot(a)).page.blocks[0].scene.elements.length, 0);
  console.log('PASS permission loss and scene replacement close live editor');
  const saved = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await saved.goto(`http://localhost:${server.httpServer.address().port}/w/workspace/p/page?live=1&seed=1`);
  await saved.getByRole('button', { name: 'Edit drawing', exact: true }).click();
  await saved.waitForFunction(() => window.h?.app?.getSceneElements().length === 1);
  await saved.waitForTimeout(500);
  assert.deepEqual(await saved.evaluate(() => window.drawingTest.elementWrites()), [], 'SDK restoration must not seed element overrides');
  console.log('PASS saved legacy scene opens without competing element seeds');
  const overflow = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  overflow.setDefaultTimeout(120_000);
  overflow.on('pageerror', error => errors.push(error.message));
  await overflow.goto(`http://localhost:${server.httpServer.address().port}/w/workspace/p/page?live=1`);
  await overflow.waitForFunction(() => window.drawingTest);
  await overflow.evaluate(() => window.drawingTest.oversizedUnion());
  for (let open = 0; open < 2; open++) {
    await overflow.getByRole('button', { name: 'Edit drawing', exact: true }).click();
    await overflow.getByRole('button', { name: 'Close', exact: true }).waitFor();
    await overflow.waitForFunction(() => window.h?.app?.getSceneElements().length === 5002);
    await overflow.waitForTimeout(300);
    if (open === 0) await overflow.getByRole('button', { name: 'Close', exact: true }).click();
  }
  await overflow.evaluate(() => {
    const app = window.h.app;
    app.updateScene({ appState: { selectedElementIds: Object.fromEntries(app.getSceneElements().slice(0, 2).map(e => [e.id, true])) } });
  });
  await overflow.keyboard.press('Delete');
  await overflow.waitForFunction(() => window.drawingTest.snapshot().page.blocks[0].scene.elements.length === 5000);
  assert.equal(await overflow.evaluate(() => window.drawingTest.persistedSnapshot().page.blocks[0].scene.elements.length), 5000);
  await overflow.getByRole('button', { name: 'Close', exact: true }).click();
  await overflow.getByRole('button', { name: 'Edit drawing', exact: true }).click();
  await overflow.waitForFunction(() => window.h?.app?.getSceneElements().length === 5000);
  console.log('PASS reopened 5002-element union publishes its first two-element deletion and persists 5000 elements');
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await websocket?.destroy();
  await server.close();
  await rm(cache, { recursive: true, force: true });
}
