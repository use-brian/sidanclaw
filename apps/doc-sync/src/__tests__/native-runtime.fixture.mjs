import assert from 'node:assert/strict'
import { createRequire, register } from 'node:module'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'

register('./native-runtime.loader.mjs', import.meta.url)
Object.assign(process.env, { PORT: '0', JWT_SECRET: 'synthetic-test-secret', DATABASE_URL: 'postgres://unused.invalid/test',
  API_INTERNAL_URL: '', DOC_SYNC_SECRET: '' })

// The launcher invokes this exact entrypoint under tsx. Baseline bypasses ONLY
// the bootstrap resolver, not persistence or Hocuspocus.
await import(process.env.NATIVE_BASELINE ? '../server.ts' : process.env.NATIVE_COMPILED ? '../../dist/index.js' : '../index.ts')
const { hocuspocus, httpServer, wss, runSweepTimer } = globalThis.__nativeRuntime
const { rows, setSeed } = await import('./native-runtime.store.mjs')
const Y = await import('yjs')
const model = await import('@use-brian/doc-model')
const { ALL_KINDS_PAGE } = await import('../../../../packages/doc-model/src/__tests__/fixtures.ts')
const drawing = { kind: 'drawing', id: 'drawing', title: 'Sketch', scene: {
  version: 1, elements: [{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 50, height: 50 }],
  files: {}, appState: { viewBackgroundColor: '#fff' },
} }
const page = { blocks: [...ALL_KINDS_PAGE.blocks, { kind: 'toggle', id: 'nested', expanded: true,
  richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nested drawing' }] }] },
  children: [drawing, { kind: 'text', id: 'nested-text', text: 'Preserve nested text' }] }] }
setSeed(page)
let live, reload, collaboration
try {
  if (!httpServer.listening) await once(httpServer, 'listening')
  if (process.env.NATIVE_BASELINE) {
    // Persisted updates avoid the independent legacy-seed ProseMirror split,
    // reaching the reported store branch through the actual onLoadDocument.
    const seed = new Y.Doc()
    const paragraph = new Y.XmlElement('paragraph')
    paragraph.insert(0, [new Y.XmlText('Preserved text')])
    seed.getXmlFragment('default').insert(0, [paragraph])
    rows.set('synthetic-page', { ydoc: Y.encodeStateAsUpdate(seed) })
    seed.destroy()
    live = await hocuspocus.createDocument('synthetic-page', new Request('http://localhost'), 'test', { service: true })
    assert.equal(live.getXmlFragment('default').get(0).doc, live)
    assert.ok(live.getXmlFragment('default').get(0) instanceof Y.XmlElement)
    const require = createRequire(import.meta.url)
    const modelRequire = createRequire(require.resolve('@use-brian/doc-model'))
    const serializerRequire = createRequire(modelRequire.resolve('y-prosemirror'))
    const serializerYjs = await import(pathToFileURL(process.env.NATIVE_MIX
      ? require.resolve('yjs') : serializerRequire.resolve('yjs').replace('yjs.cjs', 'yjs.mjs')).href)
    assert.equal(live.getXmlFragment('default').get(0) instanceof serializerYjs.XmlElement, false)
    await assert.rejects(hocuspocus.hooks('onStoreDocument', { document: live, documentName: 'synthetic-page' }), /Unexpected case/)
    console.log('native-runtime: original store error reproduced with integrated XML')
  } else {
    live = await hocuspocus.createDocument('synthetic-page', new Request('http://localhost'), 'test', { service: true })
    // onLoadDocument adds IDs to previously unstamped rich-text paragraphs.
    // Compare all authored fields here; subsequent save/reload compares IDs too.
    const authored = value => JSON.parse(JSON.stringify(value, (key, item) =>
      key === 'attrs' && item && Object.keys(item).length === 1 && typeof item.blockId === 'string' ? undefined : item))
    assert.deepEqual(authored(model.yDocToSnapshot(live).page), authored(model.canonicalizePage(page)))
    const fragment = live.getXmlFragment('default')
    const check = parent => {
      for (const node of parent.toArray()) {
        assert.equal(node.doc, live)
        assert.ok(node instanceof Y.XmlElement || node instanceof Y.XmlText)
        if (node instanceof Y.XmlElement) check(node)
      }
    }
    check(fragment)
    collaboration = new model.DrawingCollaboration(live, drawing, () => true)
    assert.ok(collaboration.valid())
    const file = { id: 'asset', mimeType: 'image/png', dataURL: 'data:image/png;base64,YQ==', created: 1 }
    assert.ok(collaboration.write(drawing.scene, { ...drawing.scene, files: { asset: file },
      elements: [{ ...drawing.scene.elements[0], x: 123 },
        { id: 'image', type: 'image', fileId: 'asset', x: 60, y: 0, width: 30, height: 30 }] }))
    assert.ok(collaboration.rename('Live sketch'))
    live.getMap('drawing:retired').set('deleted:old-shape', true)
    const expected = model.yDocToSnapshot(live)
    assert.equal(expected.page.blocks.at(-1).children[0].scene.elements[0].x, 123)
    assert.deepEqual(expected.page.blocks.at(-1).children[0].scene.files.asset, file)
    assert.equal(expected.page.blocks.at(-1).children[0].title, 'Live sketch')
    assert.equal(expected.page.blocks.at(-1).children[1].text, 'Preserve nested text')
    assert.equal(expected.page.blocks.length, ALL_KINDS_PAGE.blocks.length + 1)
    await hocuspocus.hooks('onStoreDocument', { document: live, documentName: 'synthetic-page' })
    const stored = rows.get('synthetic-page')
    assert.deepEqual({ page: stored.page, title: stored.title }, expected)
    assert.deepEqual(model.snapshotFromUpdate(stored.ydoc), expected)
    reload = await hocuspocus.createDocument('synthetic-page', new Request('http://localhost'), 'reload', { service: true })
    assert.deepEqual(model.yDocToSnapshot(reload), expected)
    assert.deepEqual(Buffer.from(Y.encodeStateVector(reload)), stored.stateVector)
    assert.ok([...reload.share.keys()].some(key => key.startsWith('drawing:')))
    assert.equal(reload.getMap('drawing:retired').get('deleted:old-shape'), true)
    // Genuine unsupported XML is not a loader problem and must not disappear.
    fragment.insert(fragment.length, [new Y.XmlHook('unsupported')])
    await assert.rejects(hocuspocus.hooks('onStoreDocument', { document: live, documentName: 'synthetic-page' }), /Unexpected case/)
    assert.equal(rows.get('synthetic-page'), stored)
    assert.equal(fragment.get(fragment.length - 1).hookName, 'unsupported')
    fragment.delete(fragment.length - 1, 1)
    console.log('native-runtime: populated canonical save/reload and invalid projection passed')
  }
} finally {
  collaboration?.dispose()
  live?.destroy()
  reload?.destroy()
  clearInterval(runSweepTimer)
  wss.close()
  await new Promise(resolve => httpServer.close(resolve))
}
