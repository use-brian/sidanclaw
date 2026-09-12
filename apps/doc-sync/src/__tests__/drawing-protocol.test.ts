import * as Y from 'yjs'
import { describe, expect, it, vi } from 'vitest'
import { DRAWING_PROTOCOL, DrawingCollaboration, pageToYDocUpdate, yDocToSnapshot, applyOpsToYDoc, findDrawing } from '@use-brian/doc-model'
import { assertDrawingProtocol } from '../drawing-protocol.js'
import { Document, IncomingMessage, MessageReceiver, OutgoingMessage, type Connection } from '@hocuspocus/server'

describe('[COMP:doc-sync/drawing-protocol] legacy writer gate', () => {
  const base = { kind: 'drawing' as const, id: 'drawing', scene: { version: 1 as const, elements: [], files: {}, appState: { viewBackgroundColor: '#fff' } } }
  const connection = () => ({ readOnly: false, sendStateless: vi.fn(), close: vi.fn() })
  it('enforces rejection before integration in the installed Hocuspocus MessageReceiver', async () => {
    const doc = new Document('page'), peer = new Y.Doc()
    const seed = pageToYDocUpdate({ blocks: [base] }, 'Page')
    Y.applyUpdate(doc, seed); Y.applyUpdate(peer, seed)
    const drawing = new DrawingCollaboration(peer, base, () => true)
    drawing.write(base.scene, { ...base.scene, elements: [{ id: 'shape', type: 'rectangle', x: 20, y: 0, width: 30, height: 30 }] })
    let protocol: string | undefined
    const socket = { ...connection(), messageAddress: 'page', send: vi.fn(), callbacks: {
      beforeSync: (_connection: unknown, data: { type: number; payload: Uint8Array }) => {
        assertDrawingProtocol({ doc, protocol, type: data.type, update: data.payload, connection: socket })
      },
    } }
    const receive = () => {
      const message = new IncomingMessage(new OutgoingMessage('page').createSyncMessage().writeUpdate(Y.encodeStateAsUpdate(peer)).toUint8Array())
      message.readVarString(); message.readVarUint()
      return new MessageReceiver(message).readSyncMessage(message, doc, socket as unknown as Connection)
    }
    try {
      await expect(receive()).rejects.toThrow('drawing-protocol-reload-required')
      expect(yDocToSnapshot(doc).page.blocks[0]).toMatchObject({ scene: { elements: [] } })
      protocol = DRAWING_PROTOCOL; socket.readOnly = false
      await receive()
      expect(yDocToSnapshot(doc).page.blocks[0]).toMatchObject({ scene: { elements: [{ id: 'shape', x: 20 }] } })
    } finally { drawing.dispose(); peer.destroy(); doc.destroy() }
  })
  it('rejects an old whole-scene Save before it can overwrite live registers', () => {
    const doc = new Y.Doc(), old = new Y.Doc()
    const seed = pageToYDocUpdate({ blocks: [base] }, 'Page')
    Y.applyUpdate(doc, seed); Y.applyUpdate(old, seed)
    const live = new DrawingCollaboration(doc, base, () => true)
    live.write(base.scene, { ...base.scene, elements: [{ id: 'shared', type: 'rectangle', x: 10, y: 0, width: 30, height: 30 }] })
    // The shipped Save path changes the opaque attr, without a new epoch.
    ;(old.getXmlFragment('default').get(0) as Y.XmlElement).setAttribute('block', JSON.stringify({ ...base,
      scene: { ...base.scene, appState: { viewBackgroundColor: '#000' } } }))
    const before = yDocToSnapshot(doc)
    const socket = connection()
    expect(() => assertDrawingProtocol({ doc, type: 2, update: Y.encodeStateAsUpdate(old), connection: socket })).toThrow('drawing-protocol-reload-required')
    expect(socket.readOnly).toBe(true)
    expect(socket.sendStateless).toHaveBeenCalledWith('drawing-protocol-reload-required')
    expect(socket.close).toHaveBeenCalledWith(expect.objectContaining({ code: 4409 }))
    expect(yDocToSnapshot(doc)).toEqual(before)
    expect(() => assertDrawingProtocol({ doc, protocol: DRAWING_PROTOCOL, type: 2, update: Y.encodeStateAsUpdate(doc), connection: connection() })).not.toThrow()
    // Reload upgrades the provider, not the old IndexedDB update it replays.
    expect(() => assertDrawingProtocol({ doc, protocol: DRAWING_PROTOCOL, type: 2, update: Y.encodeStateAsUpdate(old), connection: connection() })).toThrow('drawing-legacy-state-recovery-required')
    expect(yDocToSnapshot(doc)).toEqual(before)
    live.dispose()
  })
  it('permits modern drawing moves, independent copies and registered block undo, but not changed retired bases', () => {
    const doc = new Y.Doc(), peer = new Y.Doc()
    Y.applyUpdate(doc, pageToYDocUpdate({ blocks: [base, { kind: 'text', id: 'text', text: 'Text' }] }, 'Page'))
    const live = new DrawingCollaboration(doc, base, () => true)
    live.rename('Shared')
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc))
    applyOpsToYDoc(peer, [{ op: 'move', blockId: base.id, after: 'text' }, { op: 'add', after: 'end', block: { ...base, id: 'copy' } }])
    expect(() => assertDrawingProtocol({ doc, protocol: DRAWING_PROTOCOL, type: 2, update: Y.encodeStateAsUpdate(peer), connection: connection() })).not.toThrow()
    const restored = peer.getXmlFragment('default').toArray().find(node => node instanceof Y.XmlElement && node.getAttribute('blockId') === base.id) as Y.XmlElement
    const clone = restored.clone()
    applyOpsToYDoc(doc, [{ op: 'delete', blockId: base.id }])
    const undoPeer = new Y.Doc()
    Y.applyUpdate(undoPeer, Y.encodeStateAsUpdate(doc))
    undoPeer.getXmlFragment('default').insert(0, [clone])
    expect(() => assertDrawingProtocol({ doc, protocol: DRAWING_PROTOCOL, type: 2, update: Y.encodeStateAsUpdate(undoPeer), connection: connection() })).not.toThrow()
    applyOpsToYDoc(undoPeer, [{ op: 'edit', blockId: base.id, patch: { scene: { ...base.scene, appState: { viewBackgroundColor: '#000' } } } }])
    expect(() => assertDrawingProtocol({ doc, protocol: DRAWING_PROTOCOL, type: 2, update: Y.encodeStateAsUpdate(undoPeer), connection: connection() })).toThrow('drawing-legacy-state-recovery-required')
    live.dispose(); doc.destroy(); peer.destroy(); undoPeer.destroy()
  })
  it('keeps unaffected legacy pages writable but gates first drawing insertion and already connected legacy writers', () => {
    const doc = new Y.Doc(), old = new Y.Doc()
    const seed = pageToYDocUpdate({ blocks: [{ kind: 'text', id: 'text', text: 'Before' }] }, 'Page')
    Y.applyUpdate(doc, seed); Y.applyUpdate(old, seed)
    applyOpsToYDoc(old, [{ op: 'edit', blockId: 'text', patch: { text: 'After' } }])
    expect(() => assertDrawingProtocol({ doc, type: 1, update: Y.encodeStateAsUpdate(old), connection: connection() })).not.toThrow()
    applyOpsToYDoc(old, [{ op: 'add', after: 'end', block: base }])
    expect(() => assertDrawingProtocol({ doc, type: 1, update: Y.encodeStateAsUpdate(old), connection: connection() })).toThrow('drawing-protocol-reload-required')
    applyOpsToYDoc(doc, [{ op: 'add', after: 'end', block: base }])
    const drawing = new DrawingCollaboration(doc, findDrawing(doc, base.id)!, () => true)
    drawing.rename('Live')
    expect(() => assertDrawingProtocol({ doc, type: 0, update: new Uint8Array(), connection: connection() })).not.toThrow()
    applyOpsToYDoc(doc, [{ op: 'delete', blockId: base.id }])
    expect(() => assertDrawingProtocol({ doc, type: 2, update: Y.encodeStateAsUpdate(old), connection: connection() })).toThrow('drawing-protocol-reload-required')
    drawing.dispose()
  })
})
