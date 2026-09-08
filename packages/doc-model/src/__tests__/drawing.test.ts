import { describe, expect, it } from 'vitest'
import { blockSchema, pageSchema, type Block } from '@use-brian/core/dist/views/blocks.js'
import { applyOps } from '@use-brian/core/dist/doc/ops.js'
import { opsSchema } from '@use-brian/core/dist/doc/page-schemas.js'
import { pageToYDocUpdate, snapshotFromUpdate, pageToYDoc, yDocToSnapshot } from '../encode.js'
import { applyOpsToYDoc } from '../apply-ops.js'

const block: Block = { kind: 'drawing', id: 'drawing-1', scene: {
  version: 1, elements: [{ id: 'image-1', type: 'image', x: 1, y: 2, width: 40, height: 30, fileId: 'f', seed: 9 }],
  appState: { viewBackgroundColor: '#fff' },
  files: { f: { id: 'f', mimeType: 'image/png', dataURL: 'data:image/png;base64,YQ==', created: 1 } },
} }

describe('[COMP:doc-model/drawing] canonical persistence', () => {
  it('survives API schema, embed mapping, Yjs binary reload, and snapshot validation without stripping images', () => {
    const page = pageSchema.parse({ blocks: [block] })
    expect(snapshotFromUpdate(pageToYDocUpdate(page, 'Sketch')).page).toEqual(page)
    expect(pageSchema.parse(snapshotFromUpdate(pageToYDocUpdate(page, 'Sketch')).page)).toEqual(page)
  })
  it('supports Brian add/edit/delete through the same Page and live Yjs operations', () => {
    const ops = opsSchema.parse([{ op: 'add', after: 'end', block }])
    const page = applyOps({ blocks: [] }, ops).page
    expect(blockSchema.parse(page.blocks[0])).toEqual(block)
    const doc = pageToYDoc(page, '')
    const scene = { ...block.scene, appState: { viewBackgroundColor: '#123456' } }
    applyOpsToYDoc(doc, [{ op: 'edit', blockId: block.id, patch: { scene } }])
    expect(yDocToSnapshot(doc).page.blocks[0]).toEqual({ ...block, scene })
    const invalid = applyOpsToYDoc(doc, [{ op: 'edit', blockId: block.id, patch: { scene: { ...scene, files: {} } } }])
    expect(invalid.skipped).toHaveLength(1)
    expect(yDocToSnapshot(doc).page.blocks[0]).toEqual({ ...block, scene })
    expect(() => applyOps(page, [{ op: 'edit', blockId: block.id, patch: { scene: { ...scene, files: {} } } }])).toThrow()
    applyOpsToYDoc(doc, [{ op: 'delete', blockId: block.id }])
    expect(yDocToSnapshot(doc).page.blocks).toEqual([])
    doc.destroy()
  })
})
