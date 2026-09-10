/** Private in-process receipt hooks. Never represented in tool/REST input. */
import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { CrmMailContext } from './delivery-policy.js'
export type CrmMailAdmission = {
  workspaceId: string; connectorInstanceId: string; provider: 'gmail'|'imap'|'agentmail';
  providerKey: string|null; contactIds: string[]; accountHash: string;
}
type Hooks = {
  beforeInvoke(client: PoolClient, admission: CrmMailAdmission): Promise<void>
  afterInvoke(client: PoolClient, admission: CrmMailAdmission, result: unknown): Promise<void>
}
const hooksByScope = new WeakMap<CrmMailContext, Hooks>()
export function bindCrmDeliveryHooks(scope: CrmMailContext, hooks: Hooks): CrmMailContext {
  hooksByScope.set(scope, hooks)
  return scope
}
export function crmDeliveryHooks(scope: CrmMailContext | undefined): Hooks | undefined {
  return scope ? hooksByScope.get(scope) : undefined
}

/** Bind both decrypted transport credentials and the provider account address. */
export function crmMailboxAccountHash(row: {provider:string; connectedEmail:string|null; credentials:Buffer|null}): string {
  return createHash('sha256').update(JSON.stringify([row.provider,row.connectedEmail,row.credentials?.toString('base64') ?? null])).digest('hex')
}
