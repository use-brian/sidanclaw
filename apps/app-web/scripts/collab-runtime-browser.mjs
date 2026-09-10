// [COMP:app-web/collab-runtime] Real Next/Turbopack + React editor regression.
// Only disposable output, synthetic documents and disconnected providers.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { resolveCollabSingletonAliases, collabTurbopackAliases } from '../../../scripts/collab-singletons.mjs';

const collabSingletonAliases = resolveCollabSingletonAliases(new URL('../package.json', import.meta.url));

const require = createRequire(import.meta.url);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = fileURLToPath(new URL('..', import.meta.url));
const fixture = await mkdtemp(join(tmpdir(), 'brian-collab-runtime-'));
const baseline = process.argv.includes('--baseline');
const webpack = process.argv.includes('--webpack');
const vite = process.argv.includes('--vite');
const aliases = baseline ? {} : collabSingletonAliases;
const requireProbe = join(app, 'scripts/fixtures/collab-require.cjs');
let child, browser, viteServer, log = '';
const errors = [];
const warnings = [];
try {
  await symlink(join(app, 'node_modules'), join(fixture, 'node_modules'), 'junction');
  await mkdir(join(fixture, 'app'));
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ private: true }));
  await writeFile(join(fixture, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    jsx: 'react-jsx', moduleResolution: 'bundler', paths: { '@/*': [relative(fixture, join(app, 'src/*'))] },
  } }));
  // Evaluate the actual Next config with only dotenv replaced, so no .env is
  // opened. Next's transpiler keeps all other config code and resolution real.
  const originalLoad = Module._load;
  let actualConfig;
  try {
    Module._load = function(id, ...args) { return id === 'dotenv' ? { config() {} } : originalLoad.call(this, id, ...args); };
    const { transpileConfig } = require('next/dist/build/next-config-ts/transpile-config');
    actualConfig = (await transpileConfig({ nextConfigPath: join(app, 'next.config.ts'), dir: app })).default;
  } finally { Module._load = originalLoad; }
  assert.deepEqual(actualConfig.turbopack.resolveAlias, collabTurbopackAliases(app));
  const webpackAliases = actualConfig.webpack({ resolve: { alias: {} } }).resolve.alias;
  assert.deepEqual(webpackAliases, collabSingletonAliases);
  await writeFile(join(fixture, 'next.config.mjs'), `export default {
    devIndicators: false, allowedDevOrigins: ['127.0.0.1'], turbopack: { root: '/', resolveAlias: ${JSON.stringify({ ...(baseline ? {} : collabTurbopackAliases(fixture)), 'collab-require-probe': `./${relative(fixture, requireProbe)}` })} },
    webpack(config) { Object.assign(config.resolve.alias, ${JSON.stringify({ ...aliases, 'collab-require-probe': requireProbe })}); return config; }
  }`);
  await writeFile(join(fixture, 'app/layout.jsx'), 'export default function Layout({children}) { return <html><body>{children}</body></html> }');
  await writeFile(join(fixture, 'app/page.jsx'), `export { default } from ${JSON.stringify(relative(join(fixture, 'app'), join(app, 'scripts/fixtures/collab-runtime.tsx')))};`);
  const reservation = createServer();
  await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  if (vite) {
    const { createServer, loadConfigFromFile, mergeConfig } = await import('vite');
    const { config } = await loadConfigFromFile({ command: 'serve', mode: 'development' }, join(app, 'vite.desktop.config.ts'));
    await writeFile(join(fixture, 'index.html'), '<div id="root"></div><script type="module" src="/main.jsx"></script>');
    await writeFile(join(fixture, 'main.jsx'), `import React from 'react'; import { createRoot } from 'react-dom/client'; import { MemoryRouter } from 'react-router-dom'; import Fixture from ${JSON.stringify(relative(fixture, join(app, 'scripts/fixtures/collab-runtime.tsx')))}; createRoot(document.getElementById('root')).render(<React.StrictMode><MemoryRouter><Fixture /></MemoryRouter></React.StrictMode>);`);
    viteServer = await createServer(mergeConfig(config, { configFile: false, envFile: false, root: fixture, cacheDir: join(fixture, 'vite-cache'),
      resolve: { alias: { 'collab-require-probe': requireProbe } },
      optimizeDeps: { include: ['collab-require-probe'] },
      server: { port, host: '127.0.0.1', fs: { allow: [app, fileURLToPath(new URL('../../..', import.meta.url)), fixture] } } }));
    await viteServer.listen();
  } else {
    child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', webpack ? '--webpack' : '--turbopack', '--port', String(port)], {
      cwd: fixture, env: { PATH: process.env.PATH, NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', data => { log += data; });
    child.stderr.on('data', data => { log += data; });
    const deadline = Date.now() + 60000;
    while (!log.includes('Ready in')) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(log);
      await new Promise(r => setTimeout(r, 100));
    }
  }
  browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  const context = await browser.newContext();
  // Never allow the component's API effects to reach an application service.
  await context.route(/^https?:\/\/[^/]+\/api\//, route => route.fulfill({ contentType: 'application/json', body: '{}' }));
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  const modules = new Set();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') warnings.push(m.text()); });
  page.on('response', async response => {
    if (!response.url().includes('/_next/static/chunks/') || !response.url().endsWith('.js')) return;
    const text = await response.text().catch(() => '');
    for (const match of text.matchAll(/\[project\][^"\n]*(?:yjs\.(?:mjs|cjs)|prosemirror-view\/dist\/index\.(?:js|cjs))/g)) modules.add(match[0]);
  });
  await page.goto(`http://127.0.0.1:${port}`, { timeout: 600000, waitUntil: 'domcontentloaded' });
  if (baseline) {
    const deadline = Date.now() + 120000;
    while (!errors.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 500));
    console.log(JSON.stringify({ baseline: true, identities: await page.evaluate(() => window.collabProbe?.identities), encodingErrors: await page.evaluate(() => window.collabProbe?.encodingErrors), errors, warnings, modules: [...modules] }, null, 2));
    assert(errors.some(e => /localsInner/.test(e)), 'baseline must reproduce decoration crash');
    assert(warnings.some(w => /Yjs was already imported/.test(w)), 'baseline must reproduce duplicate Yjs');
  } else {
    await page.waitForFunction(() => window.collabProbe, null, { timeout: 120000 });
    await page.locator('.tiptap').waitFor();
    assert.deepEqual(await page.evaluate(() => window.collabProbe.identities), { modelDoc: true, providerDoc: true, converterDoc: true, schemaNode: true,
      requireDoc: true, requireDecoration: true, requireNode: true });
    assert.deepEqual(await page.evaluate(() => window.collabProbe.encodingErrors), []);
    for (let round = 0; round < 4; round++) {
      const active = round % 2;
      await page.waitForFunction(i => document.querySelector('[data-active]')?.dataset.active === String(i), active);
      await page.locator('.tiptap').filter({ hasText: active ? 'Beta' : 'Alpha' }).waitFor();
      const sets = await page.evaluate(() => window.collabProbe.decorate());
      assert(sets.length >= 2 && sets.every(Boolean), `foreign decoration constructor: ${sets}`);
      await page.locator('[data-comment-draft]').waitFor();
      await page.locator('.tiptap').click();
      await page.keyboard.press('End');
      await page.keyboard.type(` edit${round}`);
      assert(JSON.stringify(await page.evaluate(i => window.collabProbe.snapshot(i), active)).includes(`edit${round}`));
      await page.evaluate(() => window.collabProbe.toggle());
      await page.locator('.tiptap').waitFor({ state: 'detached' });
      await page.evaluate(() => window.collabProbe.toggle());
      await page.locator('.tiptap').filter({ hasText: `edit${round}` }).waitFor();
      await page.evaluate(() => window.collabProbe.switchDoc());
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    assert(!log.includes('Yjs was already imported'), 'SSR must not import duplicate Yjs either');
    if (!vite && !webpack) {
      assert.equal([...modules].filter(path => path.endsWith('/yjs.mjs')).length, 1);
      assert.equal([...modules].filter(path => path.endsWith('/prosemirror-view/dist/index.js')).length, 1);
      assert([...modules].every(path => !path.endsWith('.cjs')), 'singleton packages must stay ESM');
    }
    console.log(JSON.stringify({ pass: vite ? 'vite' : webpack ? 'webpack' : 'turbopack', rounds: 4, identities: await page.evaluate(() => window.collabProbe.identities), errors, warnings, modules: [...modules] }, null, 2));
  }
} catch (error) {
  console.error(log);
  console.error({ errors, warnings });
  throw error;
} finally {
  await browser?.close();
  await viteServer?.close();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(r => child.once('exit', r));
  }
  await rm(fixture, { recursive: true, force: true });
}
