import { cpSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const app = fileURLToPath(new URL('..', import.meta.url));
const source = resolve(dirname(require.resolve('@excalidraw/excalidraw')), 'fonts');
for (const target of ['public/excalidraw/fonts', 'desktop/public/excalidraw/fonts']) {
  const destination = resolve(app, target);
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true });
}
