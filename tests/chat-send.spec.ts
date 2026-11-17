/**
 * The way back: a Report returning to the platform that asked, and what is left when it cannot.
 *
 * 迁入自 ordin tests/chat-send.spec.ts（P2-T7），从整机 deployment 降到组件级：真实 Store + 真实 Effects +
 * fake TwoWaySource + fake DeskPort + fake 写盘之外的全部 I/O；禁止真实平台。原文件里经由 Runtime 的接线用例
 * （registry 挂载 chat、replyToRequester 工具、watchdogHost 只升一次）在 runtime 成形前没有落点，未覆盖项见汇报。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OutcomeDelivery, sendKey, UNDELIVERED_FILE, type DeskPort, type SendPayload } from '../src/app/delivery.ts'
import { Effects } from '../src/app/effects.ts'
import { HealthBoard } from '../src/app/health.ts'
import { silentLogger } from '../src/app/logger.ts'
import { ProcessRegistry } from '../src/app/process.ts'
import { Store } from '../src/app/store.ts'
import {
  Engine, key, parseSettings, settingsPolicy, UserError,
  type Assignment, type Executor, type Mandate, type ReplyTo, type Ticket, type Trigger,
} from '../src/core/index.ts'
import { ChatSource } from '../src/sources/chat.ts'
import type { DeliverOptions, Source, SourceHost } from '../src/sources/kind.ts'
import { tempDir } from './helpers/temp.ts'

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** A two-way chat Source that records what it was handed, or refuses with the error the test armed. */
class FakeChatSource implements Source {
  readonly id = 'chat'
  readonly kind = 'chat' as const
  refuse: Error | undefined
  readonly deliveries: { replyTo: ReplyTo; text: string; options?: DeliverOptions }[] = []
  start(): void {}
  stop(): void {}
  status(): { ok: boolean } { return { ok: true } }
  async deliver(replyTo: ReplyTo, text: string, options?: DeliverOptions): Promise<void> {
    if (this.refuse !== undefined) throw this.refuse
    this.deliveries.push({ replyTo, text, options })
  }
}

interface Rig {
  readonly store: Store
  readonly effects: Effects
  readonly health: HealthBoard
  readonly notices: string[]
  readonly relays: string[]
  readonly chat: FakeChatSource
  readonly lost: { readonly ticketId: string; readonly detail: Record<string, unknown> }[]
  readonly delivery: OutcomeDelivery
  live(over?: { readonly replyTo?: ReplyTo; readonly title?: string }): Ticket
  runDue(): Promise<void>
}

/**
 * A Delivery over a real Store and a real effects queue, the source registry and the desk faked.
 *
 * The queue is real because the facts under test are the queue's own: the row that stays pending, the failure count
 * on it, and the give-up that turns into a file. A recording stub could not show any of those.
 */
function rig(over: { tries?: number; source?: (kind: string) => Source | undefined } = {}): Rig {
  const directory = tempDir('ordin-chat-send-')
  const store = new Store(join(directory, 'send.sqlite3'))
  const health = new HealthBoard()
  const chat = new FakeChatSource()
  const notices: string[] = []
  const relays: string[] = []
  const desk: DeskPort = {
    notify: async (text: string) => { notices.push(text) },
    relay: async (_requestId: string, text: string) => { relays.push(text) },
  }
  const lost: { ticketId: string; detail: Record<string, unknown> }[] = []
  let delivery!: OutcomeDelivery
  const effects = new Effects(store, {
    tries: over.tries ?? 5, retryIntervalMs: 1, health: health.entry('effects'),
    onPermanentFailure: (kind, _key, payload, error, receipt) => {
      // The runtime's own wiring: a give-up on `send` is Delivery's to record (A4: one kind, loudly dispatched).
      if (kind === 'send') return // Delivery registers its durable receipt hook.
    },
  })
  delivery = new OutcomeDelivery({
    logger: silentLogger(), store, effects, desk, health, lifetime: new AbortController().signal,
    proc: new ProcessRegistry(),
    settings: () => store.settings(), panelPath: () => '',
    source: over.source ?? (() => chat),
    replyLost: (ticketId, detail) => { lost.push({ ticketId, detail }) },
    // 【G-3 站点 2】镜像生产的写路径：测试断的是盘上的文件。
    writeResultFile: async (dir: string, name: string, text: string) => { await writeFile(join(dir, name), text, 'utf8') },
  }, null)

  let sequence = 0
  const live = (extra: { replyTo?: ReplyTo; title?: string } = {}): Ticket => {
    sequence += 1
    const id = `ticket-${sequence}`
    const at = `2026-11-0${(sequence % 9) + 1}T10:00:00.000Z`
    const replyTo = 'replyTo' in extra ? extra.replyTo : { kind: 'chat' as const, channel: 'ops', thread: 't-9' }
    store.triggers.save({
      trigger: {
        id: `trigger-${id}`, source: 'chat', kind: 'chat', at, actor: { id: 'alice', kind: 'person' },
        text: 'Sort out this week\'s alerts.', title: extra.title ?? 'weekly alerts',
        ...(replyTo === undefined ? {} : { replyTo }),
      },
      disposition: { state: 'accepted', ticketId: id, decisionId: `decision-${id}` },
    })
    const work = join(tempDir(`ordin-send-dir-${id}-`), 'work')
    mkdirSync(work, { recursive: true })
    const row: Ticket = {
      id, title: extra.title ?? 'weekly alerts', createdAt: at,
      mandate: {
        policyVersion: 'abc123', scope: 'Work in this Ticket\'s own directory.', strength: 'explicit',
        sender: { id: 'alice', kind: 'person' }, via: 'chat', at,
      },
      origin: { triggerId: `trigger-${id}` }, attachments: [],
      assignments: [{ id: `assignment-${id}`, state: 'running', createdAt: at }],
      notes: [], inputs: [], execution: { name: 'alerts', directory: work },
    }
    store.tickets.save(row)
    return row
  }

  return { store, effects, health, notices, relays, chat, lost, delivery, live, runDue: () => effects.runDue() }
}

/** The address the Source wrote onto this Ticket's Trigger, read from the store rather than assumed. */
function replyToOf(rig: Rig, ticket: Ticket): ReplyTo {
  const replyTo = rig.store.triggers.get(ticket.origin.triggerId)?.trigger.replyTo
  expect(replyTo).toBeDefined()
  return replyTo!
}

describe('chat durable reply file contract', () => {
  it('atomically replaces a reply and keeps distinct ticket/file metadata identities separate', async () => {
    const directory = tempDir('ordin-chat-out-')
    const settings = parseSettings({ sources: { chat: { channels: [{ id: 'ops', directory, enabled: true }] } } })
    const source = new ChatSource({ settings: () => settings } as SourceHost)
    const address: ReplyTo = { kind: 'chat', channel: 'ops', thread: 't-9' }
    await source.deliver(address, 'same text', { ticketId: 'ticket-a', files: ['/a.txt'] })
    await source.deliver(address, 'same text', { ticketId: 'ticket-b', files: ['/b.txt'] })
    const out = join(directory, 'out')
    expect(readdirSync(out).filter(name => name.endsWith('.md'))).toHaveLength(2)
    await source.deliver(address, 'same text', { ticketId: 'ticket-a', files: ['/a.txt'] })
    expect(readdirSync(out)).toHaveLength(2)
    const contents = readdirSync(out).map(name => readFileSync(join(out, name), 'utf8'))
    expect(contents.some(text => text.includes('ticket: ticket-a') && text.includes('/a.txt'))).toBe(true)
    expect(contents.some(text => text.includes('ticket: ticket-b') && text.includes('/b.txt'))).toBe(true)

    expect(readdirSync(out).some(name => name.startsWith('.tmp-'))).toBe(false)
  })
})

describe('terminal reply receipt replay', () => {
  it('deduplicates trace and identical file when hook succeeds before receipt acknowledgement', async () => {
    const h = rig({ tries: 1 })
    const ticket = h.live()
    h.chat.refuse = new Error('offline')
    const ack = h.store.ackTerminalReceipt.bind(h.store)
    h.store.ackTerminalReceipt = () => { throw new Error('crash before ack') }
    h.delivery.send(ticket, 'owed verbatim')
    await h.runDue()
    const path = join(ticket.execution!.directory, UNDELIVERED_FILE)
    const before = readFileSync(path, 'utf8')
    expect(h.lost).toHaveLength(1)
    expect(h.store.listTerminalReceipts()).toHaveLength(1)
    h.store.ackTerminalReceipt = ack
    await h.runDue()
    expect(h.lost).toHaveLength(1)
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(h.store.listTerminalReceipts()).toEqual([])
    expect(h.chat.deliveries).toEqual([])
    h.effects.dispose(); h.store.close()
  })
})

describe('a reply that goes out', () => {
  it('hands the Source the address from the Trigger and the worker\'s own words, and consumes the effect', async () => {
    const harness = rig()
    const ticket = harness.live()
    harness.delivery.send(ticket, 'Three of the four were duplicates.')
    await harness.runDue()

    // The queue drained: one reply, nothing left pending.
    expect(harness.store.effectCounts()).toEqual({})
    expect(harness.chat.deliveries).toHaveLength(1)
    const reply = harness.chat.deliveries[0]!
    // The address came off the Trigger, not the actor: an actor id says who asked, nothing about where to answer.
    expect(reply.replyTo).toEqual(replyToOf(harness, ticket))
    expect(reply.text).toBe('Three of the four were duplicates.')
    expect(reply.options).toMatchObject({ ticketId: ticket.id })
    // One reply queued, and nothing counted as having nowhere to go: this Ticket has an address.
    expect(harness.delivery.sends()).toEqual({ queued: 1, nowhere: 0 })
  })

  it('brings a blocked question back to the channel, without instructions only the front desk could follow', async () => {
    const harness = rig()
    const ticket = harness.live()
    harness.delivery.report(ticket, {
      state: 'blocked', summary: 'Two ways to sort this.', question: 'By company or by product?',
      at: '2026-11-02T11:00:00.000Z',
    })
    await harness.runDue()

    expect(harness.chat.deliveries).toHaveLength(1)
    const reply = harness.chat.deliveries[0]!.text
    expect(reply).toContain('By company or by product?')
    expect(reply).toContain('needs you')
    // Neither of these means anything to somebody on the platform: the directory is on this machine, and the tool is
    // registered in a Session they are not in. Telling them to use it would be a false instruction.
    expect(reply).not.toContain('ordin_answer_ticket')
    expect(reply).not.toContain(ticket.execution!.directory)
    // The front desk still hears about it, which is the other half of a blocked Report and is unchanged.
    expect(harness.relays.at(-1)!).toContain('By company or by product?')
  })

  it('queues one reply when the same words are asked for twice, and a second when they differ', async () => {
    const harness = rig()
    const ticket = harness.live()
    const replyTo = replyToOf(harness, ticket)

    harness.delivery.send(ticket, 'the same sentence')
    // Deliberately more than a millisecond apart. A key that carried the instant would still deduplicate two calls
    // made inside one, which is exactly how C1's mutation check stayed green: the gap has to be wider than the
    // resolution of whatever does not belong in the key.
    await wait(5)
    harness.delivery.send(ticket, 'the same sentence')
    expect(harness.store.effectCounts()).toEqual({ send: 1 })
    expect(harness.store.pendingEffects('send', sendKey(ticket.id, replyTo, 'the same sentence'))).toBe(true)
    // Nothing went out while the two calls were being deduplicated.
    expect(harness.chat.deliveries).toEqual([])

    harness.delivery.send(ticket, 'a different sentence')
    expect(harness.store.effectCounts()).toEqual({ send: 2 })
    expect(harness.delivery.sends().queued).toBe(3)

    // One pass delivers both, each to its own delivery: the key is an identity, not a limit of one reply per Ticket.
    await harness.runDue()
    expect(harness.store.effectCounts()).toEqual({})
    const texts = harness.chat.deliveries.map(row => row.text).sort()
    expect(texts).toEqual(['a different sentence', 'the same sentence'])
  })
})

describe('a Ticket that stopped without an answer (S1)', () => {
  const waiting = { state: 'waiting' as const, summary: 'The worker ended its turn without a report.', at: '2026-11-07T04:00:00.000Z' }

  it('reaches the requester, and says what became of the work rather than calling it dropped', async () => {
    const harness = rig()
    const ticket = harness.live()
    harness.delivery.report(ticket, waiting)
    await harness.runDue()

    expect(harness.chat.deliveries).toHaveLength(1)
    const reply = harness.chat.deliveries[0]!.text
    expect(reply).toContain('stopped, needs a push')
    expect(reply).toContain('The worker ended its turn without a report.')
    // Not 'dropped': a dropped Ticket was judged to need no work, and this one has work that has stopped.
    expect(reply).not.toContain('dropped')
    // The requester is not told about ordin's own tools or directories — they cannot act on either.
    expect(reply).not.toContain('ordin_retry_ticket')
    expect(reply).not.toContain(ticket.execution!.directory)
  })

  it('wakes the front desk with the way to act, because a notice in a history nobody reads is not an escalation', async () => {
    const harness = rig()
    const ticket = harness.live()
    harness.delivery.report(ticket, waiting)
    await harness.runDue()
    const told = harness.relays.at(-1)!
    expect(told).toContain('stopped, needs a push')
    // The front desk is the one place that can act without the operator, so it gets the tool name.
    expect(told).toContain('ordin_retry_ticket')
    expect(told).toContain('ordin_stop_ticket')
  })
})

describe('progress and giving up, routed (S2)', () => {
  it('progress reaches the front desk and never the requester — one line per turn in a room is how a bot gets muted', async () => {
    const harness = rig()
    const ticket = harness.live()
    harness.delivery.report(ticket, { state: 'progress', summary: '读完了 12 个文件，正在比对', at: '2026-11-07T05:00:00.000Z' })
    await harness.runDue()
    // Nothing went to the platform.
    expect(harness.chat.deliveries).toEqual([])
    expect(harness.store.effectCounts().send).toBeUndefined()
    // But the front desk has it, injected rather than queued: a progress line is a fact to know, not a question.
    expect(harness.notices.at(-1)!).toContain('读完了 12 个文件，正在比对')
    expect(harness.relays).toEqual([])
  })

  it('the Watchdog giving up reaches the requester, and wakes the front desk with the means to act', async () => {
    const harness = rig()
    const ticket = harness.live()
    harness.delivery.escalated(ticket, 'has not started after 2 attempts to rescue it; it needs a person')
    await harness.runDue()

    expect(harness.chat.deliveries).toHaveLength(1)
    const reply = harness.chat.deliveries[0]!.text
    expect(reply).toContain('needs a person')
    expect(reply).toContain('has not started after 2 attempts to rescue it')
    expect(reply).not.toContain('ordin_retry_ticket')
    const told = harness.relays.at(-1)!
    expect(told).toContain('the Watchdog has given up')
    expect(told).toContain('ordin_retry_ticket')
  })
})

describe('a Ticket with no way back', () => {
  it('sends nothing, throws nothing, and counts the nothing', () => {
    const harness = rig()
    const ticket = harness.live({ replyTo: undefined })
    const before = harness.delivery.sends()
    expect(() => harness.delivery.send(ticket, 'an answer with nowhere to go')).not.toThrow()
    expect(harness.store.effectCounts().send).toBeUndefined()
    expect(harness.delivery.sends()).toEqual({ queued: before.queued, nowhere: before.nowhere + 1 })
    // Having nowhere to send is not a problem, and must not be written as one: `record` would erase a real problem
    // on the same entry, and a board that cries wolf about cron Tickets is a board nobody reads.
    expect(harness.health.entry('delivery').snapshot()).toMatchObject({ ok: true })
  })

  it('counts the ordinary Reports it could not send back, so the number is a fact about the deployment', async () => {
    const harness = rig()
    const ticket = harness.live({ replyTo: undefined })
    expect(harness.delivery.sends()).toEqual({ queued: 0, nowhere: 0 })
    harness.delivery.report(ticket, { state: 'ready', summary: '写好了。', at: '2026-11-07T03:00:00.000Z' })
    await harness.runDue()
    // The Report reached the front desk and `RESULT.md`, and is counted as having had nowhere else to go.
    expect(harness.delivery.sends()).toEqual({ queued: 0, nowhere: 1 })
    expect(harness.store.effectCounts()).toEqual({})
    expect(existsSync(join(ticket.execution!.directory, 'RESULT.md'))).toBe(true)
  })

  it('a stopped Ticket with nowhere to write still wakes the front desk, and counts the place it could not reach', async () => {
    const harness = rig()
    const ticket = harness.live({ replyTo: undefined })
    const before = harness.delivery.sends()
    harness.delivery.report(ticket, {
      state: 'waiting', summary: 'The worker ended its turn without a report.', at: '2026-11-07T04:00:00.000Z',
    })
    await harness.runDue()
    // Nothing was sent, and the fact that there was nowhere to send it is counted rather than swallowed.
    expect(harness.delivery.sends()).toEqual({ queued: before.queued, nowhere: before.nowhere + 1 })
    expect(harness.store.effectCounts().send).toBeUndefined()
    // Still not a problem on the board: a cron or inbox Ticket with nowhere to write is the normal shape here.
    expect(harness.health.entry('delivery').snapshot()).toMatchObject({ ok: true })
    // But the front desk hears it, because it is the one place that can act without an address.
    expect(harness.relays.at(-1)!).toContain('ordin_retry_ticket')
  })
})

describe('a reply that does not go out', () => {
  it('keeps the effect, counts the failure on its row and names it on the board when the Source refuses', async () => {
    const harness = rig()
    const ticket = harness.live()
    const replyTo = replyToOf(harness, ticket)
    harness.chat.refuse = new UserError('reply_unroutable', { channel: 'ops' })

    harness.delivery.send(ticket, 'the answer')
    await harness.runDue()

    // The row is still there, which is what makes the retry possible at all: an inline send would already have
    // lost these words, with nothing left to say they were ever owed.
    expect(harness.store.effectCounts()).toEqual({ send: 1 })
    expect(harness.store.pendingEffects('send', sendKey(ticket.id, replyTo, 'the answer'))).toBe(true)
    // `failures` on the row itself, read the way the queue reads it: `now` far enough ahead to claim a row that is
    // backing off, then released so the queue's own retry still owns it.
    const rows = harness.store.claimEffects('send', 10, Date.now() + 60_000)
    expect(rows.map(row => [row.key, row.failures])).toEqual([[sendKey(ticket.id, replyTo, 'the answer'), 1]])
    harness.store.releaseRunning()
    expect(harness.health.entry('effects').snapshot()).toMatchObject({ ok: false })
    expect(harness.health.entry('effects').snapshot().detail).toContain('send failed 1 of 5 times')
    expect(harness.health.entry('effects').snapshot().detail).toContain('nowhere to go')
    // Retried, not given up on: no trace of a give-up yet, because the queue has four attempts left.
    expect(existsSync(join(ticket.execution!.directory, UNDELIVERED_FILE))).toBe(false)
  })

  it('records a give-up in the Ticket\'s log and its directory, and both outlive the health board', async () => {
    const harness = rig()
    const ticket = harness.live()
    const replyTo = replyToOf(harness, ticket)
    harness.chat.refuse = new UserError('reply_unroutable', { channel: 'ops' })
    const owed = 'Three of the four were duplicates; the fourth needs your decision.'

    harness.delivery.send(ticket, owed)
    await harness.runDue()
    // Attempts 2 to 5, each pulled forward instead of waited out: the real backoff is 15s, 30s, 60s…, and what is
    // under test is the give-up rather than the clock. The count is the queue's own budget, not one this test sets,
    // so the wiring under test is the one that ships.
    for (let attempt = 2; attempt <= 5; attempt++) {
      harness.store.deferEffect('send', sendKey(ticket.id, replyTo, owed), Date.now() - 1)
      await harness.runDue()
    }

    // The queue settled the row when it gave up, so the queue itself now holds nothing: this is the hole.
    expect(harness.store.effectCounts()).toEqual({})
    // First record: the give-up is handed to Delivery's replyLost, which the runtime turns into a `reply_lost`
    // event — the address, the error and the words that were owed.
    expect(harness.lost).toHaveLength(1)
    expect(harness.lost[0]!.ticketId).toBe(ticket.id)
    expect(harness.lost[0]!.detail).toMatchObject({ address: 'chat/ops (thread t-9)', text: owed })
    expect(String(harness.lost[0]!.detail.error)).toContain('nowhere to go')
    // Second record: the file, which carries the words verbatim so a person can send them by hand.
    const path = join(ticket.execution!.directory, UNDELIVERED_FILE)
    const trace = readFileSync(path, 'utf8')
    expect(trace).toContain(owed)
    expect(trace).toContain(ticket.id)
    expect(trace).toContain('chat/ops (thread t-9)')
    expect(trace).toContain('nowhere to go')
    // Named literally, and not only through the imported constant: this is a file a person opens in the Ticket's
    // directory, and a test that took the name from the code would stay green if the code renamed it.
    expect(readdirSync(ticket.execution!.directory)).toContain('REPLY-UNDELIVERED.md')

    // THE POINT OF THE TEST: an unrelated success clears the board — that is what `record` is for, and it is why a
    // health line is not a record — and both traces are still readable where they live: in the callback the runtime
    // turns into an event, and on disk.
    //
    // Caused rather than simulated. The clearing is caused by a delivery that really happened, not by a handler that
    // quietly did nothing: the queue ends a pass with a summary once nothing it complained about is still queued,
    // while Delivery has no pass of its own — its handlers run inside the queue's — so the only thing it can speak
    // for is one delivery that went through.
    harness.chat.refuse = undefined
    const later = 'a later sentence, which does get through'
    harness.delivery.send(ticket, later)
    await harness.runDue()
    expect(harness.chat.deliveries.map(row => row.text)).toContain(later)
    expect(harness.health.entry('effects').snapshot())
      .toMatchObject({ ok: true, detail: 'no effect failed in this pass' })
    expect(harness.health.entry('delivery').snapshot())
      .toMatchObject({ ok: true, detail: 'the last delivery went through' })
    expect(readFileSync(path, 'utf8')).toBe(trace)
    expect(harness.lost).toHaveLength(1)
  })

  it('fails the effect rather than calling something that is not there when the address names a Source that only produces', async () => {
    // A Source that produces and cannot answer back: mounted, running, no `deliver` at all.
    const oneWay: Source = { id: 'rule', kind: 'rule', start: () => {}, stop: () => {}, status: () => ({ ok: true }) }
    const harness = rig({ source: kind => kind === 'rule' ? oneWay : undefined })
    const ticket = harness.live()
    // Point the Trigger's address at the one-way kind: the address is fine, and nothing is running that could take it.
    const stored = harness.store.triggers.get(ticket.origin.triggerId)!
    harness.store.triggers.save({ ...stored, trigger: { ...stored.trigger, replyTo: { kind: 'rule', channel: 'nowhere' } } })

    const replyTo = replyToOf(harness, ticket)
    harness.delivery.send(ticket, 'the answer')
    await harness.runDue()

    // Rode the queue's machinery instead of being swallowed: a refusal here is a fact about the deployment that has
    // to be retried and, when it never succeeds, recorded — not an exception caught where nobody will see it.
    expect(harness.store.effectCounts()).toEqual({ send: 1 })
    const detail = harness.health.entry('effects').snapshot().detail!
    // Named for its own cause, by code: the other refusal — a two-way Source that WAS found, whose channel is gone or
    // disabled — keeps `reply_unroutable`, because the two have different remedies and one message for both sends
    // whoever reads it looking in the wrong place.
    expect(detail).toContain('No Source is running that can take this reply back')
    expect(detail).not.toContain('channel is gone')
    // The row is keyed by the address `send` read out of the store, which is the proof it resolved the Trigger
    // rather than assuming the kind this deployment happens to have configured.
    expect(harness.store.pendingEffects('send', sendKey(ticket.id, replyTo, 'the answer'))).toBe(true)
    expect(harness.delivery.sends()).toMatchObject({ queued: 1 })
  })
})

describe('a reply nothing can take', () => {
  /**
   * The two refusals a reply can meet, told apart BY CODE.
   *
   * The queue turns a refusal into a health line and a trace, both of which carry the sentence — so this harness keeps
   * the queue's own give-up hook, which is handed the thrown error itself, and runs the dispatcher against the two
   * causes: nothing running that could carry the reply, and a real ChatSource whose channel is not in its settings.
   * Asserting the sentences would pass even if the two codes collapsed back into one, which is the whole reason
   * `reply_unreceivable` exists next to `reply_unroutable`.
   */
  const AT = '2026-11-04T03:00:00.000Z'

  /** A Source that produces and cannot answer back: mounted, running, no `deliver` at all. */
  const oneWay: Source = {
    id: 'rule', kind: 'rule', start: (): void => {}, stop: (): void => {}, status: () => ({ ok: true }),
  }

  /**
   * A real ChatSource whose settings name no channels, so its own `deliver` refuses the address.
   *
   * `deliver` reads `settings()` and nothing else, so the rest of the host is a stub this path never reaches — the
   * throw under test is chat.ts's own, not a fake standing in for it.
   */
  function channellessChat(): ChatSource {
    const settings = parseSettings({ sources: { chat: { enabled: true, channels: [] } } })
    return new ChatSource({ settings: () => settings } as unknown as SourceHost)
  }

  /** A Delivery over a queue with one attempt, so the first refusal is also the give-up the hook is handed. */
  function refusal(source: (kind: string) => Source | undefined): { threw: unknown[]; send: (text: string) => Promise<void> } {
    const directory = tempDir('ordin-send-')
    const store = new Store(join(directory, 'refusal.sqlite3'))
    const health = new HealthBoard()
    const threw: unknown[] = []
    const effects = new Effects(store, {
      tries: 1, retryIntervalMs: 1, health: health.entry('effects'),
      onPermanentFailure: (_kind, _key, _payload, error) => { threw.push(error) },
    })
    const delivery = new OutcomeDelivery({
      logger: silentLogger(), store, effects, health, lifetime: new AbortController().signal,
      proc: new ProcessRegistry(),
      settings: () => store.settings(), panelPath: () => '', source: kind => source(kind),
      // Nothing is told anything here: a reply is refused before it reaches the desk, and the log event is the
      // runtime's business. What is under test is which error the dispatcher threw.
      desk: { notify: async () => {}, relay: async () => {} },
      replyLost: () => {},
      writeResultFile: async (dir: string, name: string, text: string) => {
        await writeFile(join(dir, name), text, 'utf8')
      },
    }, null)
    const triggerId = key('chat', 'ops', 'msg-1')
    store.triggers.save({
      trigger: {
        id: triggerId, source: 'chat', kind: 'chat', at: AT, actor: { id: 'alice', kind: 'person' },
        text: 'Sort this out.', title: 'alerts', replyTo: { kind: 'chat', channel: 'ops' },
      },
      disposition: { state: 'accepted', ticketId: 'ticket-1', decisionId: 'decision-1' },
    })
    const ticket: Ticket = {
      id: 'ticket-1', title: 'alerts', createdAt: AT, origin: { triggerId }, attachments: [], assignments: [],
      notes: [], inputs: [],
      mandate: {
        policyVersion: 'abc123', scope: 'Work in this Ticket\'s own directory.', strength: 'explicit',
        sender: { id: 'alice', kind: 'person' }, via: 'chat', at: AT,
      },
    }
    return { threw, send: async text => { delivery.send(ticket, text); await effects.runDue() } }
  }

  it('says "nothing can carry this" and "the channel is gone" in two different codes', async () => {
    const noCarrier = refusal(() => oneWay)
    await noCarrier.send('the answer')
    const unreceivable = noCarrier.threw[0]
    expect(unreceivable).toBeInstanceOf(UserError)
    expect((unreceivable as UserError).code).toBe('reply_unreceivable')

    const noChannel = refusal(kind => kind === 'chat' ? channellessChat() : undefined)
    await noChannel.send('the answer')
    const unroutable = noChannel.threw[0]
    expect(unroutable).toBeInstanceOf(UserError)
    expect((unroutable as UserError).code).toBe('reply_unroutable')

    // The point of the pair: one says "install or enable a Source that can answer back", the other says "put the
    // channel back". Same symptom from the outside, different remedy, so they may not share a code.
    expect((unreceivable as UserError).code).not.toBe((unroutable as UserError).code)
  })
})

describe('outbound file delivery on a ready report (Pkg 2)', () => {
  it('attaches verified files inside the Ticket directory, and refuses symbolic links and escapes', async () => {
    const harness = rig()
    const ticket = harness.live()
    const dir = ticket.execution!.directory
    const validFile = join(dir, 'summary.csv')
    writeFileSync(validFile, 'company,round\nDeepSeek,A\n', 'utf8')
    const outside = join(tempDir('ordin-send-outside-'), 'secret-outside.txt')
    writeFileSync(outside, 'do-not-leak', 'utf8')
    symlinkSync(outside, join(dir, 'leaked.txt'))

    harness.delivery.report(ticket, {
      state: 'ready',
      summary: '研究完成，数据见附件。',
      files: ['summary.csv', 'leaked.txt', '../secret-outside.txt'],
      at: '2026-11-07T10:00:00.000Z',
    })
    await harness.runDue()

    expect(harness.chat.deliveries).toHaveLength(1)
    const options = harness.chat.deliveries[0]!.options
    expect(options?.files).toEqual([validFile])
    expect(JSON.stringify(options?.files)).not.toContain('leaked.txt')
    expect(JSON.stringify(options?.files)).not.toContain('secret-outside.txt')
  })
})

/**
 * The borrowed-work line reaching the room (减负).
 *
 * The wording has its own unit tests in `delivery.spec.ts`, against a queue that records instead of delivering. What
 * those cannot show is the wiring: the sentence is read out of the real event log at report time, through the real
 * Engine's own doors (`authorizeArtifactRead`/`recordArtifactRead`/`skillUsed`), and lands in what the Source
 * receives. A hand-written event on either side would assert my copy of the shape, and renaming the detail key
 * (`fromTicketId`, `skill`) would silently drop the line from every reply and fail nothing.
 */
describe('a reply that says what it was built on', () => {
  const AT = '2026-11-08T03:00:00.000Z'

  /** An Executor that records what the Engine asked of it, and fills in a directory that really exists. */
  class FakeExecutor implements Executor {
    engine?: Engine
    constructor(private readonly root: string) {}
    prepare(ticket: Ticket, _mandate: Mandate): Ticket {
      const directory = join(this.root, ticket.id)
      mkdirSync(directory, { recursive: true })
      return { ...ticket, execution: { name: ticket.id, directory } }
    }
    start(ticket: Ticket, assignment: Assignment): void { this.engine?.assignmentStarted(ticket.id, assignment.id) }
    deliver(_ticket: Ticket, _assignment: Assignment): void {}
    stop(_ticket: Ticket, _assignment: Assignment, _reason: string): void {}
  }

  function engineRig() {
    const harness = rig()
    // The gate reads the Source's own enabled flag, so an intake test must configure the kind it feeds.
    const settings = parseSettings({
      acceptMode: 'auto', allowedSenders: ['alice'],
      sources: { chat: { enabled: true, channels: [{ id: 'ops', directory: tempDir('ordin-engine-chat-'), enabled: true }] } },
    })
    const executor = new FakeExecutor(tempDir('ordin-engine-work-'))
    const engine = new Engine({
      repos: harness.store, tx: harness.store, inputConsumptions: harness.store.inputConsumptions,
      policy: () => settingsPolicy(settings), executor, delivery: harness.delivery, now: () => AT,
    })
    executor.engine = engine
    const ask = (id: string, title: string): Ticket => {
      const trigger: Trigger = {
        id: key('chat', 'ops', id), source: 'chat', kind: 'chat', at: AT, actor: { id: 'alice', kind: 'person' },
        text: title, title, replyTo: { kind: 'chat', channel: 'ops', thread: 't-9' },
      }
      const result = engine.receive(trigger)
      expect(result.disposition).toMatchObject({ state: 'accepted' })
      return harness.store.tickets.get(result.ticketId!)!
    }
    return { harness, engine, ask }
  }

  it('names the earlier job in the room, and in RESULT.md, with no id and no path in either', async () => {
    const { harness, engine, ask } = engineRig()
    const first = ask('msg-1', 'weekly alerts')
    // Registered by a report, which is the only thing that makes a file another Ticket's artifact at all.
    engine.report(first.id, { state: 'ready', summary: '数据抓完了', files: ['data/table.csv'] })
    await harness.runDue()

    const second = ask('msg-2', 'write it up')
    // The real door, and the only thing this test arranges by hand: `authorizeArtifactRead` answers whether the read
    // may happen and `recordArtifactRead` is what writes the lineage into both Tickets' logs — the same two calls the
    // Executor makes on a worker's success path. So the sentence below is caused by the system's own recording, not
    // simulated into the log.
    const authorized = engine.authorizeArtifactRead(second.id, first.id, 'data/table.csv')
    engine.recordArtifactRead(second.id, first.id, authorized.artifact.path)
    expect(harness.store.events.list(second.id).filter(event => event.type === 'artifact_read')).toHaveLength(1)

    harness.delivery.report(harness.store.tickets.get(second.id)!, {
      state: 'ready', summary: '写好了，结论在正文里。', at: '2026-11-08T03:00:00.000Z',
    })
    await harness.runDue()

    const reply = harness.chat.deliveries.find(row => row.text.includes('写好了，结论在正文里。'))
    expect(reply, '第二张任务的回复应当已经送到').toBeDefined()
    // The prose a person reads carries the earlier job's TITLE — how the operator remembers it — and nothing else.
    expect(reply!.text).toBe('写好了，结论在正文里。\n\n（这份用上了「weekly alerts」的成果）')
    expect(reply!.text).not.toContain(first.id)
    expect(reply!.text).not.toContain(second.id)
    expect(reply!.text).not.toContain(first.execution!.directory)
    expect(reply!.text).not.toContain('data/table.csv')
    expect(reply!.text).not.toContain('ordin_')

    // The same sentence, unwrapped, in the file that outlives the message: two texts about one fact, agreeing.
    const document = readFileSync(join(second.execution!.directory, 'RESULT.md'), 'utf8')
    expect(document).toContain('## Borrowed work')
    expect(document).toContain('这份用上了「weekly alerts」的成果')
    expect(document).not.toContain('（这份用上了')
  })

  /**
   * The two halves of the craft line live in different files: `Engine.skillUsed` WRITES `detail.fromTicketId` and
   * `detail.skill`, and `delivery.borrowedFrom` READS those keys. Nothing else owns that comparison — the unit tests
   * on each side hand-write the shape they expect, so renaming either key would silently drop the line from every
   * reply and fail nothing. This test goes through the real engine door and the real outbound text.
   */
  it('counts a craft the engine itself recorded, so the shape one file writes is the shape the other reads', async () => {
    const { harness, engine, ask } = engineRig()
    const first = ask('msg-1', 'weekly alerts')
    engine.report(first.id, { state: 'ready', summary: '写好了一个通用脚本', files: ['dedup.py'] })
    await harness.runDue()

    const second = ask('msg-2', 'reuse it')
    // The real door, not a hand-written event: this is what the Executor calls after a worker's load of a promoted
    // craft completes.
    engine.skillUsed(second.id, first.id, 'ordin-dedup-merger')
    const events = harness.store.events.list(second.id).filter(event => event.type === 'skill_used')
    expect(events).toHaveLength(1)
    expect(events[0]!.detail).toMatchObject({ fromTicketId: first.id, skill: 'ordin-dedup-merger' })

    harness.delivery.report(harness.store.tickets.get(second.id)!, {
      state: 'ready', summary: '跑完了。', at: '2026-11-08T04:00:00.000Z',
    })
    await harness.runDue()

    const reply = harness.chat.deliveries.find(row => row.text.includes('跑完了。'))
    expect(reply, '回复应当已经送到').toBeDefined()
    // The craft is counted, never named: `ordin-dedup-merger` is a plugin identifier that means nothing on a phone.
    expect(reply!.text).toBe('跑完了。\n\n（这份用上了 1 门已沉淀的手艺）')
    expect(reply!.text).not.toContain('ordin-dedup-merger')
    expect(reply!.text).not.toContain(first.id)
    expect(reply!.text).not.toContain(second.id)
  })
})
