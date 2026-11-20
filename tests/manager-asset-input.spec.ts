import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { addAssetInput } from '../src/app/asset-inputs.ts'
import { AssetCatalog } from '../src/app/asset-catalog.ts'
import { Store } from '../src/app/store.ts'
import { Engine, parseSettings, settingsPolicy, type Executor, type Mandate, type Ticket } from '../src/core/index.ts'
import { tempDir } from './helpers/temp.ts'

class E implements Executor { prepare(t: Ticket, _m: Mandate): Ticket { return t } start() {} deliver() {} stop() {} }
const at = '2026-01-01T00:00:00.000Z'
const input = (ref: {id:string;revision:number;contentHash:string}, requestId='manager-1') => ({ requestId, text:'use this', assetRefs:[ref] })

const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

function fixture() {
  const stateDir = tempDir('manager-asset-input-')
  const store = new Store(':memory:')
  stores.push(store)
  const engine = new Engine({ repos:store, tx:store, inputConsumptions:store.inputConsumptions,
    policy: () => settingsPolicy(parseSettings({ acceptMode:'auto', allowedSenders:['operator'] })), executor:new E(), delivery:{report(){}}, now:()=>at })
  const catalog = new AssetCatalog(store, stateDir)
  const conversation = (id:string, profileId='default', changes:Record<string,unknown>={}) => store.conversations.save({id,profileId,createdAt:at,lastMessageAt:at,...changes})
  const asset = (id='asset', content='fixed') => {
    const contentHash = createHash('sha256').update(content).digest('hex')
    store.assets.save({id,name:id,kind:'document',status:'active',ownerProfileId:'default',content,contentHash,revision:1,
      source:{type:'operator-import',actor:'operator'},createdAt:at,updatedAt:at} as any)
    return {id,revision:1,contentHash}
  }
  const task = (id:string, conversationId?:string) => {
    const ticketId = engine.createTicket({title:id,text:'work'}).ticketId!
    if (conversationId !== undefined) store.tickets.save({...engine.require(ticketId),conversationId})
    return ticketId
  }
  return {store,engine,catalog,conversation,asset,task,host:{store,engine,assets:catalog}}
}

describe('manager fixed-asset task input', () => {
  it('requires the exact server conversation and a live default conversation', async () => {
    const f=fixture(), ref=f.asset(), id=f.task('owned','chat-a')
    f.conversation('chat-a'); f.conversation('chat-b'); f.conversation('foreign','other')
    await expect(addAssetInput(f.host,id,input(ref),{conversationId:'chat-b'})).rejects.toThrow(/not owned/)
    for (const conversationId of ['foreign', 'missing']) {
      const unavailable = f.task('unavailable conversation', conversationId)
      await expect(addAssetInput(f.host,unavailable,input(ref),{conversationId})).rejects.toMatchObject({status:403})
      expect(f.engine.require(unavailable).inputs).toHaveLength(0)
    }
    await expect(addAssetInput(f.host,id,{...input(ref),assetRefs:[{...ref,revision:2}]},{conversationId:'chat-a'})).rejects.toMatchObject({status:409})
    expect(f.engine.require(id).inputs).toHaveLength(0)
    expect((await addAssetInput(f.host,id,input(ref),{conversationId:'chat-a'})).deliveryState).toBe('queued')
    f.conversation('archived', 'default', {archivedAt:at})
    const archived=f.task('archived-task','archived')
    await expect(addAssetInput(f.host,archived,input(ref),{conversationId:'archived'})).rejects.toThrow(/Task access denied/)
  })

  it('rejects legacy missing ownership for manager but preserves operator compatibility', async () => {
    const f=fixture(), ref=f.asset(), id=f.task('legacy')
    await expect(addAssetInput(f.host,id,input(ref),{conversationId:'current-chat'})).rejects.toThrow(/not owned/)
    expect((await addAssetInput(f.host,id,input(ref))).deliveryState).toBe('queued')
  })

  it('returns exact replay, conflicts on changed payload, and rechecks ownership after async bytes', async () => {
    const f=fixture(), ref=f.asset(), id=f.task('replay','chat')
    f.conversation('chat')
    const payload=input(ref)
    const [first,replay]=await Promise.all([
      addAssetInput(f.host,id,payload,{conversationId:'chat'}),
      addAssetInput(f.host,id,payload,{conversationId:'chat'}),
    ])
    expect(replay).toEqual(first)
    await expect(addAssetInput(f.host,id,{...payload,text:'changed'},{conversationId:'chat'})).rejects.toThrow(/conflict/)
    expect(f.engine.require(id).inputs.filter(i=>i.kind==='note'&&i.requestId==='manager-1')).toHaveLength(1)

    const other=f.task('race','chat'), original=f.catalog.resolveBytes.bind(f.catalog)
    f.catalog.resolveBytes=async value=>{const result=await original(value);f.store.tickets.save({...f.engine.require(other),conversationId:'other'});return result}
    await expect(addAssetInput(f.host,other,input(ref,'race-request'),{conversationId:'chat'})).rejects.toThrow(/not owned/)
    expect(f.engine.require(other).inputs).toHaveLength(0)
  })

  it('rechecks pinned asset state before commit after asynchronous resolution', async () => {
    const f=fixture(), ref=f.asset(), id=f.task('asset-race','chat')
    f.conversation('chat')
    const original=f.catalog.resolveBytes.bind(f.catalog)
    f.catalog.resolveBytes=async value=>{const result=await original(value);f.store.assets.save({...f.store.assets.get(ref.id)!,archived:true} as any);return result}
    await expect(addAssetInput(f.host,id,input(ref,'stale-request'),{conversationId:'chat'})).rejects.toThrow(/unavailable/)
    expect(f.engine.require(id).inputs).toHaveLength(0)
  })
})
