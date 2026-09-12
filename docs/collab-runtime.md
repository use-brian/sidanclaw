# Collaborative Editor Runtime

## Native Doc-Sync Runtime

Doc-sync must install its collaboration resolver before loading the server import
graph, for both `tsx src/index.ts` (the OSS launcher) and `node dist/index.js`.
Resolve Yjs/y-prosemirror from doc-model and ProseMirror from its Tiptap peer
anchor, then pin their physical ESM files. The same version in two pnpm stores
is not one constructor; neither are the import/require exports of one package.
Do not repair this by duck-typing XML, skipping nodes or catching conversion
errors and substituting an empty page.

The native regression must run the real entrypoint outside Vitest's aliases,
substituting only environment/database boundaries with synthetic local state.
It must exercise Hocuspocus load/store hooks, populated nested content, live
drawing registers and binary/canonical reload. An unsupported XML node must
still fail without publishing a partial snapshot.

Binary and canonical projection remain one successful document write. A failed
projection rejects the store, leaving the previous coherent row unchanged and
Hocuspocus retaining the live document. Writing just `ydoc` to that row would
silently desynchronize snapshot readers, seq/CAS and downstream ingestion. A
separate durable quarantine/recovery journal would need its own lifecycle and
reader contract; this fix does not introduce one. Retention in RAM is NOT durable:
do not restart an affected process or clear browser storage before preserving
the latest complete Yjs update from a connected client (including drawing maps)
and verifying that the preserved bytes reload. Ordinary text/Markdown export
does not preserve drawing registers or CRDT history. After preservation, deploy
the fixed runtime, reconnect the retained client state and verify a successful
store/reload before retiring backups. No production data repair is automatic.

Native verification: `pnpm --filter @use-brian/doc-sync test` runs the subprocess
regression outside Vitest resolution. It includes a controlled y-prosemirror
import of Yjs's CJS export, proving the original store failure without the
bootstrap and successful complete saves with it. To inspect the installed
physical-store baseline, run `NATIVE_BASELINE=1 node --import tsx
src/__tests__/native-runtime.fixture.mjs` from `apps/doc-sync`. That diagnostic
expects an affected installation; it is not a portable clean-install test.
After building doc-sync and its dependencies, `NATIVE_COMPILED=1 node --import
tsx src/__tests__/native-runtime.fixture.mjs` tests its compiled entrypoint and
native package exports. The fixture replaces dotenv and the query boundary,
never reads an environment file or opens an application database, and closes
its ephemeral HTTP server and real Hocuspocus documents normally.

### Selection Warning

An atom-only drawing page reproduces `TextSelection endpoint not pointing into
a node with inline content (doc)` on initial editor mount, without executing
any Brian block insertion/selection command. In y-prosemirror 1.3.7,
`ProsemirrorBinding._forceRerender` (`src/plugins/sync-plugin.js:462`) clamps the
old selection to the new document size but unconditionally constructs a
TextSelection, even when that position is outside a textblock. An isolated
real Tiptap/Collaboration mount captured that stack and verified the canonical
snapshot was unchanged. This upstream cursor-restoration warning is separate
from the server's foreign-Yjs-constructor failure. It remains unfixed here;
do not suppress it or insert synthetic paragraphs to hide it.

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
from doc-model's own dependencies, never from app-web.
Doc-sync persistence tests also use doc-model's singleton graph and inline the
doc-model package itself: its native externalization otherwise mixes the absorbed
workspace's older y-prosemirror peers with the schema's newer ProseMirror classes.
Tests exercising Hocuspocus's MessageReceiver inline the server package too, so
its Document constructor uses the same Yjs instance as the test and doc-model.
DOM tests optimize
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

### Server Awareness Lifetime

Doc-sync pins `@hocuspocus/server` to 4.2.0. Upstream 4.1.0's production
`MessageReceiver.apply` allocates a scratch `Awareness(new Y.Doc())` per inbound
awareness packet and never destroys either object. Awareness's 3-second interval
retains both even after the real document/server closes; drawing traffic can
amplify this by 20 packets per second per active client. A hook cannot safely
repair it because the scratch instance is private to the receiver.

Upstream 4.2.0 adds `try/finally` around decode, async awareness hooks and encode,
destroying both scratch instances on success and error before applying the
result to the live awareness. Use that existing compatible release, not a
monkeypatch or a worker/process lifetime workaround. The standalone lock already
resolved 4.2.0; the absorbing platform lock must also resolve 4.2.0 and the app
manifest must exclude 4.1.0. Keep both lock importers aligned when changing this
pin. Node >=22 and Yjs 13.6.31 remain unchanged; provider versions need not change.

The receiver regression sends 400 real encoded awareness packets per scenario
through the installed package at a simulated 20 Hz, checks interval count and
live awareness state/metadata cardinality after each packet, and checks that
each scratch document is destroyed. Cover accepted/mutated hooks, async hook
rejections, malformed decode and failed encode, while live presence and Y.Doc
content remain intact. The browser regression runs an in-process Hocuspocus
server and must shut down normally, without terminating a worker to hide timers.

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
