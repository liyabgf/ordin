import { describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { tempDir } from './helpers/temp.ts'
import { join } from 'node:path'
import { Engine, Memory, parseSettings, settingsPolicy, type AssetRef, type Delivery, type Executor, type Mandate, type Ticket } from '../src/core/index.ts'

class E implements Executor { prepare(t: Ticket, _m: Mandate): Ticket { return t } start() {} deliver() {} stop() {} }
class D implements Delivery { report() {} }
const ref = (id='a'): AssetRef => ({ id, revision: 1, contentHash: 'a'.repeat(64) })
function h() { const repos = new Memory(); const ex = new E(); const engine = new Engine({ repos, tx: repos, inputConsumptions: repos.inputConsumptions, policy: () => settingsPolicy(parseSettings({ acceptMode: 'auto', allowedSenders: ['operator'] })), executor: ex, delivery: new D(), now: () => '2026-01-01T00:00:00.000Z' }); return { engine, repos } }
function ticket(engine: Engine) { return engine.createTicket({ title: 'asset', text: 'work' }).ticketId! }
describe('asset input core contract', () => {
  it('replays idempotently after SQLite reopen and rejects changed refs', () => {
    const path = join(tempDir('asset-input-core-'), 'state.db')
    const make = (store: Store) => new Engine({ repos: store, tx: store, inputConsumptions: store.inputConsumptions, policy: () => settingsPolicy(parseSettings({ acceptMode: 'auto', allowedSenders: ['operator'] })), executor: new E(), delivery: new D() })
    let store = new Store(path), engine = make(store)
    const id = ticket(engine); engine.assetNote(id, 'restart', [ref()], 'fixed'); store.close()
    store = new Store(path); engine = make(store)
    try { expect(engine.assetNote(id, 'restart', [ref()], 'fixed').inputs).toHaveLength(1); expect(() => engine.assetNote(id, 'restart', [{ ...ref(), revision: 2 }], 'fixed')).toThrow(/conflict/) } finally { store.close() }
  })
  it('rejects recovery and deleted tickets without mutation', () => {
    const { engine, repos } = h(); const id = ticket(engine), before = engine.require(id)
    repos.tickets.save({ ...before, recovery: { state: 'uncertain', assignmentId: before.assignments[0]!.id, at: before.createdAt, reason: 'lost' } })
    expect(() => engine.assetNote(id, 'recovery', [ref()], 'x')).toThrow()
    repos.tickets.save({ ...before, deleted: { at: before.createdAt, assets: 'keep' } })
    expect(() => engine.assetNote(id, 'deleted', [ref()], 'x')).toThrow()
  })
  it('persists fixed refs and exact duplicate is idempotent', () => { const { engine } = h(); const id=ticket(engine); const first=engine.assetNote(id,'req-1',[ref()], 'look'); const again=engine.assetNote(id,'req-1',[ref()], 'look'); expect(again).toEqual(first); expect(again.inputs).toHaveLength(1); expect(again.assetRefs).toBeUndefined() })
  it('rejects mismatch, invalid request ids and invalid ref count', () => { const { engine }=h(); const id=ticket(engine); engine.assetNote(id,'req-1',[ref()], 'look'); expect(() => engine.assetNote(id,'req-1',[ref()], 'other')).toThrow(/conflict/); expect(() => engine.assetNote(id,'bad id',[ref()], 'x')).toThrow(/requestId/); expect(() => engine.assetNote(id,'req-2',[], 'x')).toThrow(/1 to 16/) })
  it('rejects ended and recovery tickets while preserving committed duplicate after end', () => { const { engine }=h(); const id=ticket(engine); const saved=engine.assetNote(id,'req-1',[ref()], 'look'); engine.stopTicket(id); expect(() => engine.assetNote(id,'req-2',[ref()], 'later')).toThrow(); expect(engine.assetNote(id,'req-1',[ref()], 'look').inputs).toEqual(saved.inputs) })
})
