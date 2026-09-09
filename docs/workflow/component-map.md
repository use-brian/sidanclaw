# Public Feature Components

| COMP tag | doc path | source path | test path |
| --- | --- | --- | --- |
| shared/drawing | docs/page-drawing.md | packages/shared/src/drawing.ts | packages/shared/src/__tests__/drawing.test.ts; packages/shared/src/__tests__/drawing-preview.test.ts |
| app-web/drawing | docs/page-drawing.md | apps/app-web/src/components/doc/block-drawing.tsx; apps/app-web/src/components/doc/drawing-editor.tsx; apps/app-web/src/components/doc/drawing-runtime.ts; apps/app-web/src/components/doc/drawing-transaction.ts; apps/app-web/scripts/excalidraw-assets.mjs | apps/app-web/src/components/doc/__tests__/drawing.test.tsx; apps/app-web/src/components/doc/__tests__/drawing-restoration.test.ts |
| doc-model/drawing | docs/page-drawing.md | packages/doc-model/src/block-mapping.ts; packages/doc-model/src/apply-ops.ts; packages/core/src/views/blocks.ts | packages/doc-model/src/__tests__/drawing.test.ts |
| doc/drawing-read | docs/page-drawing.md | packages/core/src/doc/drawing-result.ts; packages/core/src/doc/tools.ts; packages/core/src/doc/soul.ts; packages/core/src/engine/tool-executor.ts | packages/core/src/doc/__tests__/get-block.test.ts; packages/core/src/engine/__tests__/tool-executor.test.ts |
| api/drawing | docs/page-drawing.md | packages/api/src/routes/views.ts; packages/api/src/db/saved-views-store.ts | packages/api/src/routes/__tests__/views.test.ts |
