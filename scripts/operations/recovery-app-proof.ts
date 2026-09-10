/** Disposable harness callback, never a live-DB operator command. [COMP:operations/crm-recovery] */
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {getPool} from '../../packages/api/src/db/client.js'
import {createDbCrmIntakeReadStore} from '../../packages/api/src/db/crm-intake-store.js'
import {readCrmAddressSuppressions} from '../../packages/api/src/crm-operations/suppression-tombstones.js'

const root=resolve(process.env.BRIAN_RECOVERY_PROOF_ROOT ?? '/invalid'),marker=JSON.parse(await readFile(join(root,'recovery-owned.json'),'utf8'))
const url=new URL(process.env.DATABASE_URL!)
assert.equal(marker.kind,'disposable-crm-recovery');assert.equal(marker.root,root)
assert.equal(url.hostname,'127.0.0.1');assert.match(url.pathname,/^\/brian_recovery_[a-f0-9]{12}$/)
const input=JSON.parse(await readFile(join(root,'proof-context.json'),'utf8')),pool=getPool()
try {
  assert.equal((await createDbCrmIntakeReadStore().checkSendability(input.workspaceId,input.contactId,'email','updates')).verdict,'allowed')
  assert.equal((await readCrmAddressSuppressions(pool,input.workspaceId,'email','erased@example.com','updates')).length,1)
  console.log(JSON.stringify({status:'passed',assertions:['restored_sendability','restored_address_suppression']}))
}finally{await pool.end()}
