#!/usr/bin/env node
/** Offline disposable full/PITR restore proof. [COMP:operations/crm-recovery] */
import {mkdir,mkdtemp,writeFile,readFile,rm,lstat} from 'node:fs/promises'
import {createServer} from 'node:net'
import {randomBytes} from 'node:crypto'
import {setTimeout} from 'node:timers/promises'
import {tmpdir} from 'node:os'
import {join,resolve,dirname,basename} from 'node:path'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {runCommand,cleanRuntimeEnvironment,validateAmbientDatabase} from '../crm/local-fixture.mjs'
import {readConfig,options,executable,newDirectory,unsealJson,unsealFile,digestFile,safeRelative,quote,
  databaseClient,databaseEnvironment,inspectDatabase,tableProofs,atomicJson,sha} from './recovery-common.mjs'
import {validateCheckpoint,replayJournal,checkReferentialIntegrity} from './recovery-journal.mjs'

async function port() {
  const server=createServer();return new Promise((accept,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const number=server.address().port;server.close(error=>error?reject(error):accept(number))})})
}
const commandQuote=(s)=>"'"+s.replaceAll("'","'\\''")+"'"
async function extractTar(config,archive,destination,env) {
  const names=(await runCommand('tar',['-tf',archive],{env})).trim().split('\n')
  for(const name of names){const normalized=name.replace(/^\.\//,'').replace(/\/$/,'');if(normalized)safeRelative(normalized)}
  const verbose=await runCommand('tar',['-tvf',archive],{env})
  if(verbose.split('\n').filter(Boolean).some(line=>!['-','d'].includes(line[0])))throw new Error('Physical backup contains links or special entries')
  await runCommand('tar',['-xf',archive,'-C',destination],{env})
}
export async function restoreCheck({config,backupDirectory,journalFile,destination,execute=false,verifyApplication}) {
  validateAmbientDatabase(process.env)
  if(!backupDirectory || !journalFile)throw new Error('Explicit backup directory and current journal checkpoint are required')
  const scratch=await mkdtemp(join(tmpdir(),'brian-recovery-preflight-')),runtime=cleanRuntimeEnvironment(process.env)
  let root,data,started=false,client,work,report
  try {
    const manifest=await unsealJson(join(backupDirectory,'manifest.enc'),config.key,scratch)
    const checkpoint=await unsealJson(journalFile,config.key,scratch)
    if(manifest.schema!=='brian-backup-v1' || !['logical','physical'].includes(manifest.mode) || !Array.isArray(manifest.artifacts)
      || !Array.isArray(manifest.inventory) || !manifest.proofs || manifest.applicationSha!==config.applicationSha)throw new Error('Unknown backup contract or mismatched application SHA')
    validateCheckpoint(checkpoint,manifest,{maxAgeSeconds:config.journalMaxAgeSeconds})
    const seen=new Set()
    for(const artifact of manifest.artifacts) {
      if(safeRelative(artifact.name)!==basename(artifact.name) || seen.has(artifact.name))throw new Error('Invalid artifact inventory')
      seen.add(artifact.name)
      const path=join(backupDirectory,artifact.name),stat=await lstat(path)
      if(!stat.isFile() || stat.isSymbolicLink() || stat.size!==artifact.bytes || await digestFile(path)!==artifact.sha256)throw new Error('Encrypted artifact checksum mismatch')
    }
    const version=await runCommand(executable(config,'postgres'),['--version'],{env:runtime})
    if(!/PostgreSQL\) 18\./.test(version))throw new Error('PostgreSQL 18 with the manifest extensions is required')
    if(manifest.mode==='physical') {
      if(!config.walArchiveDirectory || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(config.recoveryTargetTime ?? '')
        || !Number.isFinite(Date.parse(config.recoveryTargetTime)) || Date.parse(config.recoveryTargetTime)<Date.parse(manifest.completedAt))throw new Error('PITR needs an explicit UTC target after base-backup completion and an encrypted WAL archive')
    }
    if(!execute)return {status:'passed',action:'preflight',mode:manifest.mode,manifestSha256:sha(JSON.stringify(manifest))}
    root=await newDirectory(destination);data=join(root,'data');work=join(root,'.work');await mkdir(work,{mode:0o700})
    await atomicJson(join(root,'recovery-owned.json'),{kind:'disposable-crm-recovery',root})
    const targetPort=await port(),password=randomBytes(32).toString('hex'),database='brian_recovery_'+randomBytes(6).toString('hex')
    if(targetPort===config.database.port)throw new Error('Disposable restore must have a distinct source port')
    const connection={host:'127.0.0.1',port:targetPort,user:'recovery_owner',password,database,sslmode:'disable'}
    let env=databaseEnvironment(config,connection)
    for(const artifact of manifest.artifacts) {
      const plain=join(work,artifact.name.slice(0,-4))
      await unsealFile(join(backupDirectory,artifact.name),plain,config.key)
      if(await digestFile(plain)!==artifact.plaintextSha256)throw new Error('Decrypted artifact checksum mismatch')
    }
    let startup=['-h','127.0.0.1','-p',String(targetPort),'-k',"''"]
    if(manifest.mode==='logical') {
      const pw=join(work,'password');await writeFile(pw,password,{mode:0o600,flag:'wx'})
      await runCommand(executable(config,'initdb'),['-D',data,'-U','recovery_owner','--encoding=UTF8','--locale=C','--auth-host=scram-sha-256','--auth-local=trust','--pwfile',pw],{env:runtime})
      await rm(pw)
    } else {
      await mkdir(data,{mode:0o700});await extractTar(config,join(work,'base.tar'),data,runtime)
      await mkdir(join(data,'pg_wal'),{recursive:true,mode:0o700});await extractTar(config,join(work,'pg_wal.tar'),join(data,'pg_wal'),runtime)
      const walConfig=join(work,'wal-restore.json')
      await writeFile(walConfig,JSON.stringify({keyFile:config.keyFile,keyReference:config.keyReference,walArchiveDirectory:resolve(config.walArchiveDirectory),restoreRoot:root}),{flag:'wx',mode:0o600})
      const restoreCommand=[process.execPath,fileURLToPath(new URL('./brian-wal-archive.mjs',import.meta.url)),'--config',walConfig,'--name','%f','--restore-to','%p'].map(commandQuote).join(' ')
      const hba=join(work,'pg_hba.conf');await writeFile(hba,'host all all 127.0.0.1/32 scram-sha-256\n',{flag:'wx',mode:0o600})
      await writeFile(join(data,'recovery.signal'),'')
      // Replace source configuration completely. Source hooks, sockets,
      // replication endpoints and preload libraries must never run here.
      await writeFile(join(data,'postgresql.auto.conf'),'')
      const settingNames=['max_connections','max_prepared_transactions','max_locks_per_transaction','max_wal_senders','max_worker_processes']
      if(!Array.isArray(manifest.recoverySettings) || manifest.recoverySettings.length!==settingNames.length
        || manifest.recoverySettings.some(s=>!settingNames.includes(s.name) || !/^\d+$/.test(s.setting)))throw new Error('Physical recovery memory prerequisites are missing')
      const pgString=value=>"'"+value.replaceAll('\\','\\\\').replaceAll("'","''")+"'"
      const targetTime=config.recoveryTargetTime.replace('T',' ').replace(/Z$/,'+00')
      await writeFile(join(data,'postgresql.conf'),`listen_addresses='127.0.0.1'\nport=${targetPort}\nunix_socket_directories=''\narchive_mode=off\nshared_preload_libraries=''\nprimary_conninfo=''\nhot_standby=off\n`
        +manifest.recoverySettings.map(s=>`${s.name}=${s.setting}\n`).join('')
        +`hba_file=${pgString(hba)}\nrestore_command=${pgString(restoreCommand)}\nrecovery_target_time=${pgString(targetTime)}\nrecovery_target_action='promote'\nrecovery_target_timeline='latest'\n`)
      connection.user=config.database.user;connection.password=config.database.password;connection.database='postgres';env=databaseEnvironment(config,connection)
    }
    started=true
    await runCommand(executable(config,'pg_ctl'),['-D',data,'-l',join(root,'postgres.log'),'-o',startup.join(' '),'-w','-t','60','start'],{env:runtime})
    let admin
    const connectDeadline=Date.now()+45000
    for(;;) {
      admin=databaseClient({...connection,database:'postgres'})
      try {await admin.connect();break}catch(error){
        await admin.end().catch(()=>{})
        if(manifest.mode!=='physical' || Date.now()>=connectDeadline || !['57P03','ECONNREFUSED','ECONNRESET'].includes(error.code))throw error
        await setTimeout(100)
      }
    }
    try {
      if(manifest.mode==='logical') {
        for(const role of manifest.roles)if(role!=='recovery_owner')await admin.query(`CREATE ROLE ${quote(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`)
        await admin.query(`CREATE DATABASE ${quote(database)}`)
      } else {
        if((await admin.query('SELECT pg_is_in_recovery() recovering')).rows[0].recovering)throw new Error('PITR has not reached and promoted the requested target')
        await admin.query(`ALTER DATABASE ${quote(manifest.identity.database)} RENAME TO ${quote(database)}`)
      }
    } finally {await admin.end()}
    connection.database=database;env=databaseEnvironment(config,connection)
    if(manifest.mode==='logical')await runCommand(executable(config,'pg_restore'),['--no-owner','--no-acl','--exit-on-error','--single-transaction','--dbname',database,join(work,'database.dump')],{env})
    client=databaseClient(connection);await client.connect()
    const actual=await inspectDatabase(client)
    if(actual.schemaHash!==manifest.schemaHash || JSON.stringify(actual.migrations)!==JSON.stringify(manifest.migrations)
      || JSON.stringify(actual.extensions)!==JSON.stringify(manifest.extensions))throw new Error('Restored migration/schema/extension compatibility mismatch')
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const proofs=await tableProofs(client,Object.keys(manifest.proofs));await client.query('COMMIT')
    const expected=config.expectedProofs ?? manifest.proofs
    if(JSON.stringify(proofs)!==JSON.stringify(expected))throw new Error('Restored content proof differs from the expected recovery point')
    const beforeIntegrity=await checkReferentialIntegrity(client)
    const journal=await replayJournal(client,checkpoint)
    for(const inventory of manifest.inventory) {
      if(!/^[a-z0-9_-]{1,60}$/.test(inventory.label))throw new Error('Unsafe restored file label')
      for(const entry of inventory.entries) {
        const path=safeRelative(entry.path)
        const erased=inventory.kind==='files' && journal.erasedFiles.some(f=>path===`${f.workspaceId}/${f.id}`)
        if(erased)continue
        const target=join(root,'files',inventory.label,path);await mkdir(dirname(target),{recursive:true,mode:0o700})
        const source=join(work,safeRelative(entry.artifact).slice(0,-4))
        if(await digestFile(source)!==entry.sha256)throw new Error('Restored file content differs')
        const {copyFile}=await import('node:fs/promises');await copyFile(source,target)
      }
    }
    const application=verifyApplication?await verifyApplication({client,connection,root,manifest,journal}):{status:'not_run',reason:'Run the local contract harness for canonical application assertions.'}
    report={schema:'brian-restore-proof-v1',status:application.status==='passed'?'passed':application.status==='failed'?'failed':'blocked',mode:manifest.mode,
      startedAt:manifest.startedAt,completedAt:new Date().toISOString(),applicationSha:manifest.applicationSha,
      migrations:manifest.migrations,schemaHash:manifest.schemaHash,manifestSha256:sha(JSON.stringify(manifest)),proofs,
      beforeIntegrity,journal:{status:journal.status,applied:journal.applied,alreadyApplied:journal.alreadyApplied,integrity:journal.integrity},
      application,operationalReadiness:'not_run',sendingStarted:false,disposable:true}
    await atomicJson(join(root,'report.json'),report)
    return report
  } catch(error) {
    if(root)await atomicJson(join(root,'report.json'),{schema:'brian-restore-proof-v1',status:'failed',error:'restore_failed',sendingStarted:false}).catch(()=>{})
    throw error
  } finally {
    if(client)await client.end().catch(()=>{})
    if(started) {
      // Failure to stop preserves the owned directory and propagates failure.
      let running=false;try{await lstat(join(data,'postmaster.pid'));running=true}catch{}
      if(running)await runCommand(executable(config,'pg_ctl'),['-D',data,'-m','fast','-w','stop'],{env:runtime})
    }
    if(root)for(const name of ['data','.work','files'])await rm(join(root,name),{recursive:true,force:true})
    await rm(scratch,{recursive:true,force:true})
  }
}
async function main() {
  const args=options(['config','backup','journal','destination'])
  if(args.help){console.log('Usage: brian-restore-check.mjs --config PRIVATE.json --backup /backup --journal /current/journal.enc [--execute --destination /new/local/target]\nDefault: authenticated preflight. Execution creates and removes its own loopback PostgreSQL cluster; preserves report.json. No application or sender starts.');return}
  const report=await restoreCheck({config:await readConfig(args.config),backupDirectory:args.backup,journalFile:args.journal,destination:args.destination,execute:args.execute})
  console.log(JSON.stringify(report))
  if(report.status!=='passed')process.exitCode=1
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Restore proof failed. The target remains quarantined; inspect its private report and PostgreSQL log.');process.exitCode=1})
