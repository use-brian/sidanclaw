/** Retryable live-object deletion; pending bytes never count as erased. [COMP:crm/file-cleanup] */
import {randomUUID} from 'node:crypto'
import {query} from '../db/client.js'
import type {FilesClientResolver} from '../files/files-api.js'
import {parseStorageKey} from '../files/gcs-client.js'

export function createCrmImportFileCleanupWorker(options:{resolver:Pick<FilesClientResolver,'forUri'>;intervalMs?:number;onError?:()=>void}) {
  let timer:ReturnType<typeof setInterval>|null=null,running:Promise<number>|null=null
  async function perform() {
    let processed=0
    for(let i=0;i<25;i++) {
      const token=randomUUID()
      const row=(await query<{id:string;workspace_id:string;file_id:string;storage_uri:string}>(`UPDATE crm_import_file_cleanups SET status='leased',lease_token=$1,
        leased_until=clock_timestamp()+interval '2 minutes',attempts=attempts+1,error_code=NULL
        WHERE id=(SELECT id FROM crm_import_file_cleanups WHERE
          ((status IN('queued','failed') AND next_attempt_at<=clock_timestamp()) OR (status='leased' AND leased_until<=clock_timestamp()))
          ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id,workspace_id,file_id,storage_uri`,[token])).rows[0]
      if(!row)break
      processed++
      try {
        const key=parseStorageKey(row.storage_uri)
        if(key!==`${row.workspace_id}/${row.file_id}`)throw new Error('Invalid cleanup target')
        const storage=await options.resolver.forUri(row.workspace_id,row.storage_uri)
        await storage.deleteBlob(key)
        await query(`UPDATE crm_import_file_cleanups SET status='completed',storage_uri=NULL,lease_token=NULL,leased_until=NULL,completed_at=clock_timestamp()
          WHERE id=$1 AND status='leased' AND lease_token=$2`,[row.id,token])
      }catch {
        await query(`UPDATE crm_import_file_cleanups SET status='failed',lease_token=NULL,leased_until=NULL,error_code='file_cleanup_failed',
          next_attempt_at=clock_timestamp()+LEAST(3600,30*power(2,LEAST(attempts,7))) * interval '1 second'
          WHERE id=$1 AND status='leased' AND lease_token=$2`,[row.id,token])
        options.onError?.()
      }
    }
    return processed
  }
  const tick=()=>{if(running)return running;running=perform().catch(()=>{options.onError?.();return 0}).finally(()=>{running=null});return running}
  return {tick,start(){if(timer)return;timer=setInterval(()=>void tick(),Math.max(1000,options.intervalMs ?? 30_000));timer.unref?.();void tick()},
    stop(){if(timer)clearInterval(timer);timer=null}}
}
