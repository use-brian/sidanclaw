import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Vitest for apps/app-web. Scoped to pure-logic unit tests (no DOM)
 * — the `@/` alias mirrors the tsconfig path so `@/`-imported modules
 * resolve.
 */
export default defineConfig({
  // Next's PostCSS plugin-string format is not a Vite plugin object. Unit
  // tests don't need Tailwind generation when a lazy component imports CSS.
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Excalidraw's browser ESM uses extensionless roughjs imports; resolve it
    // through Vite for actual-runtime restoration tests rather than Node ESM.
    server: { deps: { inline: [/@excalidraw\/excalidraw/, /roughjs/] } },
    // Shims `localStorage` for Node 26+ (its experimental built-in is undefined
    // without --localstorage-file and shadows jsdom's). See vitest.setup.ts.
    setupFiles: ["./vitest.setup.ts"],
  },
});
