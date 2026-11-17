/**
 * Telling somebody: the record a finished Ticket leaves, and the notice that reaches the operator's front desk.
 *
 * 迁入自 ordin tests/notify.spec.ts（P2-T7），从整机 deployment 降到组件级：真实 Store + 真实 Effects +
 * fake DeskPort + fake ProcessRegistry，不启动任何平台、不 spawn 真实进程。原文件里经由 Runtime 的接线用例
 * （engine.report → 面板 JSON、runtime.watchdogHost）不在本卡范围，未覆盖项见汇报。
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { OutcomeDelivery, type DeskPort } from '../src/app/delivery.ts'
import { Effects } from '../src/app/effects.ts'
import { HealthBoard } from '../src/app/health.ts'
import type { Logger } from '../src/app/logger.ts'
import type { ProcessRecord, ProcessRegistry, SpawnSpec, WaitResult } from '../src/app/process.ts'
import { Store } from '../src/app/store.ts'
import { parseSettings, type PolicyEffect, type ReplyTo, type Ticket } from '../src/core/index.ts'
import type { DeliverOptions, Source } from '../src/sources/kind.ts'
import { tempDir } from './helpers/temp.ts'

/** A ProcessRegistry that records what it was asked to start and answers the outcome the test wants. */
class FakeProc {
  readonly spawns: SpawnSpec[] = []
  mode: 'ok' | 'throw' | 'nonzero' | 'failed' = 'ok'

  spawn(spec: SpawnSpec): ProcessRecord {
    this.spawns.push(spec)
    if (this.mode === 'throw') throw new Error('osascript: command not found')
    return {
      id: `fake-${this.spawns.length}`, pid: 1, owner: spec.owner, groupId: spec.owner, startedAt: Date.now(),
      status: 'running', exitCode: null, exitSignal: null, endedAt: null,
      stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, error: null,
    }
  }

  async wait(id: string): Promise<WaitResult> {
    if (this.mode === 'nonzero') return { id, exitCode: 1, exitSignal: null, status: 'exited' }
    if (this.mode === 'failed') return { id, exitCode: null, exitSignal: null, status: 'failed' }
    return { id, exitCode: 0, exitSignal: null, status: 'exited' }
  }
}

interface Rig {
  readonly store: Store
  readonly effects: Effects
  readonly health: HealthBoard
  readonly notices: string[]
  readonly relays: string[]
  /** Every reply the fake chat Source was handed, in order — the two-way half of a report. */
  readonly deliveries: { readonly replyTo: ReplyTo; readonly text: string; readonly options?: DeliverOptions }[]
  readonly logs: { readonly debug: string[]; readonly errors: string[]; readonly warnings: string[] }
  readonly proc: FakeProc
  readonly delivery: OutcomeDelivery
  /** One live Ticket with a directory and (by default) a chat reply address. */
  live(id: string, over?: Partial<Ticket> & { readonly replyTo?: { kind: 'chat'; channel: string; thread?: string } }): Ticket
  runDue(): Promise<void>
}

/**
 * A Delivery over a real Store and a real effects queue, with the desk and the process registry faked.
 *
 * The queue is real because "the effect settles" and "the row is still queued" are the facts several of these tests
 * turn on, and a stub that records enqueues could not answer either.
 */
function rig(over: {
  notifyEnabled?: boolean
  panel?: string
  notifier?: string | null
  writeResult?: (directory: string, name: string, text: string) => Promise<void>
  proc?: FakeProc
} = {}): Rig {
  const directory = tempDir('ordin-notify-')
  const store = new Store(join(directory, 'notify.sqlite3'))
  const health = new HealthBoard()
  const effects = new Effects(store, { tries: 5, retryIntervalMs: 1, health: health.entry('effects') })
  const notices: string[] = []
  const relays: string[] = []
  const desk: DeskPort = {
    notify: async (text: string) => { notices.push(text) },
    relay: async (_requestId: string, text: string) => { relays.push(text) },
  }
  const logs = { debug: [] as string[], errors: [] as string[], warnings: [] as string[] }
  const logger: Logger = {
    debug: (message: string) => { logs.debug.push(message) },
    info: () => {},
    warn: (message: string) => { logs.warnings.push(message) },
    error: (message: string) => { logs.errors.push(message) },
  }
  const proc = over.proc ?? new FakeProc()
  const writeResult = over.writeResult ?? (async (dir: string, name: string, text: string) => {
    await writeFile(join(dir, name), text, 'utf8')
  })
  // A two-way chat Source that records instead of posting: the reply half of a report has to land somewhere the
  // test can read, and nowhere in this file is a platform.
  const deliveries: { replyTo: ReplyTo; text: string; options?: DeliverOptions }[] = []
  const chat: Source & { deliver(replyTo: ReplyTo, text: string, options?: DeliverOptions): Promise<void> } = {
    id: 'chat', kind: 'chat', start: () => {}, stop: () => {}, status: () => ({ ok: true }),
    deliver: async (replyTo, text, options) => { deliveries.push({ replyTo, text, options }) },
  }
  if (over.notifyEnabled === true) store.saveSettings(parseSettings({ notify: { enabled: true } }))
  const delivery = new OutcomeDelivery({
    logger, store, effects, desk, health, lifetime: new AbortController().signal,
    proc: proc as unknown as ProcessRegistry,
    settings: () => store.settings(),
    panelPath: () => over.panel ?? '',
    source: () => chat,
    replyLost: () => {},
    writeResultFile: writeResult,
  }, over.notifier ?? null)

  let sequence = 0
  const live = (id: string, extra: Partial<Ticket> & { readonly replyTo?: { kind: 'chat'; channel: string; thread?: string } } = {}): Ticket => {
    sequence += 1
    const at = `2026-11-0${(sequence % 9) + 1}T10:00:00.000Z`
    const triggerId = `trigger-${id}`
    store.triggers.save({
      trigger: {
        id: triggerId, source: 'chat', kind: 'chat', at, actor: { id: 'alice', kind: 'person' },
        text: '整理一下', title: `任务 ${id}`,
        ...(extra.replyTo === undefined ? {} : { replyTo: extra.replyTo }),
      },
      disposition: { state: 'accepted', ticketId: id, decisionId: `decision-${id}` },
    })
    const work = join(tempDir(`ordin-notify-dir-${id}-`), 'work')
    mkdirSync(work, { recursive: true })
    const { replyTo: _ignored, ...rest } = extra
    const row: Ticket = {
      id, title: `任务 ${id}`, createdAt: at,
      mandate: {
        policyVersion: 'abc123', scope: 'Work in this Ticket\'s own directory.', strength: 'explicit',
        sender: { id: 'alice', kind: 'person' }, via: 'chat', at,
      },
      origin: { triggerId }, attachments: [],
      assignments: [{ id: `assignment-${id}`, state: 'running', createdAt: at }],
      notes: [], inputs: [], execution: { name: 'digest', directory: work },
      ...rest,
    }
    store.tickets.save(row)
    return row
  }

  return { store, effects, health, notices, relays, deliveries, logs, proc, delivery, live, runDue: () => effects.runDue() }
}

describe('the record a finished Ticket leaves', () => {
  it('writes RESULT.md in the Ticket\'s own directory, and wakes the front desk (F1)', async () => {
    const harness = rig()
    const ticket = harness.live('ticket-1', { replyTo: { kind: 'chat', channel: 'ops', thread: 't-9' } })
    const directory = ticket.execution!.directory

    harness.delivery.report(ticket, { state: 'ready', summary: '写好了 digest.md', files: ['digest.md'], at: '2026-11-02T11:00:00.000Z' })
    await harness.runDue()

    const document = readFileSync(join(directory, 'RESULT.md'), 'utf8')
    expect(document).toContain('# 任务 ticket-1')
    expect(document).toContain('写好了 digest.md')
    expect(document).toContain('- digest.md')
    // 【F1】An ending is a relay (desk woken) so it can decide how to inform the operator.
    expect(harness.relays).toHaveLength(1)
    expect(harness.notices).toEqual([])
    expect(harness.relays[0]!).toContain('写好了 digest.md')
    // The other half of a report: the words go back to the address the Trigger wrote down.
    expect(harness.deliveries).toHaveLength(1)
    expect(harness.deliveries[0]!.replyTo).toEqual({ kind: 'chat', channel: 'ops', thread: 't-9' })
    expect(harness.deliveries[0]!.text).toContain('写好了 digest.md')
    expect(harness.deliveries[0]!.options).toMatchObject({ ticketId: 'ticket-1' })
    expect(harness.store.effectCounts()).toEqual({})
    // A delivery that went through is the evidence the board is given; nothing was complained about.
    expect(harness.health.entry('delivery').snapshot()).toMatchObject({ ok: true })
  })

  it('wakes the front desk when the worker needs a decision, and writes no RESULT.md', async () => {
    const harness = rig()
    const ticket = harness.live('ticket-1')
    harness.delivery.report(ticket, { state: 'blocked', summary: '需要决定', question: '按公司还是按产品？', at: '2026-11-02T11:00:00.000Z' })
    await harness.runDue()

    // A question is a message the operator answers, so it wakes the desk rather than being injected.
    expect(harness.relays).toHaveLength(1)
    expect(harness.relays[0]!).toContain('按公司还是按产品？')
    expect(harness.relays[0]!).toContain('ordin_answer_ticket')
    // No RESULT.md yet: the Ticket has not ended.
    expect(existsSync(join(ticket.execution!.directory, 'RESULT.md'))).toBe(false)
    expect(harness.store.effectCounts()).toEqual({})
  })

  it('still tells the front desk when the record could not be written, and keeps the line on the board', async () => {
    const harness = rig({
      writeResult: async () => { throw new Error('ENOENT: no such directory') },
    })
    const ticket = harness.live('ticket-1')
    harness.delivery.report(ticket, { state: 'ready', summary: '写好了', at: '2026-11-02T11:00:00.000Z' })
    await harness.runDue()

    // The file is a courtesy the directory can refuse; the notice is the record that must survive.
    const problems = harness.health.problems().map(problem => problem.detail).join('\n')
    expect(problems).toContain('RESULT.md')
    expect(harness.relays).toHaveLength(1)
    expect(harness.store.effectCounts()).toEqual({})
    // A pass that follows must not clear the line: Delivery only records success on a delivery that went through,
    // and this one reported a problem while composing it.
    await harness.runDue()
    expect(harness.health.problems().map(problem => problem.detail).join('\n')).toContain('RESULT.md')
  })

  it('settles a notice for a Ticket that is gone, rather than retrying it forever', async () => {
    const harness = rig()
    harness.store.enqueueEffect('notify', 'notify-gone', {
      kind: 'report', ticketId: 'no-such-ticket', state: 'ready', summary: 'x', at: '2026-11-03T03:00:00.000Z',
    })
    await harness.runDue()
    expect(harness.store.effectCounts()).toEqual({})
    expect(harness.health.problems()).toEqual([])
    expect(harness.notices).toEqual([])
    expect(harness.relays).toEqual([])
  })
})

describe('a settings change that bears on live work', () => {
  it('tells the front desk in the gate\'s own words', async () => {
    const harness = rig()
    const ticket = harness.live('ticket-1')
    const effect: PolicyEffect = { ticketId: ticket.id, reason: 'sender_not_allowed' }
    harness.delivery.policyChanged(ticket, effect)
    await harness.runDue()

    expect(harness.notices.at(-1)).toContain(ticket.id)
    expect(harness.notices.at(-1)).toContain('may not originate work')
    // A change is delivered, never enforced by cancellation.
    expect(harness.relays).toEqual([])
    expect(harness.store.effectCounts()).toEqual({})
  })
})

describe('the machine notification', () => {
  it('asks the desktop when the operator turned it on, with the summary quoted into it', async () => {
    if (process.platform !== 'darwin') return
    const harness = rig({ notifyEnabled: true })
    const ticket = harness.live('ticket-1')
    harness.delivery.report(ticket, { state: 'ready', summary: '写好了 "digest.md"', at: '2026-11-02T11:00:00.000Z' })
    await harness.runDue()

    expect(harness.proc.spawns).toHaveLength(1)
    const notification = harness.proc.spawns[0]!
    expect(notification.argv[0]).toBe('osascript')
    expect(notification.argv.join(' ')).toContain('display notification')
    // A quote in the summary must not break out of the AppleScript string.
    expect(notification.argv.join(' ')).toContain('\\"digest.md\\"')
    // Every process Ordin starts is booked: this one is owned by delivery and settles with a numeric exit code.
    expect(notification.owner).toBe('delivery')
    expect(harness.store.effectCounts()).toEqual({})
  })

  it('does not ask the desktop when the operator did not turn it on', async () => {
    const harness = rig()
    const ticket = harness.live('ticket-1')
    harness.delivery.report(ticket, { state: 'ready', summary: '写好了', at: '2026-11-02T11:00:00.000Z' })
    await harness.runDue()
    expect(harness.proc.spawns).toEqual([])
  })

  it('carries on when the desktop will not take it, because the notice is the record', async () => {
    if (process.platform !== 'darwin') return
    const proc = new FakeProc()
    proc.mode = 'throw'
    const harness = rig({ notifyEnabled: true, proc })
    const ticket = harness.live('ticket-1')
    harness.delivery.report(ticket, { state: 'ready', summary: '写好了', at: '2026-11-02T11:00:00.000Z' })
    await harness.runDue()

    // Settled rather than retried: a courtesy that failed is not work that is owed.
    expect(harness.store.effectCounts()).toEqual({})
    expect(harness.relays).toHaveLength(1)
    expect(harness.health.problems()).toEqual([])
    // Visible in the log rather than silent (A7).
    expect(harness.logs.debug.join('\n')).toContain('could not notify this machine')
  })

  it('logs a notifier that ran and exited nonzero, and settles the notice anyway', async () => {
    if (process.platform !== 'darwin') return
    const proc = new FakeProc()
    proc.mode = 'nonzero'
    const harness = rig({ notifyEnabled: true, proc })
    const ticket = harness.live('ticket-1')
    harness.delivery.report(ticket, { state: 'ready', summary: '写好了', at: '2026-11-02T11:00:00.000Z' })
    await harness.runDue()

    expect(harness.store.effectCounts()).toEqual({})
    expect(harness.health.problems()).toEqual([])
    expect(harness.logs.debug.join('\n')).toContain('could not notify this machine')
    expect(harness.logs.debug.join('\n')).toContain('exited')
  })

  it('opens the Ticket through terminal-notifier when that is what this machine has', async () => {
    if (process.platform !== 'darwin') return
    const harness = rig({
      notifyEnabled: true, notifier: '/opt/homebrew/bin/terminal-notifier',
      panel: 'http://127.0.0.1:3080/ordin/#ticket=',
    })
    const ticket = harness.live('ticket-1')
    harness.delivery.report(ticket, { state: 'ready', summary: '写好了', at: '2026-11-02T11:00:00.000Z' })
    await harness.runDue()

    const argv = harness.proc.spawns[0]!.argv
    expect(argv[0]).toBe('/opt/homebrew/bin/terminal-notifier')
    expect(argv).toContain('-open')
    expect(argv[argv.indexOf('-open') + 1]).toBe(`http://127.0.0.1:3080/ordin/#ticket=${ticket.id}`)
    expect(argv).toContain('-title')
    expect(argv).toContain('-message')
  })

  it('omits the click-through when this deployment has no panel to open', async () => {
    if (process.platform !== 'darwin') return
    const harness = rig({ notifyEnabled: true, notifier: '/opt/homebrew/bin/terminal-notifier', panel: '' })
    const ticket = harness.live('ticket-1')
    harness.delivery.report(ticket, { state: 'ready', summary: '写好了', at: '2026-11-02T11:00:00.000Z' })
    await harness.runDue()
    // A notification with a bogus `-open` is worse than one without.
    expect(harness.proc.spawns[0]!.argv).not.toContain('-open')
  })
})

describe('an escalation is told to the front desk with the means to act (S2)', () => {
  it('relays the Watchdog\'s give-up, and the text names the tools the desk can use', async () => {
    const harness = rig()
    const ticket = harness.live('ticket-1')
    const why = 'has not started after 2 attempts to rescue it; it needs a person'
    harness.store.enqueueEffect('notify', 'escalation-1', {
      kind: 'escalation', ticketId: ticket.id, at: '2026-11-02T11:00:00.000Z', why,
    })
    await harness.runDue()

    expect(harness.relays).toHaveLength(1)
    expect(harness.relays[0]!).toContain('the Watchdog has given up')
    expect(harness.relays[0]!).toContain('ordin_retry_ticket')
    expect(harness.relays[0]!).toContain(ticket.execution!.directory)
    expect(harness.store.effectCounts()).toEqual({})
  })
})

describe('progress and the two halves of the telling rule', () => {
  it('progress is injected into the desk and never relayed, because it is not a decision point', async () => {
    const harness = rig()
    const ticket = harness.live('ticket-1', { replyTo: { kind: 'chat', channel: 'ops' } })
    harness.delivery.report(ticket, { state: 'progress', summary: '读完了 12 个文件，正在比对', at: '2026-11-07T05:00:00.000Z' })
    await harness.runDue()

    // Injected, NOT relayed: a progress line is a fact to know, not a question to answer, and waking the desk for one
    // would cost a model turn per progress report.
    expect(harness.notices).toHaveLength(1)
    expect(harness.notices[0]!).toContain('读完了 12 个文件，正在比对')
    expect(harness.relays).toEqual([])
    // And it never goes to the requester: one per turn in a room is how a bot gets muted.
    expect(harness.store.effectCounts()).toEqual({})
    expect(existsSync(join(ticket.execution!.directory, 'RESULT.md'))).toBe(false)
  })
})

describe('a Ticket that stopped without an answer (S1)', () => {
  it('wakes the front desk with the way to act, and does not call it dropped', async () => {
    const harness = rig()
    const ticket = harness.live('ticket-1', { replyTo: { kind: 'chat', channel: 'ops' } })
    harness.delivery.report(ticket, { state: 'waiting', summary: 'The worker ended its turn without a report.', at: '2026-11-07T04:00:00.000Z' })
    await harness.runDue()

    expect(harness.relays).toHaveLength(1)
    expect(harness.relays[0]!).toContain('stopped, needs a push')
    expect(harness.relays[0]!).toContain('ordin_retry_ticket')
    expect(harness.relays[0]!).not.toContain('dropped')
    expect(existsSync(join(ticket.execution!.directory, 'RESULT.md'))).toBe(false)
  })
})

/**
 * 【R2 F-D5 防回声】纯分诊单（所有 Assignment 都是 triage role）由总管自己结案，
 * ready/failed/dropped 结案时不应反向 relay 唤醒总管再跑「确认回执」空轮次。
 * 普通 worker 票的 ready/failed/dropped 仍保持 F1 唤醒总管。
 */
describe('self-closed triage Ticket does not echo-relay back to the desk (R2 F-D5)', () => {
  const triage = (id: string): Ticket => {
    const at = '2026-11-14T02:00:00.000Z'
    const work = join(tempDir(`ordin-triage-dir-${id}-`), 'work')
    mkdirSync(work, { recursive: true })
    return {
      id, title: `分诊 ${id}`, createdAt: at,
      mandate: {
        policyVersion: 'abc123', scope: 'Work in this Ticket\'s own directory.', strength: 'explicit',
        sender: { id: 'operator', kind: 'person' }, via: 'chat', at,
      },
      origin: { triggerId: `trigger-${id}` }, attachments: [],
      assignments: [{ id: `assignment-${id}`, state: 'running', createdAt: at, role: 'triage' }],
      notes: [], inputs: [], execution: { name: 'triage', directory: work },
    }
  }

  it('a triage ready result leaves a silent notice and does not wake the desk a second time', async () => {
    const harness = rig()
    const ticket = triage('triage-ready')
    harness.store.triggers.save({
      trigger: {
        id: ticket.origin.triggerId, source: 'chat', kind: 'chat', at: '2026-11-14T02:00:00.000Z',
        actor: { id: 'alice', kind: 'person' }, text: '现在纽约天气怎么样', title: ticket.title,
        replyTo: { kind: 'chat', channel: 'ops' },
      },
      disposition: { state: 'accepted', ticketId: ticket.id, decisionId: 'decision-triage' },
    })
    harness.store.tickets.save(ticket)

    harness.delivery.report(ticket, { state: 'ready', summary: '直接回答了请求者。', at: '2026-11-14T02:01:00.000Z' })
    await harness.runDue()

    expect(harness.relays, '分诊单结案后绝不能有新的 relay 唤醒总管').toEqual([])
    expect(harness.notices).toHaveLength(1)
    expect(harness.notices[0]!).toContain('直接回答了请求者。')
  })

  it('a triage failed report does not wake the desk again, so a failing desk cannot echo itself', async () => {
    const harness = rig()
    const ticket = triage('triage-failed')
    harness.store.triggers.save({
      trigger: {
        id: ticket.origin.triggerId, source: 'chat', kind: 'chat', at: '2026-11-14T02:00:00.000Z',
        actor: { id: 'alice', kind: 'person' }, text: '这条请求会让总管失败', title: ticket.title,
        replyTo: { kind: 'chat', channel: 'ops' },
      },
      disposition: { state: 'accepted', ticketId: ticket.id, decisionId: 'decision-triage' },
    })
    harness.store.tickets.save(ticket)

    harness.delivery.report(ticket, { state: 'failed', summary: "Desk LLM ended with reason 'error'.", at: '2026-11-14T02:01:00.000Z' })
    await harness.runDue()

    expect(harness.relays, '分诊票的 failed 报告不能反向 relay 唤醒总管').toEqual([])
    // 失败本身仍要留给操作者看，不是被吞掉：通知仍在（历史里），RESULT.md 仍写。
    expect(harness.notices).toHaveLength(1)
    expect(readFileSync(join(ticket.execution!.directory, 'RESULT.md'), 'utf8')).toContain("Desk LLM ended with reason 'error'.")
  })

  it('an ordinary worker Ticket still wakes the desk when it fails', async () => {
    const harness = rig()
    const ticket = harness.live('worker-failed')
    harness.delivery.report(ticket, { state: 'failed', summary: 'worker failed', at: '2026-11-14T02:01:00.000Z' })
    await harness.runDue()
    expect(harness.relays.length).toBeGreaterThan(0)
    expect(harness.relays[0]!).toContain('worker failed')
  })
})
