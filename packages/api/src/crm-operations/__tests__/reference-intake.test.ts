import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, chmodSync, symlinkSync } from 'node:fs'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const queueUrl = new URL('../../../../../scripts/crm/durable-intake-queue.mjs', import.meta.url).href
const backendUrl = new URL('../../../../../scripts/crm/reference-intake-backend.mjs', import.meta.url).href
const { DurableIntakeQueue, intakeOrigin } = await import(queueUrl)
const { startReferenceIntakeBackend } = await import(backendUrl)
const roots: string[] = [], queues = new Set<InstanceType<typeof DurableIntakeQueue>>(), servers: Server[] = []
const children = new Set<ChildProcess>()
const token = `sk_intake_${randomUUID()}_synthetic_fixture_secret`
const backendToken = 'synthetic_private_backend_credential_1234567890'
type Options = Record<string, unknown>
function fixture(overrides: Options = {}) {
  const root = mkdtempSync(join(tmpdir(),'crm-reference-intake-')); roots.push(root)
  const clock = { value: 1_800_000_000_000 }
  const options = { databasePath: join(root,'queue.sqlite'), apiUrl: 'http://127.0.0.1:4444', workspaceId: randomUUID(),sourceId: 'fixture_backend',
    replayHorizonMs: 86_400_000, ...overrides }
  const open = () => { const queue = new DurableIntakeQueue({ ...options,now: () => clock.value,random: () => .5 }); queues.add(queue); return queue }
  const close = (queue: InstanceType<typeof DurableIntakeQueue>) => { queue.close(); queues.delete(queue) }
  return { root,clock,options,open,close }
}
const body = { fields: { name: 'Synthetic fixture',message: 'Private fixture content' } }
const enqueue = (queue: InstanceType<typeof DurableIntakeQueue>, key='fixture_submission', visitor='fixture_visitor') =>
  queue.enqueue({ definitionKey: 'fixture_form',idempotencyKey: key,body,visitorId: visitor })
const result = (duplicate=false) => ({ submissionId: randomUUID(),contactId: randomUUID(),followUpTaskId: null,duplicate })
const accepted = () => new Response(JSON.stringify(result()),{ status: 201 })
async function upstream(handler: (req: IncomingMessage,res: ServerResponse) => void | Promise<void>) {
  const server = createServer(handler); servers.push(server)
  await new Promise<void>((done) => server.listen(0,'127.0.0.1',done))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
function worker(options: Options, now: number) {
  const code = `const {DurableIntakeQueue}=await import(process.argv[1]);
    const queue=new DurableIntakeQueue({...JSON.parse(process.argv[2]),now:()=>Number(process.argv[3])});
    try {const out=await queue.tick({getToken:()=>process.env.CRM_FIXTURE_KEY});
      process.stdout.write(JSON.stringify({processed:out.processed,state:out.receipt?.state}));} finally {queue.close();}`
  const child = spawn(process.execPath,['--input-type=module','-e',code,queueUrl,JSON.stringify(options),String(now)],{
    env: { PATH: process.env.PATH,CRM_FIXTURE_KEY: token },stdio: ['ignore','pipe','pipe'],
  })
  children.add(child)
  child.once('close',() => children.delete(child))
  let stdout='',stderr=''
  child.stdout.on('data',(chunk) => { stdout+=chunk }); child.stderr.on('data',(chunk) => { stderr+=chunk })
  const done = new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve,reject) => {
    child.once('error',reject); child.once('close',(code,signal) => resolve({ code,signal,stdout,stderr }))
  })
  return { child,done }
}
afterEach(async () => {
  await Promise.all([...children].map((child) => new Promise<void>((done) => {
    child.once('close',() => done()); child.kill('SIGKILL')
  })))
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()) })))
  for (const queue of queues) queue.close()
  queues.clear()
  for (const root of roots.splice(0)) rmSync(root,{ recursive: true,force: true })
})

describe('[COMP:crm/intake-reference] Durable backend admission and replay', () => {
  it('persists before acknowledgement, preserves the same receipt after reopening and refuses changed bytes', () => {
    const f=fixture(), queue=f.open(), first=enqueue(queue)
    expect(first.state).toBe('queued'); expect(first.attempts).toBe(0)
    f.close(queue)
    const recovered=f.open()
    expect(enqueue(recovered)).toEqual(first)
    expect(() => recovered.enqueue({ definitionKey: 'fixture_form',idempotencyKey: 'fixture_submission',body: { fields: { name: 'Changed' } },visitorId: 'fixture_visitor' }))
      .toThrow('idempotency_conflict')
    expect(recovered.getReceipt(first.id,{ includePayload: true }).payload).toEqual(body)
    expect(recovered.getReceipt(first.id)).not.toHaveProperty('payload')
    expect(statSync(f.options.databasePath).mode & 0o077).toBe(0)
  })

  it('shares visitor admission across openings and ignores duplicate retries without creating more work', () => {
    const f=fixture({ visitorLimit: 2 }),left=f.open(),right=f.open()
    const first=enqueue(left,'first','private_visitor_identifier')
    enqueue(right,'second','private_visitor_identifier')
    expect(enqueue(right,'first','private_visitor_identifier').id).toBe(first.id)
    expect(() => enqueue(left,'third','private_visitor_identifier')).toThrow('visitor_rate_limited')
    f.clock.value+=60_001
    expect(enqueue(left,'third','private_visitor_identifier').state).toBe('queued')
    expect(readFileSync(f.options.databasePath).includes(Buffer.from('private_visitor_identifier'))).toBe(false)
  })

  it('recovers a two-hour outage after restart with the frozen key/body and clears successful payloads', async () => {
    const f=fixture(),queue=f.open(),first=enqueue(queue)
    const unavailable=vi.fn(async () => { throw new Error('sensitive upstream detail must not persist') })
    const attempt=await queue.tick({ getToken: () => token,fetchImpl: unavailable })
    expect(attempt.receipt).toMatchObject({ state: 'queued',attempts: 1,uncertain: true,error: { category: 'transport_uncertain' } })
    f.close(queue); f.clock.value+=2*60*60*1000
    const recovered=f.open(), fetchImpl=vi.fn(async (_url,request) => {
      expect(request.headers['Idempotency-Key']).toBe('fixture_submission')
      expect(JSON.parse(request.body)).toEqual(body)
      return accepted()
    })
    expect((await recovered.tick({ getToken: () => token,fetchImpl })).receipt).toMatchObject({ id: first.id,state: 'delivered',attempts: 2,uncertain: false })
    expect(recovered.getReceipt(first.id,{ includePayload: true }).payload).toBeNull()
    expect(await recovered.tick({ getToken: () => token,fetchImpl })).toEqual({ processed: false })
    expect(fetchImpl).toHaveBeenCalledOnce()
    f.close(recovered)
    expect(readFileSync(f.options.databasePath).includes(Buffer.from(token))).toBe(false)
    expect(readFileSync(f.options.databasePath).includes(Buffer.from('sensitive upstream detail'))).toBe(false)
  })

  it.each([401,409,413,422])('does not automatically retry permanent HTTP %s or store provider error text', async (status) => {
    const f=fixture(),queue=f.open(),first=enqueue(queue)
    const fetchImpl=vi.fn(async () => new Response('do_not_store_provider_body',{ status }))
    expect((await queue.tick({ getToken: () => token,fetchImpl })).receipt).toMatchObject({ state: 'failed',error: { category: 'upstream_rejected',status } })
    f.clock.value+=60_000
    expect(await queue.tick({ getToken: () => token,fetchImpl })).toEqual({ processed: false })
    expect(fetchImpl).toHaveBeenCalledOnce()
    queue.retry(first.id)
    expect((await queue.tick({ getToken: () => token,fetchImpl: async () => accepted() })).receipt.state).toBe('delivered')
    f.close(queue)
    expect(readFileSync(f.options.databasePath).includes(Buffer.from('do_not_store_provider_body'))).toBe(false)
  })

  it('respects Retry-After and pauses at the approved deadline instead of extending it', async () => {
    const f=fixture({ replayHorizonMs: 90_000 }),queue=f.open(),first=enqueue(queue)
    expect((await queue.tick({ getToken: () => token,fetchImpl: async () => new Response('',{ status: 429,headers: { 'Retry-After': '60' } }) })).receipt)
      .toMatchObject({ state: 'queued',nextAttemptAt: f.clock.value+60_000 })
    f.clock.value+=59_999
    expect(await queue.tick({ getToken: () => token,fetchImpl: async () => accepted() })).toEqual({ processed: false })
    f.clock.value++
    const paused=await queue.tick({ getToken: () => token,fetchImpl: async () => new Response('',{ status: 503,headers: { 'Retry-After': '60' } }) })
    expect(paused.receipt).toMatchObject({ state: 'paused',retryUntil: first.retryUntil,error: { category: 'replay_deadline_expired' } })
    expect(() => queue.retry(first.id)).toThrow('receipt_not_retryable')
    f.clock.value+=3_600_000
    expect(await queue.tick({ getToken: () => token,fetchImpl: async () => accepted() })).toEqual({ processed: false })
  })

  it('retired replies are terminal and malformed success remains uncertain without copying response content', async () => {
    const f=fixture(),queue=f.open(),first=enqueue(queue)
    expect((await queue.tick({ getToken: () => token,fetchImpl: async () => new Response(JSON.stringify({ duplicate: true,outcome: 'submission_retired' })) })).receipt)
      .toMatchObject({ state: 'retired',result: { duplicate: true,outcome: 'submission_retired' } })
    expect(queue.getReceipt(first.id,{ includePayload: true }).payload).toBeNull()
    enqueue(queue,'malformed'); f.clock.value+=1100
    const uncertain=await queue.tick({ getToken: () => token,fetchImpl: async () => new Response('private response body') })
    expect(uncertain.receipt).toMatchObject({ state: 'queued',uncertain: true,error: { category: 'invalid_upstream_response' } })
    expect(JSON.stringify(uncertain)).not.toContain('private response body')
  })

  it('recovers an actually killed worker after remote commit without creating another remote submission', async () => {
    let announce: () => void
    const reached=new Promise<void>((done) => { announce=done })
    const remote=new Map<string,ReturnType<typeof result>>()
    const apiUrl=await upstream(async (req,res) => {
      for await (const _chunk of req) { /* consume the exact request */ }
      const key=String(req.headers['idempotency-key'])
      if (!remote.has(key)) { remote.set(key,result()); announce(); return }
      res.writeHead(200,{ 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ...remote.get(key),duplicate: true }))
    })
    const f=fixture({ apiUrl }),queue=f.open(),first=enqueue(queue),running=worker(f.options,f.clock.value)
    await reached; running.child.kill('SIGKILL')
    expect((await running.done).signal).toBe('SIGKILL')
    f.close(queue); f.clock.value+=35_001
    const recovered=f.open()
    const output=await recovered.tick({ getToken: () => `sk_intake_${randomUUID()}_rotated_fixture_secret` })
    expect(output.receipt).toMatchObject({ id: first.id,state: 'delivered',attempts: 2,result: { ...remote.get('fixture_submission'),duplicate: true } })
    expect(remote.size).toBe(1)
  },20_000)

  it('enforces one shared upstream pacing lane across actual worker processes', async () => {
    let requests=0
    const apiUrl=await upstream(async (req,res) => {
      for await (const _chunk of req) { /* consume */ }
      requests++; res.writeHead(201,{ 'Content-Type': 'application/json' }); res.end(JSON.stringify(result()))
    })
    const f=fixture({ apiUrl }),queue=f.open()
    for (let index=0;index<3;index++) enqueue(queue,`fixture_${index}`)
    const workers=Array.from({ length: 3 },() => worker(f.options,f.clock.value))
    const outputs=await Promise.all(workers.map((item) => item.done))
    outputs.forEach((item) => expect(item.code,item.stderr).toBe(0))
    expect(outputs.filter((item) => JSON.parse(item.stdout).processed)).toHaveLength(1)
    expect(requests).toBe(1)
    f.clock.value+=1100
    expect(JSON.parse((await worker(f.options,f.clock.value).done).stdout).processed).toBe(true)
    expect(requests).toBe(2)
  },20_000)

  it('does not let an in-flight completion overwrite an explicit cancellation', async () => {
    const f=fixture(),queue=f.open(),first=enqueue(queue)
    let complete!: (value: Response) => void, started!: () => void
    const entered=new Promise<void>((done) => { started=done })
    const pending=new Promise<Response>((done) => { complete=done })
    const delivery=queue.tick({ getToken: () => token,fetchImpl: () => { started(); return pending } })
    await entered
    expect(queue.cancel(first.id)).toMatchObject({ state: 'cancelled',uncertain: true })
    complete(accepted()); await delivery
    expect(queue.getReceipt(first.id,{ includePayload: true })).toMatchObject({ state: 'cancelled',uncertain: true,payload: null,result: null })
  })

  it('persists a loopback HTTP acknowledgement, requires its private bearer and ignores forwarded visitor claims', async () => {
    const f=fixture({ visitorLimit: 1 }),queue=f.open()
    const backend=await startReferenceIntakeBackend({ queue,bearerToken: backendToken,runWorker: false })
    const post=(key: string,secret=backendToken,forwarded='203.0.113.1') => fetch(`${backend.url}/submissions/fixture_form`,{
      method: 'POST',headers: { Authorization: `Bearer ${secret}`,'Content-Type': 'application/json','X-Forwarded-For': forwarded },
      body: JSON.stringify({ idempotencyKey: key,body }),
    })
    try {
      expect((await post('unauthorized','wrong')).status).toBe(401)
      const response=await post('first'); expect(response.status).toBe(202)
      const { receipt }=await response.json() as { receipt: { id: string } }
      expect(receipt).not.toHaveProperty('payload')
      expect((await post('second',backendToken,'203.0.113.2')).status).toBe(429)
      const cancel=await fetch(`${backend.url}/receipts/${receipt.id}/cancel`,{
        method: 'POST',headers: { Authorization: `Bearer ${backendToken}`,'Content-Type': 'application/json' },body: '{}',
      })
      expect(cancel.status).toBe(400)
      await backend.close(); f.close(queue)
      expect(f.open().getReceipt(receipt.id).state).toBe('queued')
    } finally { await backend.close() }
  })

  it('makes fatal worker failure observable and stops accepting more queued submissions', async () => {
    const unavailable = new Error('fixture database unavailable')
    const backend=await startReferenceIntakeBackend({
      queue: { tick: async () => { throw unavailable } },bearerToken: backendToken,
    })
    await expect(backend.failure).rejects.toBe(unavailable)
    await expect(fetch(`${backend.url}/receipts/fixture`,{ headers: { Authorization: `Bearer ${backendToken}` } })).rejects.toThrow()
    await expect(backend.close()).rejects.toBe(unavailable)
  })

  it('does not let an expired worker overwrite a newer successful lease', async () => {
    const f=fixture(),left=f.open(),right=f.open(),first=enqueue(left)
    let complete!: (value: Response) => void, started!: () => void
    const entered=new Promise<void>((done) => { started=done })
    const pending=new Promise<Response>((done) => { complete=done })
    const older=left.tick({ getToken: () => token,fetchImpl: () => { started(); return pending } })
    await entered
    f.clock.value+=35_001
    const committed=result(true)
    expect((await right.tick({ getToken: () => token,fetchImpl: async () => new Response(JSON.stringify(committed)) })).receipt)
      .toMatchObject({ id: first.id,state: 'delivered',attempts: 2,result: committed })
    complete(new Response('',{ status: 503 })); await older
    expect(right.getReceipt(first.id,{ includePayload: true })).toMatchObject({ state: 'delivered',result: committed,payload: null,uncertain: false })
  })

  it('refuses unsafe origins, foreign queue configurations, public database files and symlinks', () => {
    for (const origin of ['http://server.example','https://user:secret@server.example','https://server.example/path','https://server.example?token=secret']) {
      expect(() => intakeOrigin(origin)).toThrow()
    }
    const f=fixture(),queue=f.open(); enqueue(queue)
    expect(() => new DurableIntakeQueue({ ...f.options,workspaceId: randomUUID() })).toThrow('queue_configuration_mismatch')
    chmodSync(f.options.databasePath,0o644)
    expect(() => f.open()).toThrow('private_owner_database_required')
    chmodSync(f.options.databasePath,0o600)
    const link=join(f.root,'linked.sqlite'); symlinkSync(f.options.databasePath,link)
    expect(() => new DurableIntakeQueue({ ...f.options,databasePath: link })).toThrow('private_owner_database_required')
  })

  it('delivers 500 synthetic submissions over a simulated hour with no queue duplicates or pacing violations', async () => {
    const f=fixture(),queue=f.open(),seen=new Set<string>(),starts: number[]=[]
    const fetchImpl=vi.fn(async (_url,request) => {
      expect(seen.has(request.headers['Idempotency-Key'])).toBe(false)
      seen.add(request.headers['Idempotency-Key']); starts.push(f.clock.value); return accepted()
    })
    for (let index=0;index<500;index++) {
      const receipt=enqueue(queue,`synthetic_${index}`,`visitor_${index}`)
      expect((await queue.tick({ getToken: () => token,fetchImpl })).receipt).toMatchObject({ id: receipt.id,state: 'delivered' })
      expect(enqueue(queue,`synthetic_${index}`,`visitor_${index}`).id).toBe(receipt.id)
      f.clock.value+=7200
    }
    expect(seen.size).toBe(500)
    expect(starts.every((time,index) => index===0 || time-starts[index-1]>=1100)).toBe(true)
    expect(await queue.tick({ getToken: () => token,fetchImpl })).toEqual({ processed: false })
  },20_000)
})
