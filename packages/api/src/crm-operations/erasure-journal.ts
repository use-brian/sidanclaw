/** Transactional recovery evidence for approved erasures. [COMP:operations/crm-recovery] */
import type {PoolClient} from 'pg'

export async function captureCrmErasure(client:PoolClient):Promise<void> {
  await client.query("SELECT set_config('app.crm_erasure_capture','on',true)")
}
