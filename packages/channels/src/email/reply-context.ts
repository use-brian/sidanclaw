import { AsyncLocalStorage } from 'node:async_hooks'

// Runtime provenance, never an input/schema flag. The shared channel adapter
// establishes this only while answering its exact inbound message.
const replyContext = new AsyncLocalStorage<Readonly<{ inboxId: string; messageId: string }>>()

export function withinEmailChannelReply<T>(inboxId: string, messageId: string, reply: () => Promise<T>): Promise<T> {
  return replyContext.run(Object.freeze({ inboxId, messageId }), reply)
}

export function isEmailChannelReply(inboxId: string, messageId: string): boolean {
  const current = replyContext.getStore()
  return current?.inboxId === inboxId && current.messageId === messageId
}
