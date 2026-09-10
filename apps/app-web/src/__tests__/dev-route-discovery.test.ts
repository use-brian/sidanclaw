import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('[COMP:app-web/dev-route-discovery] upstream Next startup barrier', () => {
  it('uses the upstream fix without a local dependency patch', () => {
    expect(require('next/package.json').version).toBe('16.4.0-canary.25');
    const source = readFileSync(require.resolve('next/dist/server/lib/router-utils/setup-dev-bundler.js'), 'utf8');
    expect(source).toContain('initialPageFiles.some');
    expect(source).toContain('!knownFiles.has(file)');
    expect(source).toContain('initialScanDeadline');
  });
});
