// Only IO boundaries and test visibility are replaced. No collaboration aliases.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const require = createRequire(import.meta.url)

export async function resolve(specifier, context, nextResolve) {
  // Controlled dual-export installation, including on a clean single-store CI.
  // The production bootstrap must resolve this bare import before it gets here.
  if (process.env.NATIVE_MIX && specifier === 'yjs' && context.parentURL?.includes('/y-prosemirror/')) {
    return nextResolve(pathToFileURL(require.resolve('yjs')).href, context)
  }
  if (specifier === 'dotenv') return { url: 'data:text/javascript,export default {config(){}}', shortCircuit: true }
  if (specifier === '@use-brian/api/db/client.js' || (specifier.endsWith('/client.js') && context.parentURL?.includes('/db/'))) {
    return { url: new URL('./native-runtime.store.mjs', import.meta.url).href, shortCircuit: true }
  }
  if (specifier === '@use-brian/doc-model' && !process.env.NATIVE_COMPILED) {
    return nextResolve(new URL('../../../../packages/doc-model/src/index.ts', import.meta.url).href, context)
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context)
  if (/\/doc-sync\/(src\/server.ts|dist\/server.js)$/.test(url)) {
    return { ...loaded, source: `${loaded.source}\nglobalThis.__nativeRuntime = { hocuspocus, httpServer, wss, runSweepTimer };` }
  }
  return loaded
}
