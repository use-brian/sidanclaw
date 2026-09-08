import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AssociationServicePort, CrmIntegrationGrant, CrmOperationsServicePort } from '@use-brian/core'
import { getAppPool, getPool } from '../client.js'
import { createWorkspaceStore } from '../workspace-store.js'
import { createCrmIntegrationStore } from '../crm-integration-store.js'
import { createDbCrmIntakeReadStore } from '../crm-intake-store.js'
import { createCrmIntegrationRecordReadStore } from '../crm-integration-records.js'
import { crmIntegrationRoutes } from '../../routes/crm-integration.js'
import { crmOperationsRoutes } from '../../routes/crm-operations.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), appPool = getAppPool()
const keys = createCrmIntegrationStore(pool, appPool)

async function fixture(grants: CrmIntegrationGrant[] = [{ operation: 'crm.records.read', selectors: {} }]) {
  const workspaceId = randomUUID(), userId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query(`INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Catalog fixture',$2)`, [workspaceId, userId])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [workspaceId, userId])
  const credential = await keys.create(workspaceId, userId, { label: 'Catalog fixture', expiresAt: '2099-01-01T00:00:00Z', grants })
  const execute = vi.fn(async () => { throw new Error('Catalog discovery must not execute a command') })
  const service: CrmOperationsServicePort = { execute }
  const association: AssociationServicePort = { execute }
  const app = express()
  app.use(express.json())
  app.use('/api/crm/integration', crmIntegrationRoutes({ credentials: keys, service, association }))
  // Simulate only the upstream member JWT identity. Membership is read from
  // the actual app-role database by the production workspace store.
  app.use((req, _res, next) => { req.userId = userId; next() })
  app.use('/api/crm', crmOperationsRoutes({ workspaceStore: createWorkspaceStore(), service, readStore: createDbCrmIntakeReadStore() }))
  const get = (path: string, machine = true) => request(app).get(machine
    ? `/api/crm/integration${path}` : `/api/crm/${workspaceId}${path}`)
    .set('Authorization', `Bearer ${credential.oneTimeSecret}`)
  return { app, workspaceId, userId, credential, execute, get }
}

async function snapshot(workspaceId: string) {
  const tables = ['crm_pipelines', 'crm_pipeline_stages', 'crm_field_definitions', 'association_audit_log', 'workspace_audit_log']
  return Promise.all(tables.map(async (table) => (await pool.query(
    `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') AS rows FROM ${table} t WHERE workspace_id=$1`, [workspaceId],
  )).rows[0].rows))
}

async function collect(f: Awaited<ReturnType<typeof fixture>>, path: string, key: string, machine: boolean) {
  const rows: Array<Record<string, unknown>> = [], cursors = new Set<string>()
  let cursor: string | null = null
  do {
    const response = await f.get(`/operations/${path}`, machine).query({ limit: 17, ...(cursor ? { cursor } : {}) })
    expect(response.status).toBe(200)
    expect(Array.isArray(response.body[key])).toBe(true)
    rows.push(...response.body[key])
    cursor = response.body.nextCursor
    expect(cursor === null || typeof cursor === 'string').toBe(true)
    if (cursor) { expect(cursors.has(cursor)).toBe(false); cursors.add(cursor) }
    expect(cursors.size).toBeLessThan(20)
  } while (cursor)
  expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length)
  return rows
}

describe('[COMP:api/crm-config-catalog] Pure member and integration configuration discovery', () => {
  afterAll(async () => { await Promise.all([...new Set([pool, appPool])].map((item) => item.end())) })

  it('leaves an empty workspace without a default pipeline, fields or new audit while exposing the actual credential destination', async () => {
    const f = await fixture(), before = await snapshot(f.workspaceId)
    const discovery = await f.get('/catalog')
    expect(discovery.status).toBe(200)
    expect(discovery.headers['cache-control']).toBe('no-store')
    expect(discovery.body).toMatchObject({ workspaceId: f.workspaceId, credentialId: f.credential.id })
    expect(JSON.stringify(discovery.body)).not.toMatch(/oneTimeSecret|secretHash|sk_crm_/)
    for (const machine of [false, true]) {
      for (const [path, key] of [['record-fields', 'fields'], ['pipelines', 'pipelines']]) {
        const response = await f.get(`/operations/${path}`, machine)
        expect(response.status).toBe(200)
        expect(response.body).toEqual({ [key]: [], nextCursor: null })
      }
    }
    expect(await snapshot(f.workspaceId)).toEqual(before)
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('returns all pages with the same workspace, archive and entity-kind selection for both authentication modes', async () => {
    const f = await fixture(), foreign = await fixture()
    for (const workspaceId of [f.workspaceId, foreign.workspaceId]) {
      await pool.query(`INSERT INTO crm_field_definitions(workspace_id,entity_kind,field_key,label,field_type,position,archived_at)
        SELECT $1,CASE n%3 WHEN 0 THEN 'person' WHEN 1 THEN 'company' ELSE 'deal' END,
          'fixture_'||n,'Fixture '||n,'text',n,CASE WHEN n<=6 THEN now() END FROM generate_series(1,126) n`, [workspaceId])
      await pool.query(`INSERT INTO crm_pipelines(workspace_id,name,position,archived_at)
        SELECT $1,'Fixture '||n,n,CASE WHEN n=106 THEN now() END FROM generate_series(1,106) n`, [workspaceId])
    }
    const pipelineId = (await pool.query(`SELECT id FROM crm_pipelines WHERE workspace_id=$1 AND position=1`, [f.workspaceId])).rows[0].id
    await pool.query(`INSERT INTO crm_pipeline_stages(workspace_id,pipeline_id,name,category,position,archived_at)
      VALUES($1,$2,'Live','open',0,NULL),($1,$2,'Archived','won',1,now())`, [f.workspaceId, pipelineId])
    const before = await snapshot(f.workspaceId)
    const memberFields = await collect(f, 'record-fields', 'fields', false)
    const machineFields = await collect(f, 'record-fields', 'fields', true)
    expect(machineFields).toHaveLength(120)
    expect(machineFields).toEqual(memberFields)
    const memberPipelines = await collect(f, 'pipelines', 'pipelines', false)
    const machinePipelines = await collect(f, 'pipelines', 'pipelines', true)
    expect(machinePipelines).toHaveLength(105)
    expect(machinePipelines).toEqual(memberPipelines)
    expect(machinePipelines.find((row) => row.id === pipelineId)?.stages).toEqual([expect.objectContaining({ name: 'Live' })])
    for (const machine of [false, true]) {
      const fields = await f.get('/operations/record-fields', machine).query({ entityKind: 'person', includeArchived: 'true' })
      expect(fields.status).toBe(200)
      expect(fields.body.fields).toHaveLength(42)
      expect(fields.body.fields.every((field: { entityKind: string }) => field.entityKind === 'person')).toBe(true)
      expect(fields.body.fields.filter((field: { archivedAt: string | null }) => field.archivedAt !== null)).toHaveLength(2)
      const pipelines = await f.get('/operations/pipelines', machine).query({ includeArchived: 'true' })
      const all = pipelines.body.pipelines as Array<{ id: string; stages: unknown[] }>
      // Explicit archive selection includes archived stages when their parent is on this page.
      const page = all.find((row) => row.id === pipelineId) ?? (await f.get('/operations/pipelines', machine)
        .query({ includeArchived: 'true', cursor: pipelines.body.nextCursor })).body.pipelines.find((row: { id: string }) => row.id === pipelineId)
      expect(page.stages).toHaveLength(2)
    }
    const principal = await keys.authenticate(f.credential.oneTimeSecret)
    expect(principal).not.toBeNull()
    const direct = await createCrmIntegrationRecordReadStore(principal!, pool).fields({ entityKind: 'person', includeArchived: 'true' })
    expect(direct.fields).toHaveLength(42)
    expect(await snapshot(f.workspaceId)).toEqual(before)
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('binds cursors to the workspace, resource and archive/entity filters', async () => {
    const f = await fixture(), other = await fixture()
    await pool.query(`INSERT INTO crm_field_definitions(workspace_id,entity_kind,field_key,label,field_type,position)
      SELECT $1,'person','fixture_'||n,'Fixture','text',n FROM generate_series(1,3) n`, [f.workspaceId])
    const first = await f.get('/operations/record-fields').query({ limit: 1 })
    expect(first.status).toBe(200)
    const cursor = first.body.nextCursor
    expect(cursor).toBeTypeOf('string')
    for (const machine of [false, true]) {
      // The compatibility integration adapter maps domain invalid_input to
      // 422; member operations retain 400. Both must reject the bound cursor.
      const status = machine ? 422 : 400
      for (const query of [{ cursor, includeArchived: 'true' }, { cursor, entityKind: 'company' }]) {
        const rejected = await f.get('/operations/record-fields', machine).query(query)
        expect(rejected.status).toBe(status)
        expect(rejected.body.error).toBe('invalid_input')
      }
      expect((await f.get('/operations/pipelines', machine).query({ cursor })).status).toBe(status)
      expect((await other.get('/operations/record-fields', machine).query({ cursor })).status).toBe(status)
    }
  })

  it('rejects absent read grants, revoked keys and foreign membership without executing a command', async () => {
    const f = await fixture([{ operation: 'crm.catalog.configure', selectors: { eventIds: 'all' } }])
    for (const path of ['record-fields', 'pipelines']) {
      const denied = await f.get(`/operations/${path}`)
      expect(denied.status).toBe(403)
      expect(denied.body.error).toBe('integration_scope_denied')
    }
    const other = await fixture()
    expect((await request(f.app).get(`/api/crm/${other.workspaceId}/operations/record-fields`)).status).toBe(404)
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.userId])
    expect((await f.get('/operations/record-fields', false)).status).toBe(404)
    await keys.revoke(other.workspaceId, other.userId, other.credential.id)
    expect((await other.get('/operations/pipelines')).status).toBe(401)
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('refuses unsupported filters and malformed page queries in both adapters', async () => {
    const f = await fixture(), before = await snapshot(f.workspaceId)
    for (const machine of [false, true]) {
      for (const path of ['record-fields', 'pipelines']) {
        for (const query of [{ entityKind: 'unsupported' }, { includeArchived: 'yes' }, { limit: 0 }, { workspaceId: randomUUID() }]) {
          expect((await f.get(`/operations/${path}`, machine).query(query)).status).toBe(400)
        }
      }
    }
    expect(await snapshot(f.workspaceId)).toEqual(before)
    expect(f.execute).not.toHaveBeenCalled()
  })
})
