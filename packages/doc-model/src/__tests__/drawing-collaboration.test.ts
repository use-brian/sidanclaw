import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { DrawingCollaboration, findDrawing, drawingRetention, DRAWING_RETENTION_LIMITS } from '../drawing.js'
import { pageToYDocUpdate, snapshotFromUpdate, yDocToSnapshot } from '../encode.js'
import { applyOpsToYDoc } from '../apply-ops.js'

const base = { kind: 'drawing' as const, id: 'drawing', title: 'Sketch', scene: {
  version: 1 as const, elements: ['a', 'b'].map(id => ({ id, type: 'rectangle' as const, x: 0, y: 0, width: 50, height: 50 })),
  files: {}, appState: { viewBackgroundColor: '#fff' },
} }
function peers(empty = false) {
  const block = empty ? { ...base, scene: { ...base.scene, elements: [] } } : base
  const seed = pageToYDocUpdate({ blocks: [block, { kind: 'text', id: 'text', text: 'Before' }] }, 'Page')
  const a = new Y.Doc(), b = new Y.Doc()
  Y.applyUpdate(a, seed); Y.applyUpdate(b, seed)
  const left = new DrawingCollaboration(a, block, () => true)
  const right = new DrawingCollaboration(b, block, () => true)
  const sync = () => { const au = Y.encodeStateAsUpdate(a), bu = Y.encodeStateAsUpdate(b); Y.applyUpdate(a, bu); Y.applyUpdate(b, au) }
  return { a, b, left, right, sync, block }
}
describe('[COMP:doc-model/drawing] live element CRDT', () => {
  it('undoing an image insertion retains immutable files referenced by a peer duplicate', () => {
    const { a, left, right, sync } = peers(true)
    const empty = left.read().scene
    const file = { id: 'asset', mimeType: 'image/png' as const, dataURL: 'data:image/png;base64,YQ==', created: 1 }
    const image = { id: 'original', type: 'image' as const, fileId: file.id, x: 0, y: 0, width: 30, height: 30 }
    left.write(empty, { ...empty, elements: [image], files: { asset: file } })
    sync()
    const seen = right.read().scene
    right.write(seen, { ...seen, elements: [...seen.elements, { ...image, id: 'duplicate', x: 40 }] })
    sync()
    left.undo.undo(); sync()
    expect(right.read().scene.elements.map(element => element.id)).toEqual(['duplicate'])
    expect(right.read().scene.files.asset).toEqual(file)
    expect(left.read()).toEqual(right.read())
    expect(snapshotFromUpdate(Y.encodeStateAsUpdate(a))).toEqual(yDocToSnapshot(a))
    left.undo.redo(); sync()
    expect(right.read().scene.elements).toHaveLength(2)
    expect(right.read().scene.files.asset).toEqual(file)
  })
  it('bounds retained assets even after every visible image is deleted, without collecting offline/undo references', () => {
    const { a, left } = peers(true)
    const dataURL = `data:image/png;base64,${'A'.repeat(1024 * 1024)}`
    for (let i = 0; i < 15; i++) {
      const old = left.read().scene
      const id = `asset-${i}`
      left.write(old, { ...old, elements: [{ id, type: 'image', fileId: id, x: 0, y: 0, width: 30, height: 30 }],
        files: { [id]: { id, mimeType: 'image/png', dataURL, created: 1 } } })
      left.write(left.read().scene, { ...old, elements: [], files: {} })
    }
    expect(left.read().scene.elements).toHaveLength(0)
    expect(drawingRetention(a).bytes).toBeGreaterThan(15 * 1024 * 1024)
    expect(drawingRetention(a).bytes).toBeLessThan(DRAWING_RETENTION_LIMITS.bytes)
    const before = drawingRetention(a)
    const old = left.read().scene
    expect(() => left.write(old, { ...old, elements: [{ id: 'more', type: 'image', fileId: 'more', x: 0, y: 0, width: 30, height: 30 }],
      files: { more: { id: 'more', mimeType: 'image/png', dataURL, created: 1 } } })).toThrow('drawing-retention-limit')
    expect(drawingRetention(a)).toEqual(before)
    expect(left.registers.get('file:asset-0')).toBeDefined()
    expect(snapshotFromUpdate(Y.encodeStateAsUpdate(a))).toEqual(yDocToSnapshot(a))
  }, 30_000)
  it('includes retired namespaces and register counts in retention admission', () => {
    const { a, left } = peers(true)
    a.transact(() => {
      for (let i = 0; i < DRAWING_RETENTION_LIMITS.namespaces; i++) a.getMap(`drawing:retired-${i}`).set('deleted:old', true)
    })
    const old = left.read().scene
    expect(() => left.write(old, { ...old, elements: [base.scene.elements[0]] })).toThrow('drawing-retention-limit')
    expect(left.registers.size).toBe(0)
    const other = peers(true)
    other.a.transact(() => {
      const retired = other.a.getMap('drawing:retired')
      for (let i = 0; i < DRAWING_RETENTION_LIMITS.registers; i++) retired.set(`deleted:${i}`, true)
    })
    expect(() => other.left.write(old, { ...old, elements: [base.scene.elements[0]] })).toThrow('drawing-retention-limit')
  }, 20_000)
  it.each([null, { id: 'wrong', type: 'rectangle' }, { id: 'a', type: 'rectangle', x: 'invalid' }])('isolates malformed registers from neighboring page blocks and persists a diagnostic: %j', value => {
    const { a, left } = peers()
    left.registers.set('element:a', value)
    const snapshot = yDocToSnapshot(a)
    expect(snapshot.page.blocks[0]).toMatchObject({ kind: 'drawing', collaborationError: 'invalid-registers' })
    expect(snapshot.page.blocks[0]).not.toHaveProperty('preview')
    expect(snapshot.page.blocks[1]).toMatchObject({ text: 'Before' })
    expect(snapshotFromUpdate(Y.encodeStateAsUpdate(a))).toEqual(snapshot)
    expect(() => left.read()).toThrow('drawing-invalid-registers')
    applyOpsToYDoc(a, [{ op: 'edit', blockId: base.id, patch: { scene: base.scene } }])
    expect(yDocToSnapshot(a).page.blocks[0]).not.toHaveProperty('collaborationError')
  })
  it.each([false, true])('concurrent first edits seed no competing map (empty=%s), converge and serialize canonically', empty => {
    const { a, b, left, right, sync, block } = peers(empty)
    expect(left.registers.size).toBe(0)
    const old = block.scene
    left.write(old, { ...old, elements: empty ? [base.scene.elements[0]] : old.elements.map(e => e.id === 'a' ? { ...e, x: 20 } : e) })
    right.write(old, { ...old, elements: empty ? [base.scene.elements[1]] : old.elements.map(e => e.id === 'b' ? { ...e, x: 30 } : e) })
    sync()
    expect(left.read()).toEqual(right.read())
    expect(left.read().scene.elements.map(e => e.x)).toEqual(empty ? [0, 0] : [20, 30])
    expect(yDocToSnapshot(a)).toEqual(yDocToSnapshot(b))
    expect(snapshotFromUpdate(Y.encodeStateAsUpdate(a))).toEqual(yDocToSnapshot(a))
    expect(snapshotFromUpdate(pageToYDocUpdate(yDocToSnapshot(a).page, 'Page'))).toEqual(yDocToSnapshot(a))
    const reopened = new DrawingCollaboration(a, findDrawing(a, base.id)!, () => true)
    expect(reopened.read()).toEqual(left.read())
    const state = Y.encodeStateAsUpdate(a)
    reopened.write(reopened.read().scene, reopened.read().scene)
    expect(Y.encodeStateAsUpdate(a)).toEqual(state)
  })
  it('same-element edits converge regardless of update order; deletion wins concurrent edits and reopening', () => {
    const { a, left, right, sync } = peers()
    left.write(base.scene, { ...base.scene, elements: base.scene.elements.map(e => ({ ...e, x: 10 })) })
    right.write(base.scene, { ...base.scene, elements: base.scene.elements.map(e => ({ ...e, x: 90 })) })
    sync()
    expect(left.read()).toEqual(right.read())
    const previous = left.read().scene
    left.write(previous, { ...previous, elements: previous.elements.filter(e => e.id !== 'a') })
    right.write(previous, { ...previous, elements: previous.elements.map(e => e.id === 'a' ? { ...e, y: 200 } : e) })
    sync()
    expect(left.read()).toEqual(right.read())
    expect(left.read().scene.elements.find(e => e.id === 'a')).toBeUndefined()
    expect(left.registers.get('deleted:a')).toBe(true)
    const reopened = new DrawingCollaboration(a, base, () => true)
    reopened.write(base.scene, base.scene)
    expect(reopened.read().scene.elements.find(e => e.id === 'a')).toBeUndefined()
  })
  it('local undo preserves remote shapes and unrelated page edits; AI rename preserves live scene', () => {
    const { a, left, right, sync } = peers()
    left.write(base.scene, { ...base.scene, elements: base.scene.elements.map(e => e.id === 'a' ? { ...e, x: 20 } : e) })
    right.write(base.scene, { ...base.scene, elements: base.scene.elements.map(e => e.id === 'b' ? { ...e, x: 30 } : e) })
    sync()
    applyOpsToYDoc(a, [{ op: 'edit', blockId: 'text', patch: { text: 'After' } }, { op: 'edit', blockId: base.id, patch: { title: 'Renamed' } }])
    const text = (a.getXmlFragment('default').get(1) as Y.XmlElement).get(0) as Y.XmlText
    a.transact(() => text.insert(text.length, ' typed'), 'page-edit')
    left.undo.undo(); sync()
    expect(left.read().scene.elements.map(e => e.x)).toEqual([0, 30])
    expect(left.read().title).toBe('Renamed')
    expect(yDocToSnapshot(a).page.blocks[1]).toMatchObject({ text: 'After typed' })
    left.undo.redo(); sync()
    expect(right.read().scene.elements.map(e => e.x)).toEqual([20, 30])
  })
  it('files and background converge, deleted images retain undo files but not canonical assets', () => {
    const { left, right, sync } = peers()
    const image = { id: 'image', type: 'image' as const, fileId: 'file', x: 0, y: 0, width: 50, height: 50 }
    const file = { id: 'file', mimeType: 'image/png' as const, dataURL: 'data:image/png;base64,YQ==', created: 1 }
    left.write(base.scene, { ...base.scene, elements: [...base.scene.elements, image], files: { file } })
    right.write(base.scene, { ...base.scene, appState: { viewBackgroundColor: '#000' } })
    sync()
    expect(left.read()).toEqual(right.read())
    expect(left.read().scene.files).toEqual({ file })
    left.undo.stopCapturing()
    const old = left.read().scene
    left.write(old, { ...old, elements: old.elements.filter(e => e.id !== image.id), files: {} })
    sync()
    expect(right.read().scene.files).toEqual({})
    left.undo.undo(); sync()
    expect(right.read().scene.files).toEqual({ file })
    expect(right.read().scene.appState.viewBackgroundColor).toBe('#000')
  })
  it('refuses writes after replacement, deletion, permission loss and disposal', () => {
    const { a, left } = peers()
    const replacement = { ...base.scene, elements: [] }
    applyOpsToYDoc(a, [{ op: 'edit', blockId: base.id, patch: { scene: replacement } }])
    expect(left.write(base.scene, base.scene)).toBe(false)
    expect(yDocToSnapshot(a).page.blocks[0]).toMatchObject({ scene: replacement })
    let allowed = true
    const current = new DrawingCollaboration(a, findDrawing(a, base.id)!, () => allowed)
    allowed = false
    expect(current.rename('No')).toBe(false)
    allowed = true
    applyOpsToYDoc(a, [{ op: 'delete', blockId: base.id }])
    expect(current.write(replacement, replacement)).toBe(false)
    current.dispose()
    expect(current.valid()).toBe(false)
  })
  it('persists oversized offline unions canonically and permits removing elements to repair them', () => {
    const { a, left, right, sync, block } = peers(true)
    const make = (prefix: string) => ({ ...block.scene, elements: Array.from({ length: 2501 }, (_, i) => ({ ...base.scene.elements[0], id: `${prefix}-${i}` })) })
    left.write(block.scene, make('left'))
    right.write(block.scene, make('right'))
    sync()
    expect(left.read().scene.elements).toHaveLength(5002)
    expect(snapshotFromUpdate(Y.encodeStateAsUpdate(a))).toEqual(yDocToSnapshot(a))
    const old = left.read().scene
    expect(() => left.write(old, { ...old, appState: { viewBackgroundColor: '#000' } })).toThrow()
    left.write(old, { ...old, elements: old.elements.slice(2) })
    sync()
    expect(right.read().scene.elements).toHaveLength(5000)
    expect(snapshotFromUpdate(Y.encodeStateAsUpdate(a))).toEqual(yDocToSnapshot(a))
  }, 20_000)
  it('identical explicit scene replacement retires the old epoch', () => {
    const { a, left } = peers()
    left.write(base.scene, { ...base.scene, elements: [] })
    applyOpsToYDoc(a, [{ op: 'edit', blockId: base.id, patch: { scene: base.scene } }])
    expect(left.valid()).toBe(false)
    expect(yDocToSnapshot(a).page.blocks[0]).toMatchObject({ scene: base.scene })
  })
  it('projects nested drawings and rejects a stale preview without making it a scene authority', () => {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, pageToYDocUpdate({ blocks: [{ kind: 'toggle', id: 'container', expanded: true,
      richText: { type: 'doc', content: [{ type: 'paragraph' }] }, children: [base] }] }, 'Page'))
    const live = new DrawingCollaboration(doc, base, () => true)
    const preview = { mimeType: 'image/png' as const, width: 1, height: 1, sceneDigest: 'a'.repeat(64),
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==' }
    expect(live.preview(base.scene, preview)).toBe(true)
    live.rename('Nested sketch')
    expect(live.read().preview).toEqual(preview)
    live.write(base.scene, { ...base.scene, elements: base.scene.elements.map(e => ({ ...e, x: 20 })) })
    expect(live.preview(base.scene, preview)).toBe(false)
    expect(live.read().preview).toBeUndefined()
    expect(yDocToSnapshot(doc).page.blocks[0]).toMatchObject({ children: [{ title: 'Nested sketch', scene: { elements: [{ x: 20 }, { x: 20 }] } }] })
    expect(snapshotFromUpdate(Y.encodeStateAsUpdate(doc))).toEqual(yDocToSnapshot(doc))
  })
})
