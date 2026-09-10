import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'
import type { Server } from 'node:http'
import express from 'express'
import request from 'supertest'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { CrmOperationsCommandSchema, type CrmOperationsContext } from '@use-brian/core'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createDbCrmIntakeReadStore } from '../crm-intake-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { crmIntakeRoutes } from '../../routes/crm-intake.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const store = createDbCrmOperationsStore(pool)
const service = createCrmOperationsService(store)
const servers: Server[] = []
async function fixture() {
  const workspaceId = randomUUID(),userId = randomUUID()
  await pool.query('INSERT INTO users (id,auth_provider_id) VALUES ($1::uuid,$1::text)',[userId])
  await pool.query(`INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'Rotation fixture',$2)`,[workspaceId,userId])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`,[workspaceId,userId])
  const context: CrmOperationsContext = { workspaceId,actor: { kind: 'user',userId },authority: { role: 'owner',canConfigure: true,canWrite: true,trustedIdentitySources: [] } }
  await service.execute(context,CrmOperationsCommandSchema.parse({ kind: 'save_consent_purpose',purposeKey: 'updates',label: 'Updates',wordingVersion: '1',wording: 'Fixture consent' }))
  const ids: string[] = []
  for (const definitionKey of ['first','second']) {
    const saved = await service.execute(context,CrmOperationsCommandSchema.parse({ kind: 'save_intake_definition',definitionKey,label: definitionKey,definition: {
      identityPolicy: 'new_or_review',fields: [
        { key: 'name',label: 'Name',type: 'text',required: true,mapping: { kind: 'base_field',field: 'name' } },
        { key: 'agree',label: 'Agree',type: 'boolean',required: true,mapping: { kind: 'submission_only' } },
      ],consentMappings: [{ fieldKey: 'agree',grantedValue: true,purposeKey: 'updates' }],
      followUpTaskTemplate: { title: 'Review fixture',priority: 'medium' },followUpDueMinutes: 60,
    } }))
    ids.push(String(saved.record.id))
  }
  const app = express(); app.use('/api',crmIntakeRoutes({ service,readStore: createDbCrmIntakeReadStore() }))
  const server = app.listen(0,'127.0.0.1'); servers.push(server); await once(server,'listening')
  const key = (rotateFromCredentialId?: string,definitionIds=ids,credentialId?: string) =>
    (credentialId ? createCrmOperationsService(store,{ randomCredentialId: () => credentialId }) : service).execute(context,CrmOperationsCommandSchema.parse({ kind: 'create_intake_credential',label: 'Fixture backend',definitionIds,rotateFromCredentialId }))
  const submit = (secret: string,definition='first',fields: Record<string,unknown> = { name: 'Fixture person',agree: true }) => request(server)
    .post(`/api/crm/intake/${definition}/submissions`).set('Authorization',`Bearer ${secret}`).set('Idempotency-Key','stable_backend_submission').send({ fields })
  return { workspaceId,context,ids,key,submit }
}
async function counts(workspace: string) {
  return (await pool.query(`SELECT
    (SELECT count(*) FROM entities WHERE workspace_id=$1)::int AS people,
    (SELECT count(*) FROM association_enquiries WHERE workspace_id=$1)::int AS submissions,
    (SELECT count(*) FROM association_consent_events WHERE workspace_id=$1)::int AS consent,
    (SELECT count(*) FROM tasks WHERE workspace_id=$1)::int AS tasks,
    (SELECT count(*) FROM crm_intake_idempotency WHERE workspace_id=$1)::int AS receipts,
    (SELECT count(*) FROM association_audit_log WHERE workspace_id=$1)::int AS audit,
    (SELECT count(*) FROM crm_domain_event_outbox WHERE workspace_id=$1)::int AS outbox`,[workspace])).rows[0]
}

describe('[COMP:crm/operations-store] Actual intake rotation replay', () => {
  afterAll(async () => { await Promise.all(servers.map((server) => new Promise<void>((resolve,reject) => server.close((error) => error ? reject(error) : resolve())))); await pool.end() })
  it('keeps stable results through replacement chains, explicit revocation and identical requests', async () => {
    const f = await fixture()
    // Shared short prefix proves replacement creation no longer has a four-hex collision domain.
    const original = await f.key(undefined,f.ids,'aaaa0000-1111-4111-8111-111111111111')
    const first = await f.submit(original.oneTimeSecret!)
    expect(first.status).toBe(201)
    // An older persisted source id is not rewritten or needed for receipt lookup.
    await pool.query('UPDATE association_enquiries SET source_submission_id=$2 WHERE id=$1',[first.body.submissionId,'legacy_backend_submission'])
    const replacement = await f.key(String(original.record.id),f.ids,'aaaa1111-1111-4111-8111-111111111111')
    const before = await counts(f.workspaceId)
    const replay = await f.submit(replacement.oneTimeSecret!)
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ ...first.body,duplicate: true })
    expect(await counts(f.workspaceId)).toEqual(before)
    expect((await f.submit(original.oneTimeSecret!)).status).toBe(200)
    expect((await f.submit(replacement.oneTimeSecret!,'first',{ name: 'Changed fixture',agree: true })).status).toBe(409)
    await service.execute(f.context,{ kind: 'revoke_intake_credential',credentialId: String(original.record.id) })
    expect((await f.submit(original.oneTimeSecret!)).status).toBe(401)
    const third = await f.key(String(replacement.record.id))
    expect((await f.submit(third.oneTimeSecret!)).body).toMatchObject({ ...first.body,duplicate: true })
    const receipt = (await pool.query('SELECT actor_scope,credential_id FROM crm_intake_idempotency WHERE workspace_id=$1',[f.workspaceId])).rows
    expect(receipt).toEqual([{ actor_scope: `intake_key:${original.record.id}`,credential_id: original.record.id }])
    expect(await counts(f.workspaceId)).toMatchObject({ people: 1,submissions: 1,consent: 1,tasks: 1,receipts: 1 })
  })

  it('keeps unrelated keys separate and checks the replacement grant before replay', async () => {
    const f = await fixture(), original = await f.key()
    const first = await f.submit(original.oneTimeSecret!)
    const narrowed = await f.key(String(original.record.id),[f.ids[1]!])
    expect((await f.submit(narrowed.oneTimeSecret!)).status).toBe(401)
    const unrelated = await f.key()
    const separate = await f.submit(unrelated.oneTimeSecret!)
    expect(separate.status).toBe(201)
    expect(separate.body.contactId).not.toBe(first.body.contactId)
    const other = await fixture()
    await expect(other.key(String(original.record.id))).rejects.toMatchObject({ code: 'not_found' })
    await expect(pool.query('UPDATE crm_intake_credentials SET replay_scope_id=$2 WHERE id=$1',[unrelated.record.id,original.record.id])).rejects.toMatchObject({ constraint: 'crm_intake_replay_scope_immutable' })
    expect((await pool.query('SELECT count(*)::int AS count FROM crm_intake_credentials WHERE workspace_id=$1',[other.workspaceId])).rows[0].count).toBe(0)
  })

  it('allows recovery from a revoked parent without restoring its authority or widening definition bindings', async () => {
    const f = await fixture(), original = await f.key()
    const first = await f.submit(original.oneTimeSecret!)
    await service.execute(f.context,{ kind: 'revoke_intake_credential',credentialId: String(original.record.id) })
    const recovered = await f.key(String(original.record.id),[f.ids[0]!])
    expect((await f.submit(recovered.oneTimeSecret!)).body).toMatchObject({ ...first.body,duplicate: true })
    expect((await f.submit(recovered.oneTimeSecret!,'second')).status).toBe(401)
    expect((await f.submit(original.oneTimeSecret!)).status).toBe(401)
  })
  it('returns accepted bytes after a definition revision while validating new writes against the latest schema', async () => {
    const f = await fixture(),original = await f.key()
    const first = await f.submit(original.oneTimeSecret!)
    await service.execute(f.context,CrmOperationsCommandSchema.parse({ kind: 'save_intake_definition',definitionId: f.ids[0],definitionKey: 'first',label: 'Revised fixture',expectedVersion: 1,definition: {
      identityPolicy: 'new_or_review',fields: [
        { key: 'name',label: 'Name',type: 'text',required: true,mapping: { kind: 'base_field',field: 'name' } },
        { key: 'agree',label: 'Agree',type: 'boolean',required: true,mapping: { kind: 'submission_only' } },
        { key: 'new_required',label: 'Required',type: 'text',required: true,mapping: { kind: 'submission_only' } },
      ],
    } }))
    const replacement = await f.key(String(original.record.id))
    const before = await counts(f.workspaceId)
    expect((await f.submit(replacement.oneTimeSecret!)).body).toMatchObject({ ...first.body,duplicate: true })
    const unrelated = await f.key()
    expect((await f.submit(unrelated.oneTimeSecret!)).status).toBe(400)
    expect(await counts(f.workspaceId)).toMatchObject({ ...before,audit: before.audit+1 })
  })

  it('serializes revocation with an admitted submission and refuses the next replay', async () => {
    const f = await fixture(), credential = await f.key()
    await f.submit(credential.oneTimeSecret!)
    let entered!: () => void,release!: () => void
    const ready = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const admission = store.transaction(f.context,async (tx) => {
      expect(await tx.intakeCredentialReplayScope(String(credential.record.id),f.ids[0]!)).toBe(credential.record.id)
      entered(); await gate
    })
    let revocation: ReturnType<typeof service.execute> | undefined
    try {
      await Promise.race([ready,admission.then(() => { throw new Error('Admission finished before release.') })])
      revocation = service.execute(f.context,{ kind: 'revoke_intake_credential',credentialId: String(credential.record.id) })
      const deadline = Date.now()+5000; let waiting = false
      while (Date.now()<deadline) {
        const result = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
          AND position('UPDATE crm_intake_credentials SET revoked_at' IN query)>0`)
        if (result.rowCount) { waiting = true; break }
        await setTimeout(10)
      }
      expect(waiting).toBe(true)
    } finally { release(); await Promise.allSettled([admission,...(revocation ? [revocation] : [])]) }
    await revocation
    expect((await f.submit(credential.oneTimeSecret!)).status).toBe(401)
  })

  it('backfills existing scope ids and derives replacement scopes in a populated upgrade', async () => {
    const client = await pool.connect(),schema = `rotation_${randomUUID().replaceAll('-','')}`
    try {
      await client.query(`CREATE SCHEMA ${schema}`); await client.query(`SET search_path TO ${schema}`)
      await client.query(`CREATE TABLE crm_intake_credentials(workspace_id uuid NOT NULL,id uuid PRIMARY KEY,UNIQUE(workspace_id,id))`)
      const workspace = randomUUID(),original = randomUUID(),replacement = randomUUID()
      await client.query('INSERT INTO crm_intake_credentials VALUES($1,$2)',[workspace,original])
      await client.query(await readFile(new URL('../../../migrations/503_crm_intake_rotation_replay.sql',import.meta.url),'utf8'))
      expect((await client.query('SELECT replay_scope_id FROM crm_intake_credentials')).rows).toEqual([{ replay_scope_id: original }])
      await client.query('INSERT INTO crm_intake_credentials(workspace_id,id,rotated_from_credential_id,replay_scope_id) VALUES($1,$2,$3,$4)',[workspace,replacement,original,randomUUID()])
      expect((await client.query('SELECT replay_scope_id FROM crm_intake_credentials WHERE id=$1',[replacement])).rows).toEqual([{ replay_scope_id: original }])
      await client.query('DELETE FROM crm_intake_credentials WHERE id=$1',[original])
      expect((await client.query('SELECT replay_scope_id,rotated_from_credential_id FROM crm_intake_credentials')).rows).toEqual([{ replay_scope_id: original,rotated_from_credential_id: null }])
    } finally { await client.query('ROLLBACK'); await client.query('RESET search_path'); await client.query(`DROP SCHEMA ${schema} CASCADE`); client.release() }
  })

})
