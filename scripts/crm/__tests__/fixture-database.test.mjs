import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import pg from 'pg'
import { assertLocalFixture } from '../local-fixture.mjs'

test('[COMP:crm/assurance-fixture] Default PostgreSQL clients remain inside the disposable cluster', async () => {
  const marker = await assertLocalFixture()
  const defaults = new pg.Client()
  try {
    await defaults.connect()
    const result = await defaults.query(`SELECT current_database() AS database, current_user AS role,
      host(inet_server_addr()) AS host, inet_server_port() AS port`)
    assert.deepEqual(result.rows, [{ database: 'brian_assurance', role: 'assurance_owner', host: '127.0.0.1', port: marker.port }])
  } finally { await defaults.end() }
  // An explicit database name must still target this server, never an ambient instance.
  const missing = new pg.Client({ database: `fixture_missing_${randomUUID().replaceAll('-', '')}` })
  try { await assert.rejects(missing.connect(), { code: '3D000' }) }
  finally { await missing.end() }
})

test('[COMP:crm/assurance-fixture] Actual migrations and application-role RLS', async () => {
  await assertLocalFixture()
  const owner = new pg.Client({ connectionString: process.env.DATABASE_URL })
  const app = new pg.Client({ connectionString: process.env.DATABASE_URL_APP })
  await owner.connect()
  await app.connect()
  try {
    const migrations = await owner.query('SELECT name FROM _migrations ORDER BY name')
    assert(migrations.rows.some((row) => row.name === '000_open_schema_v1.sql'))
    assert(migrations.rows.some((row) => row.name === '460_association_operations.sql'))
    const roles = await app.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user')
    assert.equal(roles.rows[0].rolsuper, false)
    assert.equal(roles.rows[0].rolbypassrls, false)
    const userId = randomUUID()
    const otherUserId = randomUUID()
    const workspaceId = randomUUID()
    const otherWorkspaceId = randomUUID()
    await owner.query(`INSERT INTO users (id, auth_provider_id) VALUES ($1::uuid,$1::text),($2::uuid,$2::text)`, [userId, otherUserId])
    await owner.query(`INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'Fixture One',$2),($3,'Fixture Two',$4)`, [workspaceId, userId, otherWorkspaceId, otherUserId])
    await owner.query(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner'),($3,$4,'owner')`, [workspaceId, userId, otherWorkspaceId, otherUserId])
    await owner.query(`INSERT INTO association_membership_plans (workspace_id,plan_key,name,currency,fee_minor,billing_period)
      VALUES ($1,'annual','Annual','USD',0,'annual'),($2,'annual','Annual','USD',0,'annual')`, [workspaceId, otherWorkspaceId])
    await app.query('BEGIN')
    await app.query(`SELECT set_config('app.current_user_id',$1,true)`, [userId])
    const rows = await app.query('SELECT workspace_id FROM association_membership_plans')
    assert.deepEqual(rows.rows.map((row) => row.workspace_id), [workspaceId])
    const write = await app.query(`UPDATE association_membership_plans SET name='Changed' WHERE workspace_id=$1`, [otherWorkspaceId])
    assert.equal(write.rowCount, 0)
    await assert.rejects(app.query(`INSERT INTO association_membership_plans (workspace_id,plan_key,name,currency,fee_minor,billing_period)
      VALUES ($1,'forbidden','Forbidden','USD',0,'annual')`, [otherWorkspaceId]), /row-level security/)
    await app.query('ROLLBACK')
  } finally {
    await app.end()
    await owner.end()
  }
})
