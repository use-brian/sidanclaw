import {describe,it,expect,vi} from 'vitest'
import {createAssociationLifecycleWorker} from '../lifecycle-worker.js'
vi.mock('../../brain-stream/notify.js',()=>({notifyWorkspaceChange:vi.fn()}))
import {notifyWorkspaceChange} from '../../brain-stream/notify.js'
describe('[COMP:crm/association-lifecycle] Bounded reservation and drain worker',()=>{
  it('does no work while disabled and serializes concurrent ticks',async()=>{
    const orders=vi.fn(async()=>[]),drains=vi.fn(async()=>[])
    const worker=createAssociationLifecycleWorker({orders,drains,enabled:()=>false})
    const a=worker.tick(),b=worker.tick();expect(a).toBe(b);expect(await a).toBe(0)
    expect(orders).not.toHaveBeenCalled();expect(drains).not.toHaveBeenCalled()
  })
  it('continues past a full tick and independently advances the draining-workspace cursor',async()=>{
    const rows=Array.from({length:1105},(_,i)=>({id:String(i).padStart(5,'0'),workspaceId:'fixture'})),workspaces=rows.slice(0,105).map(r=>r.id)
    const orders=vi.fn(async(after:string|null,limit:number)=>rows.filter(r=>after===null||r.id>after).slice(0,limit))
    const drains=vi.fn(async(after:string|null,limit:number)=>workspaces.filter(id=>after===null||id>after).slice(0,limit))
    const expire=vi.fn(async()=>{}),finish=vi.fn(async()=>false)
    const worker=createAssociationLifecycleWorker({orders,drains,expire,finish,enabled:()=>true})
    expect(await worker.tick()).toBe(1000);expect(await worker.tick()).toBe(105)
    expect(expire).toHaveBeenCalledTimes(1105);expect(finish).toHaveBeenCalledTimes(105)
    expect(drains.mock.calls.map(([cursor])=>cursor)).toEqual([null,'00099'])
  })
  it('retries failures on a later scan, and only refreshes a committed drain completion',async()=>{
    vi.mocked(notifyWorkspaceChange).mockClear()
    const onError=vi.fn(),expire=vi.fn(async()=>{throw Error('Private provider payload')})
    const finish=vi.fn(async(id:string)=>{if(id==='one')throw Error('Private database payload');return id==='two'})
    const worker=createAssociationLifecycleWorker({enabled:()=>true,orders:async()=>[{id:'order',workspaceId:'ws'}],drains:async()=>['one','two','three'],expire,finish,onError})
    await worker.tick();await worker.tick()
    expect(expire).toHaveBeenCalledTimes(2);expect(onError.mock.calls).toEqual([[],[],[],[]])
    expect(notifyWorkspaceChange).toHaveBeenCalledTimes(2)
    expect(notifyWorkspaceChange).toHaveBeenCalledWith('two','workspace_config','update')
  })
})
