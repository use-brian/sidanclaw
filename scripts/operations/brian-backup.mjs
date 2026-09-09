#!/usr/bin/env node
/** Explicit encrypted backups and erasure checkpoints. [COMP:operations/crm-recovery] */
import {mkdir,rm,readFile} from 'node:fs/promises'
import {join,resolve,basename} from 'node:path'
import {pathToFileURL} from 'node:url'
import {runCommand} from '../crm/local-fixture.mjs'
import {readConfig,options,executable,databaseClient,databaseEnvironment,newDirectory,inspectDatabase,tableProofs,
  journalCheckpoint,inventoryTree,sealFile,sealJson,atomicJson,runUploadHook,sha} from './recovery-common.mjs'

export async function backup({config,mode='logical',destination,execute=false}) {
  if(!['logical','physical','journal'].includes(mode))throw new Error('Mode must be logical, physical or journal')
  if(!/^[a-f0-9]{40}$/.test(config.applicationSha ?? ''))throw new Error('An exact applicationSha is required')
  if(!Array.isArray(config.protectedKeyReferences) || config.protectedKeyReferences.some(v=>typeof v!=='string'))throw new Error('List protectedKeyReferences explicitly, including suppression and connector key custody')
  if(mode!=='journal' && (config.quiescedSnapshot!==true || !Array.isArray(config.fileRoots)))throw new Error('Explicit quiescedSnapshot attestation and fileRoots inventory are required')
  const env=databaseEnvironment(config),client=databaseClient(config.database)
  let directory,work,transaction=false
  await client.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');transaction=true
    const metadata=await inspectDatabase(client)
    const version=await runCommand(executable(config,mode==='physical'?'pg_basebackup':'pg_dump'),['--version'],{env})
    if(!/PostgreSQL\) 18\./.test(version))throw new Error('Selected PostgreSQL backup tool must be version 18')
    let archiveStatus=null
    if(mode==='physical') {
      archiveStatus=(await client.query("SELECT current_setting('archive_mode') mode,current_setting('wal_level') wal_level,last_archived_wal,last_archived_time,failed_count,last_failed_time FROM pg_stat_archiver")).rows[0]
      if(!['on','always'].includes(archiveStatus.mode) || archiveStatus.wal_level==='minimal' || !config.walArchiveDirectory)throw new Error('Physical PITR requires configured continuous WAL archiving and an explicit archive directory')
      if((await client.query("SELECT count(*)::int n FROM pg_tablespace WHERE spcname NOT IN('pg_default','pg_global')")).rows[0].n)throw new Error('External tablespaces require a separately qualified restore mapping')
      if(!archiveStatus.last_archived_wal)throw new Error('Physical backup preflight requires a completed archived WAL segment')
      await readFile(join(config.walArchiveDirectory,archiveStatus.last_archived_wal+'.enc'))
    }
    const inventory=[]
    for(const root of mode==='journal'?[]:config.fileRoots) {
      if(!/^[a-z0-9_-]{1,60}$/.test(root.label ?? '') || !['files','config','secrets'].includes(root.kind))throw new Error('Every file root needs a unique safe label and files/config/secrets kind')
      if(inventory.some(r=>r.label===root.label))throw new Error('Duplicate file inventory label')
      inventory.push({label:root.label,kind:root.kind,entries:await inventoryTree(root.path,{hash:execute})})
      if(root.kind==='files' && inventory.at(-1).entries.some(e=>!/^([a-f0-9]{8}-[a-f0-9-]{27})\/([a-f0-9]{8}-[a-f0-9-]{27})$/i.test(e.path)))throw new Error('File object snapshots must use canonical workspace/file UUID keys')
    }
    const common={...metadata,applicationSha:config.applicationSha,applicationDirty:config.applicationDirty===true,
      protectedKeyReferences:config.protectedKeyReferences,keyReference:config.keyReference}
    if(mode!=='journal') {
      if(!Array.isArray(config.proofTables) || !config.proofTables.length)throw new Error('Explicit proofTables are required')
      const known=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename=ANY($1::text[])",[config.proofTables])).rows.map(r=>r.tablename)
      if(config.proofTables.some(t=>!known.includes(t)))throw new Error('A proof table is absent from the actual schema')
    }
    if(!execute)return {status:'passed',action:'preflight',mode,...common,inventory,archiveStatus,
      next:'Actual backup requires --execute and an explicit new --destination.'}
    directory=await newDirectory(destination);work=join(directory,'.work');await mkdir(work,{mode:0o700})
    const checkpoint=await journalCheckpoint(client,common)
    if(mode==='journal') {
      await client.query('COMMIT');transaction=false
      const artifact=await sealJson(checkpoint,join(directory,'journal.enc'),config.key)
      await atomicJson(join(directory,'receipt.json'),{schema:'brian-backup-receipt-v1',status:'passed',mode,completedAt:new Date().toISOString(),artifact})
      await runUploadHook(config,directory);return {status:'passed',mode,directory,checkpointSha256:checkpoint.sha256}
    }
    const snapshot=(await client.query('SELECT pg_export_snapshot() snapshot')).rows[0].snapshot
    const proofs=await tableProofs(client,config.proofTables),artifacts=[]
    const add=async(source,name)=>{const result=await sealFile(source,join(directory,name),config.key);artifacts.push({name,...result,plaintextSha256:await import('./recovery-common.mjs').then(m=>m.digestFile(source))})}
    if(mode==='logical') {
      const dump=join(work,'database.dump')
      await runCommand(executable(config,'pg_dump'),['--format=custom','--no-owner','--no-acl','--snapshot',snapshot,'--file',dump],{env})
      await add(dump,'database.dump.enc')
    } else {
      const physical=join(work,'physical');await mkdir(physical,{mode:0o700})
      await runCommand(executable(config,'pg_basebackup'),['--pgdata',physical,'--format=tar','--wal-method=stream','--checkpoint=fast','--manifest-checksums=SHA256'],{env})
      const {readdir}=await import('node:fs/promises')
      for(const name of (await readdir(physical)).sort()) {
        if(!['base.tar','pg_wal.tar','backup_manifest'].includes(name))throw new Error('Unexpected base-backup artifact; tablespace mappings are unsupported')
        await add(join(physical,name),name+'.enc')
      }
    }
    for(const root of inventory) {
      const source=config.fileRoots.find(r=>r.label===root.label)
      for(const [index,entry] of root.entries.entries()) {
        entry.artifact=`file-${root.label}-${index}.enc`;await add(join(source.path,entry.path),entry.artifact)
      }
      if(sha(JSON.stringify(await inventoryTree(source.path)))!==sha(JSON.stringify(root.entries.map(({artifact,...entry})=>entry))))throw new Error('File snapshot changed during backup; acquire a quiesced snapshot and retry')
    }
    const manifest={schema:'brian-backup-v1',mode,...common,startedAt:checkpoint.capturedAt,completedAt:new Date().toISOString(),
      quiescedSnapshot:true,inventory,proofs,archiveStatus,artifacts,
      prerequisites:['PostgreSQL 18 and matching extensions','Matched application SHA and complete migration set','Protected key custody','Current authenticated erasure checkpoint before application startup']}
    await client.query('COMMIT');transaction=false
    await sealJson(checkpoint,join(directory,'journal-at-backup.enc'),config.key)
    await sealJson(manifest,join(directory,'manifest.enc'),config.key)
    await atomicJson(join(directory,'receipt.json'),{schema:'brian-backup-receipt-v1',status:'passed',mode,completedAt:manifest.completedAt,manifestSha256:sha(JSON.stringify(manifest))})
    await runUploadHook(config,directory)
    return {status:'passed',mode,directory,manifestSha256:sha(JSON.stringify(manifest))}
  } catch(error) {
    if(transaction)await client.query('ROLLBACK').catch(()=>{})
    if(directory)await atomicJson(join(directory,'receipt.json'),{schema:'brian-backup-receipt-v1',status:'failed',mode,error:'backup_failed'}).catch(()=>{})
    throw error
  } finally {await client.end();if(work)await rm(work,{recursive:true,force:true})}
}

async function main() {
  const args=options(['config','mode','destination'])
  if(args.help){console.log('Usage: node scripts/operations/brian-backup.mjs --config PRIVATE.json [--mode logical|physical|journal] [--execute --destination /new/absolute/path]\nDefault: read-only preflight. Credentials and 32-byte encryption key come from private files. See docs/operations/crm-recovery.md.');return}
  const result=await backup({config:await readConfig(args.config),mode:args.mode,destination:args.destination,execute:args.execute})
  // CLI output intentionally excludes database, roles, paths inside source inventories and keys.
  console.log(JSON.stringify({status:result.status,action:result.action ?? 'backup',mode:result.mode,directory:result.directory,manifestSha256:result.manifestSha256,next:result.next}))
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Backup failed. Check private configuration, PostgreSQL prerequisites and the destination receipt; no backup is approved.');process.exitCode=1})
