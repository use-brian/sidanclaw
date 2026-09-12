import * as Y from 'yjs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Document, IncomingMessage, MessageReceiver, OutgoingMessage } from '@hocuspocus/server'

describe('[COMP:doc-sync/awareness-lifetime] installed receiver scratch lifecycle', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  it.each(['accepted', 'rejected', 'decode-error', 'encode-error'] as const)(
    'releases scratch timers and documents for repeated %s packets', async mode => {
      vi.useFakeTimers()
      const receiver = new Document('page'), sender = new Document('sender')
      const before = Y.encodeStateAsUpdate(receiver)
      const baseline = vi.getTimerCount()
      const initialMetadata = receiver.awareness.meta.size
      // Spies call the real implementation: no mocked packet handling or cleanup.
      const awarenessDestroy = vi.spyOn(Object.getPrototypeOf(receiver.awareness), 'destroy')
      const docDestroy = vi.spyOn(Y.Doc.prototype, 'destroy')
      const hooks = vi.fn(async (_doc: Document, states: Map<number, Record<string, unknown>>) => {
        await Promise.resolve()
        if (mode === 'rejected') throw new Error('awareness-denied')
        const state = states.get(sender.clientID)!
        if (mode === 'encode-error') state.unsupported = 1n
        else state.user = { name: 'Validated editor' }
      })
      receiver.beforeHandleAwareness(hooks)
      try {
        for (let packet = 0; packet < 400; packet++) {
          sender.awareness.setLocalState({ user: { name: 'Synthetic editor' },
            cursor: { anchor: 'host' }, drawing: { scope: 'drawing:one:epoch', pointer: { x: packet, y: 1 } } })
          const bytes = new OutgoingMessage('page').createAwarenessUpdateMessage(sender.awareness).toUint8Array()
          // Keep the binary envelope valid but corrupt the JSON inside it.
          if (mode === 'decode-error') bytes[bytes.length - 1] = 123
          const message = new IncomingMessage(bytes)
          message.readVarString()
          const receive = new MessageReceiver(message).apply(receiver)
          if (mode === 'accepted') await receive
          else await expect(receive).rejects.toThrow(mode === 'rejected' ? 'awareness-denied' : undefined)
          expect(vi.getTimerCount(), `timer count after packet ${packet}`).toBe(baseline)
          expect(receiver.awareness.getStates().size).toBe(mode === 'accepted' ? 1 : 0)
          expect(receiver.awareness.meta.size).toBe(initialMetadata + (mode === 'accepted' ? 1 : 0))
          expect(docDestroy).toHaveBeenCalledTimes(packet + 1)
          const scratch = docDestroy.mock.contexts[packet] as Y.Doc
          expect(scratch).not.toBe(receiver)
          expect(scratch).not.toBe(sender)
          expect(scratch.isDestroyed).toBe(true)
          // Awareness destruction can be called again by its Doc destroy listener.
          const destroyed = new Set(awarenessDestroy.mock.contexts as Document['awareness'][])
          expect(destroyed.size).toBe(packet + 1)
          expect([...destroyed].every(awareness => awareness.doc.isDestroyed)).toBe(true)
          await vi.advanceTimersByTimeAsync(50) // Sustained 20 Hz, not just a burst.
        }
        expect(hooks).toHaveBeenCalledTimes(mode === 'decode-error' ? 0 : 400)
        expect(Y.encodeStateAsUpdate(receiver)).toEqual(before)
        expect(receiver.isDestroyed).toBe(false)
        if (mode === 'accepted') expect(receiver.awareness.getStates().get(sender.clientID)).toEqual({
          user: { name: 'Validated editor' }, cursor: { anchor: 'host' },
          drawing: { scope: 'drawing:one:epoch', pointer: { x: 399, y: 1 } },
        })
        else expect(receiver.awareness.getStates().has(sender.clientID)).toBe(false)
      } finally { sender.destroy(); receiver.destroy() }
      expect(vi.getTimerCount()).toBe(0)
    },
  )
})
