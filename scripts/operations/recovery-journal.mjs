/** Apply protected recorded effects in a quarantined restore transaction. [COMP:operations/crm-recovery] */
import {quote,sha} from './recovery-common.mjs'

export async function checkReferentialIntegrity(client) {
  const references=(await client.query(`SELECT c.conname,c.confmatchtype,n.nspname schema_name,t.relname table_name,
    pn.nspname parent_schema,p.relname parent_table,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(id,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.id ORDER BY k.ord) columns,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(id,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.id ORDER BY k.ord) parent_columns
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_class p ON p.oid=c.confrelid JOIN pg_namespace pn ON pn.oid=p.relnamespace
    WHERE c.contype='f' AND c.convalidated AND n.nspname='public' ORDER BY c.conname`)).rows
  for(const r of references) {
    const all=r.columns.map(c=>`t.${quote(c)} IS NOT NULL`).join(' AND '),any=r.columns.map(c=>`t.${quote(c)} IS NOT NULL`).join(' OR ')
    const match=r.columns.map((c,i)=>`p.${quote(r.parent_columns[i])}=t.${quote(c)}`).join(' AND ')
    const invalid=`((${all}) AND NOT EXISTS(SELECT 1 FROM ${quote(r.parent_schema)}.${quote(r.parent_table)} p WHERE ${match}))`
      +(r.confmatchtype==='f'?` OR ((${any}) AND NOT (${all}))`:'')
    if((await client.query(`SELECT 1 FROM ${quote(r.schema_name)}.${quote(r.table_name)} t WHERE ${invalid} LIMIT 1`)).rowCount)throw new Error('Restored foreign-key integrity failed')
  }
  return {status:'passed',constraints:references.length}
}

export function validateCheckpoint(checkpoint,manifest,{maxAgeSeconds,now=Date.now()}={}) {
  if(checkpoint?.schema!=='brian-erasure-checkpoint-v1' || !Array.isArray(checkpoint.records)
    || checkpoint.records.some(r=>typeof r!=='string') || sha(checkpoint.records.join('\n'))!==checkpoint.sha256)throw new Error('Invalid erasure checkpoint checksum')
  if(JSON.stringify(checkpoint.identity)!==JSON.stringify(manifest.identity) || checkpoint.schemaHash!==manifest.schemaHash
    || JSON.stringify(checkpoint.migrations)!==JSON.stringify(manifest.migrations))throw new Error('Erasure checkpoint source or schema mismatch')
  const time=Date.parse(checkpoint.capturedAt)
  if(!Number.isFinite(time) || !Number.isInteger(maxAgeSeconds) || maxAgeSeconds<1 || time<Date.parse(manifest.completedAt) || time>now+5000 || now-time>maxAgeSeconds*1000)throw new Error('A current checkpoint captured after backup and within the explicit freshness window is required')
}

export async function replayJournal(client,checkpoint) {
  let applied=0,alreadyApplied=0
  const erasedFiles=[]
  await client.query('BEGIN')
  try {
    // This connection exists only in the tool-created offline cluster. The tool
    // checks constraints explicitly before committing and never starts workers.
    await client.query("SET LOCAL session_replication_role='replica'")
    let previous=-1n
    for(const payload of checkpoint.records) {
      // PostgreSQL parses keys/values, so bigint/numeric effects are not rounded
      // by JavaScript JSON parsing.
      const row=(await client.query(`SELECT j.id,j.sequence::text,j.workspace_id,j.table_name,j.operation,j.row_key::text,j.effect::text,
        ARRAY(SELECT jsonb_object_keys(j.row_key)) key_names,ARRAY(SELECT jsonb_object_keys(COALESCE(j.effect,'{}'))) effect_names
        FROM jsonb_populate_record(NULL::public.crm_erasure_journal,$1::jsonb) j`,[payload])).rows[0]
      if(!row?.id || BigInt(row.sequence)<=previous)throw new Error('Erasure checkpoint is not strictly ordered')
      previous=BigInt(row.sequence)
      if(row.operation==='delete' && row.table_name==='workspace_files')erasedFiles.push({workspaceId:row.workspace_id,id:JSON.parse(row.row_key).id})
      const existing=await client.query('SELECT to_jsonb(j)=$2::jsonb identical FROM public.crm_erasure_journal j WHERE id=$1',[row.id,payload])
      if(existing.rowCount){if(!existing.rows[0].identical)throw new Error('Existing erasure receipt differs');alreadyApplied++;continue}
      const registry=(await client.query('SELECT * FROM public.crm_erasure_journal_targets WHERE table_name=$1',[row.table_name])).rows[0]
      if(!registry || JSON.stringify([...registry.key_columns].sort())!==JSON.stringify([...row.key_names].sort()))throw new Error('Erasure key is outside the restored schema registry')
      const table='public.'+quote(row.table_name)
      const columns=(await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",[row.table_name])).rows.map(r=>r.column_name)
      if(row.effect_names.some(c=>!columns.includes(c)) || !['insert','update','delete'].includes(row.operation))throw new Error('Unknown erasure effect')
      const match=registry.key_columns.map(c=>`t.${quote(c)} IS NOT DISTINCT FROM k.${quote(c)}`).join(' AND ')
      if(row.operation==='delete') {
        if(row.effect!==null)throw new Error('Delete effect must not carry row content')
        await client.query(`DELETE FROM ${table} t USING jsonb_populate_record(NULL::${table},$1::jsonb) k WHERE ${match}`,[row.row_key])
      } else if(row.operation==='update') {
        if(!row.effect_names.length || row.effect_names.some(c=>registry.key_columns.includes(c)))throw new Error('Invalid redaction columns')
        const names=row.effect_names.map(quote)
        await client.query(`UPDATE ${table} t SET (${names.join(',')})=(SELECT ${names.join(',')} FROM jsonb_populate_record(NULL::${table},$2::jsonb))
          FROM jsonb_populate_record(NULL::${table},$1::jsonb) k WHERE ${match}`,[row.row_key,row.effect])
      } else {
        if(!registry.capture_inserts || row.table_name!=='crm_address_suppression_tombstones')throw new Error('Unapproved recovery insertion')
        await client.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table},$1::jsonb)`,[row.effect])
      }
      await client.query('INSERT INTO public.crm_erasure_journal OVERRIDING SYSTEM VALUE SELECT * FROM jsonb_populate_record(NULL::public.crm_erasure_journal,$1::jsonb)',[payload])
      applied++
    }
    const integrity=await checkReferentialIntegrity(client)
    await client.query("SELECT setval(pg_get_serial_sequence('public.crm_erasure_journal','sequence'),GREATEST(COALESCE((SELECT max(sequence) FROM public.crm_erasure_journal),0),1),EXISTS(SELECT 1 FROM public.crm_erasure_journal))")
    await client.query('COMMIT')
    return {status:'passed',applied,alreadyApplied,integrity,erasedFiles}
  } catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}
}
