import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, root)), 'utf8');

describe('[COMP:app-web/dev-route-discovery] pinned Next startup barrier', () => {
  it('locks the exact backport for the installed Next version', () => {
    const version = JSON.parse(read('apps/app-web/package.json')).dependencies.next;
    const path = `patches/next@${version}.patch`;
    const patch = read(path);
    const hash = createHash('sha256').update(patch).digest('hex');
    expect(read('pnpm-workspace.yaml')).toContain(`next@${version}: ${path}`);
    expect(read('pnpm-lock.yaml')).toContain(`hash: ${hash}`);
    expect(read('pnpm-lock.yaml')).toContain(`path: ${path}`);
    const parentWorkspace = new URL('../pnpm-workspace.yaml', root);
    if (existsSync(parentWorkspace)) {
      const workspace = readFileSync(parentWorkspace, 'utf8');
      if (workspace.includes('use-brian/apps/*')) {
        expect(workspace).toContain(`next@${version}: use-brian/${path}`);
        const lock = read('../pnpm-lock.yaml');
        expect(lock).toContain(`hash: ${hash}`);
        expect(lock).toContain(`path: use-brian/${path}`);
      }
    }
    expect(patch).toContain('initialPageFiles.some');
    expect(patch).toContain('!knownFiles.has(file)');
    expect(patch).toContain('initialScanDeadline');
  });
});
