import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { HealthBoard } from '../src/app/health.ts'
import { tempDir } from './helpers/temp.ts'

describe('durable terminal effect receipts', () => {
  it('keeps owed text after terminal commit, reopens, and retries only a throwing trace hook', async () => {
    const path = join(tempDir('ordin-terminal-'), 'state.sqlite3')
    let store = new Store(path)
    const health = new HealthBoard()
    let external = 0
    let traces = 0
    const owed = 'recoverable owed text\n' + '完整'.repeat(1000)
    const effects = new Effects(store, { tries: 1, health: health.entry('effects') })
    effects.handle('send', () => { external++; throw new Error('token=PRIVATE https://secret.invalid/PRIVATE') })
    effects.registerPermanentFailureHandler('send', () => { traces++; throw new Error('trace failed') })
    effects.enqueue('send', 'owed', { text: owed })
    await effects.runDue()
    expect(external).toBe(1)
    expect(traces).toBe(1)
    expect(store.effectCounts()).toEqual({})
    const [receipt] = store.listTerminalReceipts()
    expect(receipt?.payload).toEqual({ text: owed })
    expect(receipt?.error).not.toContain('PRIVATE')
    expect(health.snapshot().effects?.ok).toBe(false)
    effects.dispose(); store.close()
    store = new Store(path)
    const replay = new Effects(store)
    replay.handle('send', () => { external++ })
    replay.registerPermanentFailureHandler('send', (_payload, _error, current) => {
      expect(current.id).toBe(receipt!.id); traces++; throw new Error('still failed')
    })
    await replay.runDue()
    expect(store.getTerminalReceipt(receipt!.id)?.payload).toEqual({ text: owed })
    expect(external).toBe(1)
    replay.dispose(); store.close()
    store = new Store(path)
    const recovered = new Effects(store)
    recovered.handle('send', () => { external++ })
    recovered.registerPermanentFailureHandler('send', payload => { expect(payload).toEqual({ text: owed }); traces++ })
    await recovered.runDue(); await recovered.runDue()
    expect(store.listTerminalReceipts()).toEqual([])
    expect(traces).toBe(3)
    expect(external).toBe(1)
    recovered.dispose(); store.close()
  })

  it('persists the queue-to-receipt transition before any hook and rejects stale generations atomically', async () => {
    const path = join(tempDir('ordin-terminal-cas-'), 'state.sqlite3')
    let store = new Store(path)
    store.enqueueEffect('send', 'same', { text: 'old' })
    const [old] = store.claimEffects('send', 1)
    store.enqueueEffect('send', 'same', { text: 'new' })
    expect(store.settleClaimedEffectWithReceipt(old!, new Error('stale'))).toBeUndefined()
    expect(store.listTerminalReceipts()).toEqual([])
    const [current] = store.claimEffects('send', 1)
    const receipt = store.settleClaimedEffectWithReceipt(current!, new Error('terminal'))!
    store.close()
    store = new Store(path)
    expect(store.effectCounts()).toEqual({})
    expect(store.getTerminalReceipt(receipt.id)?.payload).toEqual({ text: 'new' })
    let sends = 0
    const effects = new Effects(store)
    effects.handle('send', () => { sends++ })
    effects.registerPermanentFailureHandler('send', payload => { expect(payload).toEqual({ text: 'new' }) })
    await effects.runDue()
    expect(sends).toBe(0)
    expect(store.listTerminalReceipts()).toEqual([])
    effects.dispose(); store.close()
  })

  it('rolls back both receipt and deletion if persistence fails and leaves success unchanged', async () => {
    const store = new Store(join(tempDir('ordin-terminal-rollback-'), 'state.sqlite3'))
    store.enqueueEffect('send', 'same', { text: 'owed' })
    const [row] = store.claimEffects('send', 1)
    const set = store.set.bind(store)
    store.set = () => { throw new Error('disk full') }
    expect(() => store.settleClaimedEffectWithReceipt(row!, new Error('failed'))).toThrow('disk full')
    store.set = set
    expect(store.pendingEffects('send', 'same')).toBe(true)
    expect(store.listTerminalReceipts()).toEqual([])
    store.releaseRunning()
    const effects = new Effects(store)
    effects.handle('send', () => {})
    await effects.runDue()
    expect(store.effectCounts()).toEqual({})
    expect(store.listTerminalReceipts()).toEqual([])
    effects.dispose(); store.close()
  })
})
