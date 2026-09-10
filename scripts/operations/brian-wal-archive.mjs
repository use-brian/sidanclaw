#!/usr/bin/env node
/** Durable encrypted archive_command / restore_command. [COMP:operations/crm-recovery] */
import {lstat,readFile,link,rm,open,realpath} from 'node:fs/promises'
import {join,resolve,dirname,basename,sep} from 'node:path'
import {randomBytes} from 'node:crypto'
import {pathToFileURL} from 'node:url'
import {privateFile,options,sealFile,unsealFile,digestFile} from './recovery-common.mjs'

export function walName(name) {
  if(typeof name!=='string'||!/^([A-F0-9]{24}|[A-F0-9]{8}\.history|[A-F0-9]{24}\.[A-F0-9]{8}\.backup)$/.test(name))throw new Error('Invalid WAL archive name')
  return name
}
export async function readWalConfig(path) {
  const config=JSON.parse(await privateFile(path));config.key=await privateFile(config.keyFile,128)
  if(config.key.length!==32 || typeof config.keyReference!=='string' || !config.keyReference || !config.walArchiveDirectory || !resolve(config.walArchiveDirectory).startsWith('/'))throw new Error('WAL archive needs explicit encryption custody and directory')
  const stat=await lstat(config.walArchiveDirectory)
  if(!stat.isDirectory() || stat.isSymbolicLink() || stat.mode&0o077)throw new Error('WAL archive must be an owner-private directory')
  return config
}
export async function archiveWal(config,source,name) {
  walName(name)
  const file=join(config.walArchiveDirectory,name+'.enc'),temp=file+'.pending-'+randomBytes(8).toString('hex')
  const stat=await lstat(source)
  if(!stat.isFile() || stat.isSymbolicLink())throw new Error('WAL source must be a regular file')
  try {
    await sealFile(source,temp,config.key,name+'.enc')
    try {await link(temp,file)}catch(error){
      if(error.code!=='EEXIST')throw error
      const check=temp+'.check'
      try {await unsealFile(file,check,config.key,name+'.enc');if(await digestFile(source)!==await digestFile(check))throw new Error('WAL collision with different content')}
      finally {await rm(check,{force:true})}
    }
    const directory=await open(config.walArchiveDirectory,'r');try{await directory.sync()}finally{await directory.close()}
    return {status:'passed',name}
  } finally {await rm(temp,{force:true})}
}
export async function restoreWal(config,name,destination) {
  walName(name)
  if(!config.restoreRoot)throw new Error('A disposable restoreRoot is required')
  const root=await realpath(config.restoreRoot)
  const marker=JSON.parse(await readFile(join(root,'recovery-owned.json'),'utf8'))
  if(marker.root!==root || marker.kind!=='disposable-crm-recovery')throw new Error('Restore ownership marker mismatch')
  const target=resolve(destination),parent=await realpath(dirname(target))
  if(!parent.startsWith(root+sep) || !['RECOVERYXLOG','RECOVERYHISTORY'].includes(basename(target)))throw new Error('WAL restore target must be PostgreSQL recovery scratch inside the owned target')
  try{const stat=await lstat(target);if(!stat.isFile() || stat.isSymbolicLink())throw new Error('Unsafe WAL restore scratch');await rm(target)}catch(error){if(error.code!=='ENOENT')throw error}
  try {await unsealFile(join(config.walArchiveDirectory,name+'.enc'),target,config.key,name+'.enc')}
  catch(error){if(error.code==='ENOENT')throw Object.assign(new Error('Requested WAL segment unavailable'),{code:'WAL_NOT_FOUND'});throw error}
  return {status:'passed',name}
}
async function main() {
  const args=options(['config','source','name','restore-to'])
  if(args.help){console.log('Usage: brian-wal-archive.mjs --config PRIVATE.json --source %p --name %f\nRestore: --config PRIVATE-RESTORE.json --name %f --restore-to %p\nEvery successful archive is encrypted, collision-checked and fsynced.');return}
  const config=await readWalConfig(args.config)
  if(args['restore-to'])await restoreWal(config,args.name,args['restore-to'])
  else await archiveWal(config,args.source,args.name)
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{if(error.code!=='WAL_NOT_FOUND')console.error('WAL archive/retrieval failed; inspect archive age, permissions, key custody and disk capacity.');process.exitCode=1})
