# Collaborative Editor Runtime

The browser must use one physical ESM instance of Yjs, y-prosemirror and the
ProseMirror packages used by Tiptap. Version pins alone do not guarantee this:
an absorbed pnpm workspace can retain links into a previous standalone store,
and a package's CommonJS and ESM exports have different constructors even at
the same physical location and version.

Resolve singleton entrypoints from app-web's installed dependencies using
`createRequire`, canonicalize the paths, then select the package's ESM entry.
Next Turbopack, webpack and desktop Vite must use these same aliases. Turbopack
requires app-relative alias targets; webpack and Vite accept absolute files.
Vite also deduplicates React and React DOM, which Next handles internally.
Vitest must inline the collaboration peer graph so its Node externalization
does not bypass the aliases. Native doc-model tests resolve the same policy
from doc-model's own dependencies, never from app-web. DOM tests optimize
the actual Base UI subpath entrypoints, Lucide and Excalidraw's React consumers
(Jotai, Radix, tunnel-rat) together with React/React DOM: externalizing
their CommonJS hook shims would bypass Vite's React deduplication. Keep
Excalidraw and roughjs inline so jsdom can use their native Node dependencies
without converting Node crypto into a browser compatibility stub. Do not
alias every dependency, suppress Yjs warnings, or patch decoration plugins to
accept foreign constructors. No root overrides or cache deletion are needed.

Yjs checks document identity when integrating shared types. ProseMirror's
`DecorationGroup.from` checks `instanceof DecorationSet`; a foreign set is
mistaken for a group and supplies an undefined member, crashing `localsInner`.
The regression must exercise actual constructors, doc-model encoding, a real
Hocuspocus provider and the collaborative React editor with simultaneous
decorations, edits, remounts and page-document switches. Use disposable Next
output and synthetic data, with no authentication or live sync service.

Next's compiled-config loader cannot resolve sibling helpers. Its resolver is
therefore self-contained; the browser harness evaluates the actual config with
dotenv disabled and asserts parity with the Vite helper before launching.

## Verification

From the repository root, run
`node apps/app-web/scripts/collab-runtime-browser.mjs` for Turbopack, with
`--webpack` for webpack or `--vite` for the desktop configuration. Set
`PLAYWRIGHT_MODULE` to an external Playwright module and optionally
`CHROMIUM_EXECUTABLE` when Chromium is not installed in Playwright's default
location. All server output and Vite caches are disposable; the application
dev server and its `.next` are not used. API effects are fulfilled with
synthetic responses and the real Hocuspocus socket has `autoConnect: false`.

`--baseline` omits the singleton aliases and is a diagnostic for a mixed
installation, not a test expected to fail on a healthy install. It records
encoder failures before independently exercising the editor with synthetic
Yjs XML. The original mixed graph loaded two physical **ESM** copies of Yjs
13.6.31 and ProseMirror-view 1.41.8/1.41.9, reproducing the duplicate-import
warning, two `Not same Y.Doc` warnings and the `localsInner` crash. With the
aliases the browser must report all constructor probes true, no encoding
failures, no browser warnings/errors, and four successful edit/remount/switch
rounds. The CommonJS probe additionally prevents a future dual-export split.

`collab-runtime.test.ts` runs the actual doc-model/Yjs/Tiptap/Hocuspocus path
under jsdom, including concurrent find/comment decorations and isolation of
the inactive document. It is not a source-string assertion or a mocked editor.

Bundler aliases do not repair native Node resolution in an already mixed
installation. A frozen pnpm install may report "Already up to date" while
retaining old physical symlinks. Both Vitest projects therefore apply the
consumer-anchored resolver and keep constructor-sensitive dependencies inside
the test module graph. The original app config was verified independently:
the unchanged drawing suite failed 12/14 tests with duplicate React, and
doc-model's original default config failed 9/9 encode/drawing tests with
duplicate ProseMirror. These are installation/externalization failures, not
changes to the drawing data model. Never suppress their errors or replace
the SDK/editor with mocks to make the tests pass.

After changing bundler configuration, restart the web/desktop dev process and
reload browser tabs. Existing loaded module graphs cannot be repaired by an
HTTP 200 or by replacing only one hot module.
