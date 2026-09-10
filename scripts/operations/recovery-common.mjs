/** Portable recovery primitives. [COMP:operations/crm-recovery] */
import {createHash,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto'
import {createReadStream,createWriteStream} from 'node:fs'
import {lstat,readFile,writeFile,mkdir,readdir,open,rename,rm,realpath} from 'node:fs/promises'
import {pipeline} from 'node:stream/promises'
import {resolve,join,dirname,basename,relative,isAbsolute} from 'node:path'
import {parseArgs} from 'node:util'
import pg from 'pg'
import {cleanRuntimeEnvironment,runCommand} from '../crm/local-fixture.mjs'

export const quote=(name)=>'"'+name.replaceAll('"','""')+'"'
export const sha=(bytes)=>createHash('sha256').update(bytes).digest('hex')
export const executable=(config,name)=>config.pgBin?join(resolve(config.pgBin),name):name
export function options(names,args=process.argv.slice(2)) {
  return parseArgs({args,options:Object.fromEntries([...names.map(n=>[n,{type:'string'}]),['execute',{type:'boolean'}],['help',{type:'boolean'}]])}).values
}
export async function privateFile(path,maxBytes=1048576) {
  const stat=await lstat(path)
  if(!stat.isFile() || stat.isSymbolicLink() || stat.mode&0o077 || stat.size>maxBytes || process.getuid && stat.uid!==process.getuid())throw new Error('A bounded owner-private regular file is required')
  return readFile(path)
}
export async function readConfig(path) {
  if(!path)throw new Error('An explicit --config owner-private JSON file is required')
  const config=JSON.parse(await privateFile(path)),db=config.database
  if(!db || typeof db!=='object' || Object.keys(db).some(k=>!['host','port','user','password','database','sslmode'].includes(k))
    || ![db.host,db.user,db.database].every(v=>typeof v==='string' && /^[a-zA-Z0-9_.:-]+$/.test(v))
    || !Number.isInteger(db.port) || db.port<1 || db.port>65535 || typeof db.password!=='string'
    || !['disable','require','verify-full'].includes(db.sslmode ?? 'verify-full'))throw new Error('Invalid explicit database configuration')
  if(!config.keyFile || !/^[a-zA-Z0-9_.:/-]{1,200}$/.test(config.keyReference ?? ''))throw new Error('Encryption key file and custody reference are required')
  const key=await privateFile(config.keyFile,128)
  if(key.length!==32)throw new Error('Encryption key must contain exactly 32 raw bytes')
  return {...config,key}
}
export function databaseEnvironment(config,database=config.database) {
  return {...cleanRuntimeEnvironment(process.env),PGHOST:database.host,PGPORT:String(database.port),PGUSER:database.user,
    PGPASSWORD:database.password,PGDATABASE:database.database,PGSSLMODE:database.sslmode ?? 'verify-full',PGCONNECT_TIMEOUT:'10'}
}
export function databaseClient(database) {
  return new pg.Client({host:database.host,port:database.port,user:database.user,password:database.password,database:database.database,
    connectionTimeoutMillis:10000,ssl:database.sslmode==='disable'?false:{rejectUnauthorized:database.sslmode!=='require'}})
}
export async function newDirectory(path) {
  if(!path || !isAbsolute(path) || resolve(path)==='/')throw new Error('An explicit absolute new destination is required')
  // mkdir without recursive/exist_ok deliberately refuses existing targets.
  await mkdir(path,{mode:0o700})
  return realpath(path)
}
export async function digestFile(path) {
  const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk)
  return hash.digest('hex')
}
const MAGIC=Buffer.from('BRIAN-RECOVERY-1\n')
export async function sealFile(source,destination,key,label=basename(destination)) {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv)
  cipher.setAAD(Buffer.from(label))
  await writeFile(destination,Buffer.concat([MAGIC,iv]),{flag:'wx',mode:0o600})
  try {
    await pipeline(createReadStream(source),cipher,createWriteStream(destination,{flags:'a',mode:0o600}))
    const handle=await open(destination,'a');try{await handle.write(cipher.getAuthTag());await handle.sync()}finally{await handle.close()}
    return {sha256:await digestFile(destination),bytes:(await lstat(destination)).size}
  } catch(error){await rm(destination,{force:true});throw error}
}
export async function unsealFile(source,destination,key,label=basename(source)) {
  const stat=await lstat(source)
  if(!stat.isFile() || stat.isSymbolicLink() || stat.size<MAGIC.length+28)throw new Error('Invalid encrypted artifact')
  const handle=await open(source,'r'),head=Buffer.alloc(MAGIC.length+12),tag=Buffer.alloc(16)
  try {await handle.read(head,0,head.length,0);await handle.read(tag,0,16,stat.size-16)}finally{await handle.close()}
  if(!head.subarray(0,MAGIC.length).equals(MAGIC))throw new Error('Unknown recovery artifact format')
  const decipher=createDecipheriv('aes-256-gcm',key,head.subarray(MAGIC.length));decipher.setAAD(Buffer.from(label));decipher.setAuthTag(tag)
  try {await pipeline(createReadStream(source,{start:head.length,end:stat.size-17}),decipher,createWriteStream(destination,{flags:'wx',mode:0o600}))}
  catch {await rm(destination,{force:true});throw new Error('Artifact authentication failed')}
}
export async function sealJson(value,destination,key) {
  const temp=destination+'.plain-'+randomBytes(6).toString('hex')
  try{await writeFile(temp,JSON.stringify(value),{mode:0o600,flag:'wx'});return await sealFile(temp,destination,key)}finally{await rm(temp,{force:true})}
}
export async function unsealJson(source,key,scratch) {
  const temp=join(scratch,randomBytes(12).toString('hex'))
  try{await unsealFile(source,temp,key);return JSON.parse(await readFile(temp,'utf8'))}finally{await rm(temp,{force:true})}
}
export async function inventoryTree(path,{hash=true}={}) {
  const root=resolve(path),entries=[]
  async function walk(current) {
    const stat=await lstat(current)
    if(stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile())throw new Error('File snapshots cannot contain links or special files')
    if(stat.isDirectory()){for(const name of (await readdir(current)).sort())await walk(join(current,name))}
    else entries.push({path:relative(root,current),bytes:stat.size,...(hash?{sha256:await digestFile(current)}:{})})
  }
  if(!(await lstat(root)).isDirectory())throw new Error('File snapshot root must be a directory')
  await walk(root);return entries
}
export function safeRelative(path) {
  if(typeof path!=='string' || !path || isAbsolute(path) || path.split(/[\\/]/).some(x=>x==='..'||x==='.') || path.includes('\0'))throw new Error('Unsafe artifact path')
  return path
}
export async function inspectDatabase(client) {
  // SQL-to-JSON text hashes must not depend on the source server's timezone
  // or display defaults (physical restore intentionally strips its config).
  await client.query("SET TIME ZONE 'UTC'; SET DateStyle='ISO,YMD'; SET IntervalStyle='iso_8601'; SET bytea_output='hex'")
  const identity=(await client.query(`SELECT (pg_control_system()).system_identifier::text AS cluster,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
    current_database() AS database, current_setting('server_version') AS postgres_version`)).rows[0]
  if(!/^18\./.test(identity.postgres_version))throw new Error('Recovery tools require PostgreSQL 18')
  const migrations=(await client.query('SELECT name FROM public._migrations ORDER BY name')).rows.map(r=>r.name)
  if(!migrations.includes('522_crm_erasure_journal.sql'))throw new Error('Erasure-journal migration 522 is required; pre-journal recovery needs owner qualification')
  // pg_dump compacts dropped-column ordinal gaps. Compare semantic column
  // contracts, not physical attnum positions.
  const columns=(await client.query(`SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default,
    character_maximum_length,numeric_precision,numeric_scale,datetime_precision,collation_name,is_identity,identity_generation,is_generated,generation_expression
    FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,column_name`)).rows
  const constraints=(await client.query(`SELECT t.relname,c.conname,pg_get_constraintdef(c.oid) definition
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' ORDER BY t.relname,c.conname`)).rows
  const routines=(await client.query(`SELECT p.proname,pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prokind IN('f','p') AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
    ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)`)).rows
  const uncovered=(await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN public.crm_erasure_journal_targets t ON t.table_name=c.relname
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname NOT IN('crm_erasure_journal','crm_erasure_journal_targets','_migrations')
    AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
    AND (t.table_name IS NULL OR t.key_columns IS DISTINCT FROM COALESCE((SELECT array_agg(a.attname::text ORDER BY k.ord)
      FROM pg_constraint p,unnest(p.conkey) WITH ORDINALITY k(id,ord),pg_attribute a
      WHERE p.conrelid=c.oid AND p.contype='p' AND a.attrelid=c.oid AND a.attnum=k.id),'{}'::text[])
      OR NOT EXISTS(SELECT 1 FROM pg_trigger g WHERE g.tgrelid=c.oid AND g.tgname='crm_recovery_capture' AND g.tgenabled='O'))`)).rows
  if(uncovered.length)throw new Error('Recovery capture schema drift: run the schema migration that installs erasure capture for new tables')
  const roles=(await client.query("SELECT rolname FROM pg_roles WHERE rolname NOT LIKE 'pg_%' ORDER BY rolname")).rows.map(r=>r.rolname)
  const extensions=(await client.query('SELECT extname,extversion FROM pg_extension ORDER BY extname')).rows
  const recoverySettings=(await client.query(`SELECT name,setting FROM pg_settings WHERE name=ANY($1::text[]) ORDER BY name`,[
    ['max_connections','max_prepared_transactions','max_locks_per_transaction','max_wal_senders','max_worker_processes']])).rows
  return {identity,migrations,schemaHash:sha(JSON.stringify({columns,constraints,routines})),roles,extensions,recoverySettings}
}
export async function tableProofs(client,tables) {
  if(!Array.isArray(tables) || !tables.length || tables.some(t=>typeof t!=='string'||!/^[a-z_][a-z0-9_]*$/.test(t)))throw new Error('Explicit proofTables are required')
  const proofs={}
  for(const table of tables) {
    const hash=createHash('sha256');let count=0
    // jsonb textual ordering avoids assumed keys and preserves exact numeric values.
    await client.query(`DECLARE recovery_proof NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text payload FROM public.${quote(table)} t ORDER BY to_jsonb(t)::text COLLATE "C"`)
    for(;;){const rows=(await client.query('FETCH FORWARD 128 FROM recovery_proof')).rows;if(!rows.length)break;for(const row of rows){hash.update(row.payload+'\n');count++}}
    await client.query('CLOSE recovery_proof');proofs[table]={count,sha256:hash.digest('hex')}
  }
  return proofs
}
export async function journalCheckpoint(client,metadata) {
  const records=[];let bytes=0
  await client.query('DECLARE recovery_journal NO SCROLL CURSOR FOR SELECT to_jsonb(j)::text payload FROM public.crm_erasure_journal j ORDER BY sequence')
  for(;;){const rows=(await client.query('FETCH FORWARD 256 FROM recovery_journal')).rows;if(!rows.length)break;for(const row of rows){bytes+=Buffer.byteLength(row.payload);if(bytes>67108864)throw new Error('Journal checkpoint exceeds the 64 MiB v1 envelope; qualify a partitioned checkpoint before recovery');records.push(row.payload)}}
  await client.query('CLOSE recovery_journal')
  const snapshot=(await client.query('SELECT transaction_timestamp() captured_at,txid_current_snapshot()::text snapshot')).rows[0]
  return {schema:'brian-erasure-checkpoint-v1',...metadata,capturedAt:snapshot.captured_at.toISOString(),coverageSnapshot:snapshot.snapshot,records,sha256:sha(records.join('\n'))}
}
export async function runUploadHook(config,artifact) {
  if(!config.uploadHook)return
  const hook=config.uploadHook
  if(!Array.isArray(hook) || !hook.length || !isAbsolute(hook[0]) || hook.some(v=>typeof v!=='string'))throw new Error('Upload hook must be an explicit absolute executable plus argument array')
  await runCommand(hook[0],hook.slice(1).map(v=>v.replaceAll('{artifact}',artifact)),{env:cleanRuntimeEnvironment(process.env)})
}
export async function atomicJson(path,value) {
  const temp=path+'.tmp-'+randomBytes(6).toString('hex');await writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(temp,path)
  const h=await open(dirname(path),'r');try{await h.sync()}finally{await h.close()}
}
