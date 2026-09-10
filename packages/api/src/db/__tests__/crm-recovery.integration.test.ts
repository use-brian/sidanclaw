import {randomUUID,randomBytes} from 'node:crypto'
import {mkdtemp,writeFile,rm,mkdir,readFile} from 'node:fs/promises'
import {setTimeout} from 'node:timers/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {execFileSync} from 'node:child_process'
import pg from 'pg'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {type CrmOperationsContext,CrmOperationsCommandSchema} from '@use-brian/core'
import {getPool,getAppPool} from '../client.js'
import {createCrmOperationsService} from '../../crm-operations/service.js'
import {createDbCrmOperationsStore} from '../crm-operations-store.js'
import {createAssociationStore} from '../association-store.js'
import {createWorkspaceModulesStore} from '../workspace-modules-store.js'
import {createSoftDeleteStore} from '../soft-delete-store.js'
import {EventInputSchema,TicketInputSchema,OrderCreateSchema} from '../../association/domain.js'
import {_resetCoalescerForTests} from '../../brain-stream/notify.js'
const scripts=new URL('../../../../../scripts/',import.meta.url)
const {assertLocalFixture,runCommand,cleanRuntimeEnvironment}=await import(new URL('crm/local-fixture.mjs',scripts).href)
await assertLocalFixture()
const {backup}=await import(new URL('operations/brian-backup.mjs',scripts).href)
const {restoreCheck}=await import(new URL('operations/brian-restore-check.mjs',scripts).href)
const pool=getPool(),appPool=getAppPool(),ops=createCrmOperationsService(createDbCrmOperationsStore())
const directories:string[]=[]
describe('[COMP:operations/crm-recovery] Actual encrypted logical restore',()=>{
  afterEach(async context=>{if(context.task.result?.state==='fail')for(const dir of directories){const log=await readFile(join(dir,'restore','postgres.log'),'utf8').catch(()=>null);if(log)console.error(log)}})
  afterAll(async()=>{delete process.env.CRM_SUPPRESSION_HMAC_KEYRING;_resetCoalescerForTests();await pool.end();await appPool.end();for(const dir of directories)await rm(dir,{recursive:true,force:true})})
  it('proves content, restores files and replays a post-backup erasure before canonical application checks',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'crm-recovery-proof-'));directories.push(dir)
    const fileRoot=join(dir,'file-snapshot');await mkdir(fileRoot);await writeFile(join(fileRoot,'fixture.txt'),'Immutable synthetic configuration')
    process.env.CRM_SUPPRESSION_HMAC_KEYRING=JSON.stringify({activeVersion:'fixture',keys:{fixture:Buffer.alloc(32,23).toString('base64')}})
    const key=randomBytes(32),keyFile=join(dir,'key');await writeFile(keyFile,key,{mode:0o600})
    const source=new URL(process.env.DATABASE_URL!),config={pgBin:execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim(),
      database:{host:source.hostname,port:Number(source.port),user:source.username,password:source.password,database:source.pathname.slice(1),sslmode:'disable'},
      key,keyFile,keyReference:'fixture/recovery-key',protectedKeyReferences:['fixture/suppression'],
      applicationSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),applicationDirty:true,
      proofTables:['entities','association_memberships','association_orders','association_ticket_types','crm_intake_idempotency'],
      quiescedSnapshot:true,fileRoots:[{label:'configuration',kind:'config',path:fileRoot}],journalMaxAgeSeconds:600}
    const workspaceId=randomUUID(),userId=randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Recovery workflow',$2)",[workspaceId,userId])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,userId])
    const context:CrmOperationsContext={workspaceId,actor:{kind:'user',userId},authority:{role:'owner',canConfigure:true,canWrite:true,trustedIdentitySources:[]}}
    await ops.execute(context,{kind:'save_privacy_policy',expectedVersion:0,confirmed:true,intakeReplay:{retentionSeconds:3600},addressSuppression:{retentionSeconds:3600}})
    await ops.execute(context,CrmOperationsCommandSchema.parse({kind:'save_consent_purpose',purposeKey:'updates',label:'Updates',wordingVersion:'1',wording:'Synthetic updates consent',applicableChannels:['email']}))
    await ops.execute(context,CrmOperationsCommandSchema.parse({kind:'save_intake_definition',definitionKey:'recovery',label:'Recovery',definition:{identityPolicy:'new_or_review',fields:[
      {key:'name',label:'Name',type:'text',required:true,mapping:{kind:'base_field',field:'name'}},
      {key:'email',label:'Email',type:'email',required:true,mapping:{kind:'base_field',field:'email'}},
    ],consentMappings:[]}}))
    const command=CrmOperationsCommandSchema.parse({kind:'record_submission',definitionKey:'recovery',idempotencyKey:'recovery-survivor',fields:{name:'Fictional survivor',email:'survivor@example.com'}})
    const accepted=await ops.execute(context,command),contactId=String(accepted.record.contactId)
    const erased=await ops.execute(context,CrmOperationsCommandSchema.parse({...command,idempotencyKey:'recovery-erased',fields:{name:'Fictional erased person',email:'erased@example.com'}}))
    const erasedId=String(erased.record.contactId)
    await ops.execute(context,{kind:'record_consent',contactId,purposeKey:'updates',action:'granted',source:'fixture',metadata:{}})
    await ops.execute(context,{kind:'record_consent',contactId:erasedId,purposeKey:'updates',action:'withdrawn',source:'fixture',metadata:{}})
    const plan=await ops.execute(context,CrmOperationsCommandSchema.parse({kind:'save_entitlement_plan',key:'recovery',name:'Recovery',feeMinor:0,currency:'USD',billingPeriod:'annual'}))
    await ops.execute(context,{kind:'grant_entitlement',contactId,planId:String(plan.record.id),idempotencyKey:'recovery-membership',status:'active',startsAt:'2000-01-01T00:00:00Z',endsAt:'2099-01-01T00:00:00Z',renewalMode:'none'})
    const commerce=createAssociationStore(),actor={credentialKind:'user' as const,credentialId:userId,actingUserId:userId}
    await createWorkspaceModulesStore().act(workspaceId,userId,{action:'enable',expectedVersion:1})
    const event=await commerce.upsertEvent(workspaceId,EventInputSchema.parse({slug:'recovery',title:'Recovery',startsAt:'2099-01-01T12:00:00Z',endsAt:'2099-01-01T14:00:00Z',timezone:'UTC',mode:'venue',status:'published',capacity:2}),actor)
    const eventId=String(event.record.id),ticket=await commerce.upsertTicket(workspaceId,eventId,TicketInputSchema.parse({key:'standard',name:'Standard',priceMinor:0,currency:'USD',status:'on_sale',capacity:2}),actor)
    const order=await commerce.createOrder(workspaceId,OrderCreateSchema.parse({contactId,idempotencyKey:'recovery-order',lines:[{ticketId:ticket.record.id,quantity:1,attendees:[{contactId,name:'Fictional survivor'}]}]}),actor)
    await commerce.confirmFreeOrder(workspaceId,String(order.record.id),actor)
    expect((await backup({config})).action).toBe('preflight')
    const backupDir=join(dir,'backup');await backup({config,destination:backupDir,execute:true})
    const soft=createSoftDeleteStore(),snapshot=await soft.readForSoftDelete('contact',workspaceId,erasedId)
    await soft.applyHardPurge({primitive:'contact',workspaceId,rowId:erasedId,actorUserId:userId,reason:'Synthetic recovery exercise',ticketReference:null,snapshot:snapshot!,now:new Date()})
    const journalDir=join(dir,'checkpoint');await backup({config,mode:'journal',destination:journalDir,execute:true})
    const report=await restoreCheck({config,backupDirectory:backupDir,journalFile:join(journalDir,'journal.enc'),destination:join(dir,'restore'),execute:true,
      verifyApplication:async({connection,client,root}:any)=>{
        const restored=new pg.Pool(connection)
        try {
          expect((await client.query('SELECT id FROM entities WHERE id=$1',[erasedId])).rows).toEqual([])
          const store=createDbCrmOperationsStore(restored),service=createCrmOperationsService(store),association=createAssociationStore(restored)
          expect(await store.transaction(context,tx=>tx.findContactByEmail('survivor@example.com'))).toBe(contactId)
          expect(await store.transaction(context,tx=>tx.findContactByEmail('erased@example.com'))).toBeNull()
          expect(await service.execute(context,command)).toMatchObject({duplicate:true,record:{contactId}})
          expect(await association.listMemberships(workspaceId,contactId,{activeOnly:true})).toMatchObject([{isEffective:true}])
          expect(await association.getOrder(workspaceId,String(order.record.id))).toMatchObject({status:'paid'})
          expect(await association.listTickets(workspaceId,eventId)).toMatchObject([{reservedCount:1,available:1}])
          const {readFile}=await import('node:fs/promises')
          expect(await readFile(join(root,'files','configuration','fixture.txt'),'utf8')).toBe('Immutable synthetic configuration')
          await writeFile(join(root,'proof-context.json'),JSON.stringify({workspaceId,contactId}),{mode:0o600})
          const url=new URL('postgresql://127.0.0.1');url.port=String(connection.port);url.username=connection.user;url.password=connection.password;url.pathname='/'+connection.database
          await runCommand(process.execPath,['--import','tsx','scripts/operations/recovery-app-proof.ts'],{env:{...cleanRuntimeEnvironment(process.env),DATABASE_URL:url.href,BRIAN_RECOVERY_PROOF_ROOT:root,CRM_SUPPRESSION_HMAC_KEYRING:process.env.CRM_SUPPRESSION_HMAC_KEYRING}})
          return {status:'passed',assertions:['contact_lookup','intake_committed_replay','effective_membership','inventory_read','order_read','file_hash','post_backup_erasure','restored_sendability','restored_address_suppression']}
        }finally{await restored.end()}
      }})
    expect(report).toMatchObject({status:'passed',sendingStarted:false,journal:{status:'passed',applied:expect.any(Number)},application:{status:'passed'}})
    expect(report.journal.applied).toBeGreaterThan(0)
    if(process.env.BRIAN_ASSURANCE_REPORT_DIR)await writeFile(join(process.env.BRIAN_ASSURANCE_REPORT_DIR,'logical-restore.json'),JSON.stringify(report,null,2),{mode:0o600})
  },120000)
  it('recovers a physical base backup with archived WAL to the requested point before a later commit',async()=>{
    if(!process.env.BRIAN_ASSURANCE_WAL_CONFIG)throw new Error('Use --wal-archive-fixture for physical recovery evidence')
    const dir=await mkdtemp(join(tmpdir(),'crm-pitr-proof-'));directories.push(dir)
    const wal=JSON.parse(await readFile(process.env.BRIAN_ASSURANCE_WAL_CONFIG,'utf8'))
    const source=new URL(process.env.DATABASE_URL!),config={...wal,key:await readFile(wal.keyFile),
      pgBin:execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim(),
      database:{host:source.hostname,port:Number(source.port),user:source.username,password:source.password,database:source.pathname.slice(1),sslmode:'disable'},
      applicationSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),applicationDirty:true,
      protectedKeyReferences:['disposable-fixture/wal'],proofTables:['entities'],quiescedSnapshot:true,fileRoots:[],journalMaxAgeSeconds:600}
    async function archiveThroughCurrent() {
      const name=(await pool.query('SELECT pg_walfile_name(pg_current_wal_lsn()) name')).rows[0].name
      await pool.query('SELECT pg_switch_wal()')
      const deadline=Date.now()+30000
      while(Date.now()<deadline){try{await readFile(join(wal.walArchiveDirectory,name+'.enc'));return}catch{}await setTimeout(100)}
      throw new Error('Fixture WAL archive did not become durable')
    }
    await archiveThroughCurrent()
    const backupDir=join(dir,'physical');await backup({config,mode:'physical',destination:backupDir,execute:true})
    const recoveryTargetTime=(await pool.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') value")).rows[0].value
    const later=randomUUID();await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[later])
    await archiveThroughCurrent()
    const journalDir=join(dir,'checkpoint');await backup({config,mode:'journal',destination:journalDir,execute:true})
    const report=await restoreCheck({config:{...config,recoveryTargetTime},backupDirectory:backupDir,journalFile:join(journalDir,'journal.enc'),destination:join(dir,'restore'),execute:true,
      verifyApplication:async({client}:any)=>{
        expect((await client.query('SELECT id FROM users WHERE id=$1',[later])).rows).toEqual([])
        expect((await client.query('SELECT pg_is_in_recovery() active')).rows[0].active).toBe(false)
        return {status:'passed',assertions:['physical_base_backup','continuous_archived_wal','requested_time_reached','later_commit_excluded']}
      }})
    expect(report).toMatchObject({status:'passed',mode:'physical',sendingStarted:false})
    if(process.env.BRIAN_ASSURANCE_REPORT_DIR)await writeFile(join(process.env.BRIAN_ASSURANCE_REPORT_DIR,'physical-restore.json'),JSON.stringify(report,null,2),{mode:0o600})
  },120000)
})
