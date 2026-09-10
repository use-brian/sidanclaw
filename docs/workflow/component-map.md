# Public Feature Components

Drawing-library coverage includes a direct JSON/search picker for local origins,
an in-app sandboxed catalog for public HTTPS, origin/source/token
validation and cancellation, alongside bounded desktop download/import and real-SDK
import regressions. The opt-in browser test uses the live official catalog.

| COMP tag | doc path | source path | test path |
| --- | --- | --- | --- |
| app-web/collab-runtime | docs/collab-runtime.md | scripts/collab-singletons.mjs; apps/app-web/next.config.ts; apps/app-web/vite.desktop.config.ts; apps/app-web/vitest.config.ts; packages/doc-model/vitest.config.ts | apps/app-web/src/components/doc/__tests__/collab-runtime.test.ts; apps/app-web/scripts/collab-runtime-browser.mjs; packages/doc-model/src/__tests__/encode.test.ts |
| app-web/dev-route-discovery | docs/dev-routing.md | apps/app-web/package.json | apps/app-web/src/__tests__/dev-route-discovery.test.ts; apps/app-web/scripts/route-discovery-regression.mjs |
| app-web/home-suggested | docs/home-suggested.md | apps/app-web/src/components/doc/suggested-view.tsx | apps/app-web/src/components/doc/__tests__/suggested-view-hydration.test.tsx; apps/app-web/src/components/doc/__tests__/suggested-view-chat.test.tsx |
| app-web/drawing-library | docs/page-drawing.md | apps/app-web/src/components/doc/drawing-library.ts; apps/app-web/src/components/doc/drawing-editor.tsx; apps/app-web/src/components/doc/block-drawing.tsx; apps/app-web/src/components/doc/collab-page-editor.tsx | apps/app-web/src/components/doc/__tests__/drawing-library.test.tsx; apps/app-web/src/components/doc/__tests__/drawing-library-sdk.test.tsx |
| shared/drawing | docs/page-drawing.md | packages/shared/src/drawing.ts | packages/shared/src/__tests__/drawing.test.ts; packages/shared/src/__tests__/drawing-preview.test.ts |
| app-web/drawing | docs/page-drawing.md | apps/app-web/src/components/doc/block-drawing.tsx; apps/app-web/src/components/doc/drawing-editor.tsx; apps/app-web/src/components/doc/drawing-runtime.ts; apps/app-web/src/components/doc/drawing-transaction.ts; apps/app-web/scripts/excalidraw-assets.mjs | apps/app-web/src/components/doc/__tests__/drawing.test.tsx; apps/app-web/src/components/doc/__tests__/drawing-restoration.test.ts |
| doc-model/drawing | docs/page-drawing.md | packages/doc-model/src/block-mapping.ts; packages/doc-model/src/apply-ops.ts; packages/core/src/views/blocks.ts; packages/core/src/doc/ops.ts | packages/doc-model/src/__tests__/drawing.test.ts |
| doc/drawing-read | docs/page-drawing.md | packages/core/src/doc/drawing-result.ts; packages/core/src/doc/tools.ts; packages/core/src/doc/soul.ts; packages/core/src/doc/outline.ts; packages/core/src/engine/tool-executor.ts | packages/core/src/doc/__tests__/get-block.test.ts; packages/core/src/engine/__tests__/tool-executor.test.ts |
| api/drawing | docs/page-drawing.md | packages/api/src/routes/views.ts; packages/api/src/db/saved-views-store.ts | packages/api/src/routes/__tests__/views.test.ts |
| app-web/drawing-library-catalog | docs/page-drawing.md | apps/app-web/src/components/doc/drawing-library-catalog.tsx; apps/app-web/src/components/doc/drawing-library.ts; apps/app-web/public/drawing-library-callback.html | apps/app-web/src/components/doc/__tests__/drawing-library-catalog.test.tsx; apps/app-web/src/components/doc/__tests__/drawing-library-local.test.tsx; apps/app-web/src/components/doc/__tests__/drawing.test.tsx; apps/app-web/scripts/drawing-library-browser.mjs |
