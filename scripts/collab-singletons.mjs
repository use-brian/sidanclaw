import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';

// Anchor to the consumer, not this helper or an enclosing workspace's store.
export function resolveCollabSingletonAliases(configUrl) {
  const consumerRequire = createRequire(configUrl);
  const pmRoot = resolve(dirname(consumerRequire.resolve('@tiptap/pm/view')), '../..');
  const pm = JSON.parse(readFileSync(resolve(pmRoot, 'package.json'), 'utf8'));
  const pmRequire = createRequire(resolve(pmRoot, 'package.json'));
  return Object.fromEntries(
    ['yjs', 'y-prosemirror', ...Object.keys(pm.dependencies).filter(name => name.startsWith('prosemirror-'))]
      .map(name => {
        const entry = (name.startsWith('prosemirror-') ? pmRequire : consumerRequire).resolve(name);
        const root = resolve(dirname(entry), '..');
        const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
        // Aliasing a package directory still permits require/import to select
        // different constructors. Pin its ESM file, not its CJS-resolved entry.
        return [name, realpathSync(resolve(root, manifest.module))];
      }),
  );
}

/** Turbopack resolves aliases from the app directory, not turbopack.root. */
export function collabTurbopackAliases(appDirectory) {
  const aliases = resolveCollabSingletonAliases(resolve(appDirectory, 'package.json'));
  return Object.fromEntries(Object.entries(aliases).map(([name, path]) =>
    [name, `./${relative(appDirectory, path).replaceAll('\\', '/')}`]));
}
