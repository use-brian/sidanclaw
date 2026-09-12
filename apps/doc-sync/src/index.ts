import { readFileSync, realpathSync } from 'node:fs'
import { createRequire, register } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Register BEFORE importing the server: tsx and native Node otherwise bypass
// the browser/Vitest singleton aliases, including in absorbed pnpm workspaces.
const require = createRequire(import.meta.url)
const model = createRequire(require.resolve('@use-brian/doc-model'))
const pmRoot = resolve(dirname(model.resolve('@tiptap/pm/view')), '../..')
const pm = createRequire(resolve(pmRoot, 'package.json'))
const peers = JSON.parse(readFileSync(resolve(pmRoot, 'package.json'), 'utf8')).dependencies
const aliases = Object.fromEntries(
  ['yjs', 'y-prosemirror', ...Object.keys(peers).filter(name => name.startsWith('prosemirror-'))]
    .map(name => {
      const entry = (name.startsWith('prosemirror-') ? pm : model).resolve(name)
      const root = resolve(dirname(entry), '..')
      const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
      return [name, pathToFileURL(realpathSync(resolve(root, manifest.module))).href]
    }),
)
register(`data:text/javascript,${encodeURIComponent(`
  let aliases;
  export function initialize(data) { aliases = data }
  export function resolve(specifier, context, nextResolve) {
    return nextResolve(aliases[specifier] ?? specifier, context)
  }
`)}`, { parentURL: import.meta.url, data: aliases })

await import('./server.js')
