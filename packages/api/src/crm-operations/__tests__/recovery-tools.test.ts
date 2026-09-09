import {randomBytes} from 'node:crypto'
import {mkdtemp,writeFile,readFile,rm,mkdir,symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {afterEach,describe,expect,it} from 'vitest'
const base=new URL('../../../../../scripts/operations/',import.meta.url)
const {sealFile,unsealFile,inventoryTree,newDirectory,safeRelative,readConfig,sha}=await import(new URL('recovery-common.mjs',base).href)
const {archiveWal,walName}=await import(new URL('brian-wal-archive.mjs',base).href)
const {validateCheckpoint}=await import(new URL('recovery-journal.mjs',base).href)
const directories:string[]=[]
async function directory(){const path=await mkdtemp(join(tmpdir(),'recovery-unit-'));directories.push(path);return path}
describe('[COMP:operations/crm-recovery] Portable artifact boundaries',()=>{
  afterEach(async()=>{for(const path of directories.splice(0))await rm(path,{recursive:true,force:true})})
  it('authenticates artifact bytes and names and removes failed plaintext',async()=>{
    const dir=await directory(),source=join(dir,'source'),encrypted=join(dir,'backup.enc'),key=randomBytes(32),plain=join(dir,'plain')
    await writeFile(source,'Private synthetic content');await sealFile(source,encrypted,key)
    await unsealFile(encrypted,plain,key);expect(await readFile(plain,'utf8')).toBe('Private synthetic content')
    await expect(unsealFile(encrypted,join(dir,'wrong'),randomBytes(32))).rejects.toThrow('authentication')
    await expect(readFile(join(dir,'wrong'))).rejects.toThrow()
    await expect(unsealFile(encrypted,join(dir,'renamed'),key,'renamed.enc')).rejects.toThrow('authentication')
    const bytes=await readFile(encrypted);bytes[32]^=1;await writeFile(encrypted,bytes)
    await expect(unsealFile(encrypted,join(dir,'tampered'),key)).rejects.toThrow('authentication')
  })
  it('refuses existing restore destinations, traversal and linked file snapshots',async()=>{
    const dir=await directory();await expect(newDirectory(dir)).rejects.toThrow()
    for(const path of ['/absolute','../outside','a/../../outside','a\\..\\outside'])expect(()=>safeRelative(path)).toThrow()
    await writeFile(join(dir,'content'),'synthetic');await symlink(join(dir,'content'),join(dir,'link'))
    await expect(inventoryTree(dir)).rejects.toThrow('links')
  })
  it('requires private encryption custody and rejects free-form connection options',async()=>{
    const dir=await directory(),key=join(dir,'key'),file=join(dir,'config')
    await writeFile(key,randomBytes(32),{mode:0o600})
    const config={database:{host:'127.0.0.1',port:5432,user:'fixture',database:'fixture',password:'fictional',sslmode:'disable'},keyFile:key,keyReference:'fixture/key'}
    await writeFile(file,JSON.stringify(config),{mode:0o600});expect((await readConfig(file)).key).toHaveLength(32)
    await writeFile(file,JSON.stringify({...config,database:{...config.database,options:'-c role=admin'}}));await expect(readConfig(file)).rejects.toThrow('database')
    await writeFile(file,JSON.stringify({...config,keyReference:''}));await expect(readConfig(file)).rejects.toThrow('custody')
  })
  it('archives identical WAL idempotently and refuses differing content at an existing name',async()=>{
    const dir=await directory(),archive=join(dir,'archive'),source=join(dir,'wal');await mkdir(archive,{mode:0o700})
    const config={walArchiveDirectory:archive,key:randomBytes(32)},name='000000010000000000000001'
    await writeFile(source,'WAL fixture');await archiveWal(config,source,name);await archiveWal(config,source,name)
    await writeFile(source,'Different WAL');await expect(archiveWal(config,source,name)).rejects.toThrow('collision')
    for(const value of ['../wal','00000001.partial','wal;command'])expect(()=>walName(value)).toThrow()
  })
  it('requires a complete matching and fresh checkpoint after the backup',()=>{
    const now=Date.now(),identity={cluster:'123',database_oid:'456',database:'fixture',postgres_version:'18.3'}
    const manifest={identity,schemaHash:'schema',migrations:['522.sql'],completedAt:new Date(now-1000).toISOString()}
    const checkpoint={schema:'brian-erasure-checkpoint-v1',...manifest,capturedAt:new Date(now).toISOString(),records:[],sha256:sha('')}
    expect(()=>validateCheckpoint(checkpoint,manifest,{maxAgeSeconds:60,now})).not.toThrow()
    for(const changed of [{identity:{...identity,cluster:'other'}},{schemaHash:'other'},{sha256:'corrupt'},{capturedAt:new Date(now-2000).toISOString()}])expect(()=>validateCheckpoint({...checkpoint,...changed},manifest,{maxAgeSeconds:60,now})).toThrow()
    expect(()=>validateCheckpoint(checkpoint,manifest,{maxAgeSeconds:60,now:now+61000})).toThrow('current checkpoint')
  })
})
