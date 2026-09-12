import * as Y from 'yjs'
import { DRAWING_PROTOCOL, FRAGMENT_FIELD, findDrawing, drawingNamespace } from '@use-brian/doc-model'

function drawingBases(doc: Y.Doc): Map<string, { raw: string; epoch: unknown }> {
  const bases = new Map<string, { raw: string; epoch: unknown }>()
  const visit = (parent: Y.XmlFragment) => {
    for (const node of parent.toArray()) if (node instanceof Y.XmlElement) {
      if (node.nodeName === 'embed') {
        const raw = node.getAttribute('block') ?? 'null'
        try {
          const block = JSON.parse(raw)
          if (block?.kind === 'drawing') bases.set(block.id, { raw, epoch: node.getAttribute('drawingEpoch') ?? null })
        } catch { /* malformed base is not a drawing write */ }
      }
      visit(node)
    }
  }
  visit(doc.getXmlFragment(FRAGMENT_FIELD))
  return bases
}

function hasDrawing(doc: Y.Doc): boolean {
  for (const name of doc.share.keys()) if (name.startsWith('drawing:') && doc.getMap(name).size) return true
  const visit = (parent: Y.XmlFragment): boolean => parent.toArray().some(node => {
    if (!(node instanceof Y.XmlElement)) return false
    if (node.nodeName === 'embed') {
      try { if (JSON.parse(node.getAttribute('block') ?? 'null')?.kind === 'drawing') return true } catch { /* not a drawing */ }
    }
    return visit(node)
  })
  return visit(doc.getXmlFragment(FRAGMENT_FIELD))
}

/** Called by beforeSync, before Hocuspocus can integrate a legacy write. */
export function assertDrawingProtocol(params: {
  doc: Y.Doc; protocol?: string; type: number; update: Uint8Array
  connection: { readOnly: boolean; sendStateless: (payload: string) => void; close: (event: { code: number; reason: string }) => void }
}): void {
  if (params.type === 0) return
  const currentProtocol = params.protocol === DRAWING_PROTOCOL
  // Normal shape updates never touch XML's `block` attribute. Only inspect a
  // full candidate for base writes (including cached legacy full-state replay).
  if (currentProtocol && !Y.decodeUpdate(params.update).structs.some(item => item instanceof Y.Item && item.parentSub === 'block')) return
  let reason = !currentProtocol && hasDrawing(params.doc) ? 'drawing-protocol-reload-required' : ''
  if (!reason) {
    const proposed = new Y.Doc()
    try {
      Y.applyUpdate(proposed, Y.encodeStateAsUpdate(params.doc))
      Y.applyUpdate(proposed, params.update)
      if (!currentProtocol && hasDrawing(proposed)) reason = 'drawing-protocol-reload-required'
      if (currentProtocol) {
        const before = drawingBases(params.doc), after = drawingBases(proposed)
        for (const [id, next] of after) {
          const previous = before.get(id)
          if (previous && (previous.raw !== next.raw || previous.epoch !== next.epoch)) reason = 'drawing-legacy-state-recovery-required'
          if (!previous && [...params.doc.share.keys()].some(name => name.startsWith(`drawing:${id}:`) && params.doc.getMap(name).size)) {
            const block = findDrawing(proposed, id)
            if (!block || !params.doc.share.has(drawingNamespace(proposed, block))) reason = 'drawing-legacy-state-recovery-required'
          }
        }
      }
    } finally { proposed.destroy() }
  }
  if (!reason) return
  params.connection.readOnly = true
  params.connection.sendStateless(reason)
  params.connection.close({ code: 4409, reason })
  throw new Error(reason)
}
