// [COMP:app-web/dev-route-discovery] Opt-in real Next server regression.
// Uses synthetic routes, temporary output and no application credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const require = createRequire(import.meta.url);
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nextRoot = dirname(require.resolve('next/package.json'));
const target = join(nextRoot, 'dist/server/lib/router-utils/setup-dev-bundler.js');
const temporary = await mkdtemp(join(tmpdir(), 'brian-route-discovery-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = new Set();

async function put(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

try {
  const source = await readFile(target, 'utf8');
  assert(source.includes('initialPageFiles.some'));

  for (const mode of ['webpack', 'turbopack']) {
    const fixture = join(temporary, mode);
    const page = join(fixture, 'app/w/[workspaceId]/p/[pageId]/page.js');
    await put(join(fixture, 'package.json'), JSON.stringify({ private: true, dependencies: { next: require('next/package.json').version, react: '19.2.4', 'react-dom': '19.2.4' } }));
    await symlink(join(app, 'node_modules'), join(fixture, 'node_modules'), 'junction');
    // The fixture and physical pnpm store are in different temporary/workspace
    // roots; only this disposable fixture needs their common filesystem root.
    await put(join(fixture, 'next.config.js'), 'module.exports = { devIndicators: false, turbopack: { root: "/" } };\n');
    await put(join(fixture, 'app/layout.js'), 'export default function Layout({children}) { return <html><body>{children}</body></html> }\n');
    await put(join(fixture, 'app/page.js'), 'export default function Page() { return "root" }\n');
    await put(join(fixture, 'app/[...legacy]/page.js'), 'import {notFound} from "next/navigation"; export default function Page() { notFound() }\n');
    await put(join(fixture, 'app/w/[workspaceId]/p/page.js'), 'export default function Page() { return "index" }\n');
    await put(page, 'export default function Page() { return "canonical-leaf-v1" }\n');
    await put(join(fixture, 'app/w/[workspaceId]/studio/skills/page.js'), 'export default function Page() { return "nested-static-leaf" }\n');
    const preload = join(fixture, 'delay.cjs');
    await put(preload, `
const fs = require('node:fs');
const originalReaddir = fs.readdir;
const delayed = new Set();
fs.readdir = function(directory, ...args) {
  if (String(directory).includes('/app/w/') &&
      (String(directory).endsWith('/[pageId]') || String(directory).endsWith('/skills')) &&
      !delayed.has(directory) && new Error().stack.includes('watchpack')) {
    delayed.add(directory);
    console.log('[route-scan-delay]');
    return setTimeout(() => originalReaddir.call(this, directory, ...args), 8000);
  }
  return originalReaddir.call(this, directory, ...args);
};
`);
    const port = await freePort();
    let log = '';
    const child = spawn(process.execPath, [join(nextRoot, 'dist/bin/next'), 'dev', `--${mode}`, '--port', String(port)], {
      cwd: fixture,
      env: { PATH: process.env.PATH, NEXT_TELEMETRY_DISABLED: '1', NODE_OPTIONS: `--require=${preload}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    child.stdout.on('data', (data) => { log += data; });
    child.stderr.on('data', (data) => { log += data; });
    const deadline = Date.now() + 30000;
    while (!log.includes('[route-scan-delay]')) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(log);
      await sleep(20);
    }
    await sleep(150);
    const response = await fetch(`http://127.0.0.1:${port}/w/route-probe/p/page-probe`, { signal: AbortSignal.timeout(60000) });
    const html = await response.text();
    assert.equal(response.status, 200, `${mode}: ${log}`);
    console.log(`PASS ${mode}: delayed initial deep scan -> HTTP ${response.status}`);
    {
      assert(html.includes('canonical-leaf-v1'));
      for (let version = 2; version <= 4; version++) {
        await put(page, `export default function Page() { return "canonical-leaf-v${version}" }\n`);
        await sleep(500);
        for (const path of ['/w/route-probe/p/page-probe', '/w/route_probe/p/page_probe', '/w/route.probe/p/page.probe', '/w/route-probe/studio/skills']) {
          const result = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(60000) });
          const body = await result.text();
          assert.equal(result.status, 200, `${path}: ${log}`);
          assert(body.includes(path.endsWith('/skills') ? 'nested-static-leaf' : `canonical-leaf-v${version}`));
        }
      }
      console.log(`PASS ${mode}: three edit rounds, nested static leaf, hyphen/underscore/dot IDs`);
    }
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    children.delete(child);
  }
} finally {
  for (const child of children) child.kill('SIGTERM');
  await Promise.all([...children].map((child) => new Promise((resolve) => child.once('exit', resolve))));
  await rm(temporary, { recursive: true, force: true });
}
