import { defineConfig } from 'vitest/config';
import { resolveCollabSingletonAliases } from '../../scripts/collab-singletons.mjs';

export default defineConfig({
  resolve: { alias: resolveCollabSingletonAliases(import.meta.url) },
  test: {
    // Native externalization would bypass the canonical ESM aliases in peers.
    server: { deps: { inline: [/@tiptap\//, /prosemirror-/, /yjs/, /y-prosemirror/, /y-protocols/] } },
  },
});
