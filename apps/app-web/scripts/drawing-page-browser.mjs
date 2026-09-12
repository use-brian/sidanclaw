// [COMP:app-web/drawing] Production page hook, React node view and SDK, not an injected drawing session.
import { createServer, loadConfigFromFile, mergeConfig } from 'vite';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { tsImport } = require('tsx/esm/api');
const { Server, Y, resolveAuth, assertDrawingProtocol, localSessionRoutes } = await tsImport('../../doc-sync/src/__tests__/drawing-page-browser.fixture.ts', import.meta.url);
const apiRequire = createRequire(new URL('../../../packages/api/package.json', import.meta.url));
const express = apiRequire('express');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = fileURLToPath(new URL('..', import.meta.url));
const cache = await mkdtemp(join(tmpdir(), 'drawing-page-'));
const secret = 'synthetic-test-only';
let authenticated = 0;
const block = { kind: 'drawing', id: 'drawing', scene: {
  version: 1, elements: [{ id: 'saved', type: 'rectangle', x: 20, y: 20, width: 100, height: 80 }], files: {}, appState: { viewBackgroundColor: '#fff' },
} };
const seedDoc = new Y.Doc();
const embed = new Y.XmlElement('embed');
embed.setAttribute('blockId', block.id);
embed.setAttribute('block', JSON.stringify(block));
seedDoc.getXmlFragment('default').insert(0, [embed]);
const seed = Y.encodeStateAsUpdate(seedDoc);
assert.throws(() => assertDrawingProtocol({ doc: seedDoc, type: 2, update: seed,
  connection: { sendStateless() {}, close() {} } }), /drawing-protocol-reload-required/);
seedDoc.destroy();
const websocket = new Server({ port: 0, address: '127.0.0.1', quiet: true, stopOnSignals: false,
  onAuthenticate(data) {
    const auth = resolveAuth({ token: data.token, jwtSecret: secret });
    assert.equal(auth.kind, 'user');
    assert.equal(auth.userId, 'same-account');
    authenticated++;
    return auth;
  },
  beforeSync(data) { assertDrawingProtocol({ doc: data.document, protocol: data.context.drawingProtocol,
    type: data.type, update: data.payload, connection: data.connection }); },
  onLoadDocument({ document }) { Y.applyUpdate(document, seed); },
});
let server, browser;
try {
  await websocket.listen();
  const { config } = await loadConfigFromFile({ command: 'serve', mode: 'development' }, join(app, 'vite.desktop.config.ts'));
  server = await createServer(mergeConfig(config, { configFile: false, envFile: false, root: app, cacheDir: cache,
    define: { 'process.env': '{}' }, server: { port: 0, host: '127.0.0.1', fs: { allow: [resolve(app, '../../..'), cache] } } }));
  server.middlewares.stack.unshift({ route: '', handle(req, res, next) {
    if (req.url.startsWith('/w/')) req.url = '/scripts/fixtures/drawing-page.html';
    next();
  } });
  const auth = express();
  auth.use('/auth', localSessionRoutes({ jwtSecret: secret, isEnabled: () => true,
    createUser: async () => ({ user: { id: 'same-account', name: 'Synthetic editor', email: null, avatarUrl: null } }) }));
  server.middlewares.stack.unshift({ route: '', handle: auth });
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  const errors = [];
  const pages = [];
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  for (let i = 0; i < 2; i++) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    pages.push(page);
    page.setDefaultTimeout(60_000);
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    page.on('requestfailed', request => console.error(request.url(), request.failure()));
    const session = await page.request.post(`${origin}/auth/local-session`);
    assert.equal(session.status(), 200);
    const { accessToken: token, user } = await session.json();
    await page.addInitScript(({ url, token, user }) => {
      window.__USE_BRIAN_PUBLIC_CONFIG__ = { edition: 'oss', apiUrl: '', docSyncUrl: url, primaryAuthUrl: '' };
      document.cookie = `access_token=${token}; path=/`;
      document.cookie = `user=${encodeURIComponent(JSON.stringify(user))}; path=/`;
    }, { url: `ws://127.0.0.1:${websocket.address.port}`, token, user });
    await page.route(/^https?:\/\/[^/]+\/api\//, route => route.fulfill({ contentType: 'application/json', body: '[]' }));
    await page.goto(`${origin}/w/workspace/p/page`, { waitUntil: 'domcontentloaded' });
    try { await page.getByRole('img', { name: 'Drawing', exact: true }).locator('canvas').waitFor(); }
    catch (error) { console.error({ authenticated }, await page.locator('body').innerText(), await page.evaluate(() => ({ status: window.pageProbe?.collab.status, ws: window.pageProbe?.collab.provider?.configuration.websocketProvider.status, snapshot: window.pageProbe?.snapshot() }))); throw error; }
  }
  const [a, b] = pages;
  const preview = page => page.getByRole('img', { name: 'Drawing', exact: true }).locator('canvas');
  const before = await preview(b).evaluate(canvas => canvas.toDataURL());
  await a.getByRole('button', { name: 'Edit drawing', exact: true }).click();
  await a.getByRole('button', { name: 'Close', exact: true }).waitFor();
  assert.equal(await a.getByRole('button', { name: 'Save drawing', exact: true }).count(), 0, 'node view must receive page context');
  await a.waitForFunction(() => window.h?.app);
  await a.evaluate(() => {
    const app = window.h.app;
    app.updateScene({ elements: app.getSceneElements().map(e => ({ ...e, width: 240, version: e.version + 1 })) });
  });
  await b.waitForFunction(() => window.pageProbe.snapshot().page.blocks[0].scene.elements[0].width === 240);
  await b.waitForFunction(before => { const canvas = document.querySelector('[role="img"] canvas'); return canvas && canvas.toDataURL() !== before; }, before);
  assert.ok(await preview(b).count(), 'closed embed must paint the live scene');
  const settled = await preview(b).evaluate(canvas => canvas.toDataURL());
  await a.evaluate(() => {
    window.continuousDrawing = setInterval(() => {
      const app = window.h.app;
      app.updateScene({ elements: app.getSceneElements().map(e => ({ ...e, width: e.width + 1, version: e.version + 1 })) });
    }, 40);
  });
  await b.waitForFunction(before => { const canvas = document.querySelector('[role="img"] canvas'); return canvas && canvas.toDataURL() !== before; }, settled, { timeout: 5000 });
  await a.evaluate(() => clearInterval(window.continuousDrawing));
  const width = await a.evaluate(() => window.h.app.getSceneElements()[0].width);
  await b.getByRole('button', { name: 'Edit drawing', exact: true }).click();
  await b.waitForFunction(width => window.h?.app?.getSceneElements()[0]?.width === width, width);
  await a.waitForFunction(() => window.h.app.state.collaborators.size === 1);
  await b.waitForFunction(() => window.h.app.state.collaborators.size === 1);
  for (const page of pages) assert.equal(await page.evaluate(() => [...window.pageProbe.collab.doc.share.keys()]
    .filter(key => key.startsWith('drawing:') && window.pageProbe.collab.doc.getMap(key).size).length), 1,
  'late join must not split the immutable-base drawing namespace');
  const point = await a.evaluate(() => {
    const app = window.h.app, state = app.state, element = app.getSceneElements()[0];
    return { x: (element.x + 10 + state.scrollX) * state.zoom.value + state.offsetLeft,
      y: (element.y + state.scrollY) * state.zoom.value + state.offsetTop, before: element.x };
  });
  await a.keyboard.press('v');
  await a.mouse.move(point.x, point.y); await a.mouse.down();
  await a.mouse.move(point.x + 60, point.y + 40, { steps: 12 });
  await b.waitForFunction(x => window.h.app.getSceneElements()[0].x > x + 30, point.before);
  await b.waitForFunction(() => [...window.h.app.state.collaborators.values()].some(peer => peer.button === 'down' && peer.pointer));
  await a.mouse.up();
  await b.getByRole('button', { name: 'Close', exact: true }).click();
  await a.waitForFunction(() => window.h.app.state.collaborators.size === 0);
  await b.goto(`${origin}/w/workspace/p/page?readonly=1`, { waitUntil: 'domcontentloaded' });
  await preview(b).waitFor();
  assert.equal(await b.getByRole('button', { name: 'Edit drawing', exact: true }).count(), 0);
  await b.waitForFunction(x => window.pageProbe.snapshot().page.blocks[0].scene.elements[0].x > x + 30, point.before);
  const readonlyBefore = await preview(b).evaluate(canvas => canvas.toDataURL());
  await a.evaluate(() => {
    const app = window.h.app;
    app.updateScene({ elements: app.getSceneElements().map(e => ({ ...e, width: e.width + 100, version: e.version + 1 })) });
  });
  await b.waitForFunction(before => { const canvas = document.querySelector('[role="img"] canvas'); return canvas && canvas.toDataURL() !== before; }, readonlyBefore);
  await a.evaluate(() => window.pageProbe.collab.provider.configuration.websocketProvider.disconnect());
  await a.waitForFunction(() => window.pageProbe.collab.status === 'disconnected');
  await a.evaluate(() => window.pageProbe.collab.provider.configuration.websocketProvider.connect());
  await a.waitForFunction(() => window.pageProbe.collab.status === 'connected' && window.pageProbe.collab.provider.isAuthenticated);
  assert.ok(authenticated >= 2);
  assert.deepEqual(errors, []);
  console.log('PASS real OSS token endpoint + page hook + node view, capability/JWT WebSockets, continuous and read-only live previews, late join presence, held drag, reload and reconnect');
} finally {
  await browser?.close();
  await server?.close();
  await websocket.destroy();
  await rm(cache, { recursive: true, force: true });
}
