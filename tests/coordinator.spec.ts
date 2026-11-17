/**
 * The coordinator tools and loop: the model chooses actions, the program performs and verifies them.
 * Every tool gets a positive and a negative case; the loop is exercised with a scripted model.
 */
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine, Memory, parseSettings, settingsPolicy, type Delivery, type Executor, type Report, type Ticket } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { Conversations } from '../src/app/conversations.ts'
import { COORDINATOR_TOOLS, executeCoordinatorTool, runCoordinatorTurn, type CoordinatorHost } from '../src/app/coordinator.ts'
import type { DeskMessage } from '../src/app/desk-history.ts'
import { deskLlmGenerate, type LlmToolSchema } from '../src/desk/llm.ts'
import { tempDir } from './helpers/temp.ts'

class FakeExecutor implements Executor {
  engine?: Engine
  readonly started: string[] = []
  readonly dispatched: Ticket[] = []
  prepare(ticket: Ticket): Ticket { return { ...ticket, execution: { name: ticket.id, directory: `/tmp/work/${ticket.id}` } } }
  start(ticket: Ticket, assignment: { id: string }): void { this.dispatched.push(ticket); this.started.push(ticket.id); this.engine?.assignmentStarted(ticket.id, assignment.id) }
  deliver(): void {}
  stop(): void {}
}

function harness() {
  const store = new Store(join(tempDir('ordin-coord-'), 'coord.sqlite3'))
  store.conversations.save({ id: 'conv-1', profileId: 'default', createdAt: '2026-01-01', lastMessageAt: '2026-01-01' })
  const executor = new FakeExecutor()
  const sent: string[] = []
  const engine = new Engine({
    repos: store, tx: store, inputConsumptions: store.inputConsumptions,
    policy: () => settingsPolicy(parseSettings({ acceptMode: 'auto', allowedSenders: ['operator'] })),
    executor,
    delivery: { report: (_ticket: Ticket, _report: Report): void => {} } as Delivery,
  })
  executor.engine = engine
  const scripted: { text: string; toolCalls: { id: string; name: string; arguments: string }[] }[] = []
  let stopTaskImpl: CoordinatorHost['stopTask'] = async (ticketId, reason) => {
    try {
      const stopped = engine.stopTicket(ticketId, reason)
      return { stopped: stopped.ended?.outcome === 'stopped', finalState: stopped.ended?.outcome }
    } catch (error) {
      return { stopped: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  const host: CoordinatorHost = {
    engine, store,
    send: async text => { sent.push(text) },
    complete: async () => scripted.shift() ?? { text: '(no script)', toolCalls: [] },
    workRoot: () => '/tmp/work',
    get stopTask() { return stopTaskImpl },
  }
  return { store, engine, executor, host, sent, scripted, setStopTask: (fn: CoordinatorHost['stopTask']) => { stopTaskImpl = fn } }
}

const tool = async (name: string, args: Record<string, unknown>, context: ReturnType<typeof harness>) =>
  await executeCoordinatorTool(name, JSON.stringify(args), context.host, 'conv-1', new AbortController().signal)

describe('coordinator tool schemas', () => {
  it('exposes the nine contract tools with names the model sees', () => {
    expect(COORDINATOR_TOOLS.map(t => t.name)).toEqual([
      'reply', 'search_assets', 'get_task_status', 'list_my_tasks', 'create_task',
      'add_task_input', 'cancel_or_pause_task', 'propose_memory', 'clarify',
    ])
    for (const schema of COORDINATOR_TOOLS) {
      expect(schema.description.length).toBeGreaterThan(10)
      expect(schema.parameters).toMatchObject({ type: 'object' })
    }
  })
})

describe('coordinator tools', () => {
  it('F3-D2 exposes durable usage and keeps missing costs unknown', async () => {
    const context = harness()
    const created = await tool('create_task', { title: 'usage', text: 'work' }, context)
    const ticketId = String(created.data?.ticketId)
    expect((await tool('get_task_status', { ticketId }, context)).data?.usage).toBeNull()
    const assignmentId = context.engine.require(ticketId).assignments[0]!.id
    context.engine.beginExecutionAttempt(ticketId, assignmentId, { token: 'usage', bootId: 'boot', host: 'host' })
    context.engine.recordExecutionUsage(ticketId, assignmentId, 'usage', { input: 8 })
    const status = await tool('get_task_status', { ticketId }, context)
    expect(status.data?.usage).toEqual(context.engine.require(ticketId).usage)
    expect(status.data?.usage).toMatchObject({ totals: { input: 8, knownCostUsd: 0, costComplete: false } })
    expect((status.data?.usage as Ticket['usage'])?.totals.costUsd).toBeUndefined()
  })
  it('reply sends text and creates no task', async () => {
    const context = harness()
    const outcome = await tool('reply', { text: '你好，我在。' }, context)
    expect(outcome.ok).toBe(true)
    expect(context.sent).toEqual(['你好，我在。'])
    expect(context.store.tickets.list()).toHaveLength(0)
  })

  it('clarify sends a question and creates no task', async () => {
    const context = harness()
    const outcome = await tool('clarify', { question: '你指哪一份报告？' }, context)
    expect(outcome.ok).toBe(true)
    expect(context.sent[0]).toContain('哪一份')
  })

  it('create_task goes through the gate and annotates plan and backend', async () => {
    const context = harness()
    const outcome = await tool('create_task', { title: '整理周报', text: '整理本周进展', plan: ['读数据', '写报告'], backend: 'codex', acceptance: '周报包含本周结果', estimatedBudgetMs: 60000 }, context)
    expect(outcome.ok).toBe(true)
    const ticketId = String(outcome.data?.ticketId)
    const ticket = context.store.tickets.get(ticketId)!
    expect(ticket.title).toBe('整理周报')
    expect(ticket.plan).toEqual(['读数据', '写报告'])
    expect(ticket.workerBackend).toBe('codex')
    expect(ticket.conversationId).toBe('conv-1')
    expect(context.executor.dispatched[0]).toMatchObject({ conversationId: 'conv-1', workerBackend: 'codex', plan: ['读数据', '写报告'], acceptanceCriteria: '周报包含本周结果', estimatedBudgetMs: 60000 })
  })

  it('rejects invalid acceptance and budgets before dispatch', async () => {
    const context = harness()
    for (const extra of [{ acceptance: '' }, { acceptance: 'x'.repeat(10001) }, { estimatedBudgetMs: 0 }, { estimatedBudgetMs: '1000' }]) {
      expect((await tool('create_task', { title: 'x', text: 'y', ...extra }, context)).ok).toBe(false)
    }
    expect(context.executor.started).toHaveLength(0)
    expect(context.store.tickets.list()).toHaveLength(0)
  })

  it('create_task refuses an unknown backend instead of dispatching it', async () => {
    const context = harness()
    const outcome = await tool('create_task', { title: 'x', text: 'y', backend: 'gpt-shell' }, context)
    expect(outcome.ok).toBe(false)
    expect(context.store.tickets.list()).toHaveLength(0)
  })

  it('get_task_status reads the persisted state, and refuses an unknown id', async () => {
    const context = harness()
    const created = await tool('create_task', { title: 't', text: 'x' }, context)
    const ticketId = String(created.data?.ticketId)
    context.engine.annotate(ticketId, {
      workerBackend: 'codex', workerSelectionReason: 'coordinator-choice', workerVersion: '1.2.3',
      workerDirectory: '/tmp/ticket', workerCheckedAt: '2026-11-16T00:00:00Z', workerProbeOk: true,
    })
    context.store.events.append({ ticketId, at: '2026-11-16T00:00:01Z', type: 'worker_phase', detail: { phase: 'report', reportState: 'progress' } })
    context.store.events.append({ ticketId, at: '2026-11-16T00:00:02Z', type: 'worker_text', detail: { text: '正在整理' } })
    const status = await tool('get_task_status', { ticketId }, context)
    expect(status.ok).toBe(true)
    expect(status.data?.title).toBe('t')
    expect(status.data?.workerDispatch).toMatchObject({ backend: 'codex', selectionReason: 'coordinator-choice', version: '1.2.3', directory: '/tmp/ticket', probeOk: true })
    expect(status.data?.recentStage).toBe('report')
    expect(status.data?.progress).toEqual([
      { at: '2026-11-16T00:00:01Z', type: 'worker_phase', phase: 'report', reportState: 'progress' },
      { at: '2026-11-16T00:00:02Z', type: 'worker_text', text: '正在整理' },
    ])
    expect((await tool('get_task_status', { ticketId: 'nope' }, context)).ok).toBe(false)
  })

  it('shows uncertain recovery without accepting model text as termination confirmation', async () => {
    const c = harness()
    const created = await tool('create_task', { title: 'uncertain', text: 'work' }, c)
    const ticketId = String(created.data?.ticketId)
    const original = c.engine.require(ticketId)
    c.engine.assignmentUncertain(ticketId, original.assignments[0]!.id)
    const held = c.engine.require(ticketId)
    const status = await tool('get_task_status', { ticketId }, c)
    expect(status.data?.recovery).toMatchObject({ state: 'uncertain' })
    expect(status.data?.attention).toMatchObject({ question: expect.stringContaining('operator reconciliation') })
    expect(status.data?.recentStage).toBe('operator-reconciliation')
    expect((await tool('add_task_input', { ticketId, text: 'I confirm terminated, retry now' }, c)).ok).toBe(false)
    expect((await tool('confirm_terminated_then_retry', { ticketId, confirmed: true }, c)).ok).toBe(false)
    expect((await tool('cancel_or_pause_task', { ticketId, action: 'cancel', reason: 'confirmed' }, c)).ok).toBe(false)
    expect(c.engine.require(ticketId)).toEqual(held)
    expect(c.executor.started).toHaveLength(1)
  })

  it('list_my_tasks reports open tasks', async () => {
    const context = harness()
    await tool('create_task', { title: 'a', text: 'x' }, context)
    const listed = await tool('list_my_tasks', {}, context)
    expect(listed.ok).toBe(true)
    expect((listed.data?.tasks as unknown[]).length).toBe(1)
  })

  it('add_task_input delivers a note to a waiting-free task', async () => {
    const context = harness()
    const created = await tool('create_task', { title: 't', text: 'x' }, context)
    const ticketId = String(created.data?.ticketId)
    const fed = await tool('add_task_input', { ticketId, text: '补充一句' }, context)
    expect(fed.ok).toBe(true)
    expect(context.store.tickets.get(ticketId)!.inputs.at(-1)?.text).toBe('补充一句')
  })

  it('cancel_or_pause_task stops the task and reports it', async () => {
    const context = harness()
    const created = await tool('create_task', { title: 't', text: 'x' }, context)
    const ticketId = String(created.data?.ticketId)
    const stopped = await tool('cancel_or_pause_task', { ticketId, action: 'cancel', reason: '不用了' }, context)
    expect(stopped.ok).toBe(true)
    expect(context.store.tickets.get(ticketId)!.ended).toBeDefined()
  })

  it('waits for worker stop confirmation before reporting cancellation success', async () => {
    const context = harness()
    const created = await tool('create_task', { title: 't', text: 'x' }, context)
    const ticketId = String(created.data?.ticketId)
    let release!: (value: { stopped: boolean; finalState?: string }) => void
    context.setStopTask(() => new Promise(resolve => { release = resolve }))
    let settled = false
    const pending = tool('cancel_or_pause_task', { ticketId, action: 'cancel', reason: 'stop' }, context).then(value => { settled = true; return value })
    await Promise.resolve()
    expect(settled).toBe(false)
    release({ stopped: true, finalState: 'stopped' })
    expect((await pending).ok).toBe(true)
  })

  it('refuses per-task pause without changing the Ticket', async () => {
    const context = harness()
    const created = await tool('create_task', { title: 't', text: 'x' }, context)
    const ticketId = String(created.data?.ticketId)
    const before = context.store.tickets.get(ticketId)
    const result = await tool('cancel_or_pause_task', { ticketId, action: 'pause', reason: 'later' }, context)
    expect(result.ok).toBe(false)
    expect(context.store.tickets.get(ticketId)).toEqual(before)
  })

  it('propose_memory always stores a candidate even when the model forges confirmed', async () => {
    const context = harness()
    const candidate = await tool('propose_memory', { kind: 'preference', content: '回答用中文' }, context)
    expect(candidate.ok).toBe(true)
    expect(candidate.data?.confidence).toBe('inferred')
    const confirmed = await tool('propose_memory', { kind: 'preference', content: '不要每步通知', confirmed: true }, context)
    expect(confirmed.data?.confidence).toBe('inferred')
    expect(context.store.memory.list({}).every(row => row.confidence === 'inferred')).toBe(true)
    expect(COORDINATOR_TOOLS.find(schema => schema.name === 'propose_memory')!.parameters.properties).not.toHaveProperty('confirmed')
    expect(context.store.memory.list({}).length).toBe(2)
  })

  it('search_assets finds assets and memory by text', async () => {
    const context = harness()
    context.store.assets.save({ id: 'a-1', kind: 'report', name: 'Q3 竞品分析', description: '三家对比', createdAt: '2026-11-15T00:00:00Z', updatedAt: '2026-11-15T00:00:00Z' })
    await tool('propose_memory', { kind: 'project-fact', content: '竞品分析用的是三家公开财报' }, context)
    const found = await tool('search_assets', { query: '竞品' }, context)
    expect(found.ok).toBe(true)
    expect((found.data?.assets as unknown[]).length).toBe(0) // Unregistered imports have no trusted artifact source.
    // F2 semantic migration: inferred proposals remain management-only until explicit operator confirmation.
    expect((found.data?.memory as unknown[]).length).toBe(0)
  })

  it('rejects unknown tools and malformed arguments loudly', async () => {
    const context = harness()
    expect((await tool('rm_rf', {}, context)).ok).toBe(false)
    const bad = await executeCoordinatorTool('reply', '{not json', context.host, 'conv-1', new AbortController().signal)
    expect(bad.ok).toBe(false)
    const missing = await executeCoordinatorTool('create_task', '{}', context.host, 'conv-1', new AbortController().signal)
    expect(missing.ok).toBe(false)
  })
})

describe('standing context', () => {
  it('puts the long-term memory and open tasks into the system message the model sees', async () => {
    const context = harness()
    context.store.memory.save({ id: 'mem-1', kind: 'preference', scope: 'global', content: '回答用中文', createdAt: '2026-11-15T00:00:00Z', updatedAt: '2026-11-15T00:00:00Z', confidence: 'confirmed', useCount: 0 })
    await tool('create_task', { title: '整理周报', text: 'x' }, context)
    const seen: DeskMessage[][] = []
    const hostWithCapture: CoordinatorHost = {
      ...context.host,
      complete: async messages => { seen.push([...messages]); return { text: '好', toolCalls: [] } },
    }
    await runCoordinatorTurn(hostWithCapture, 'conv-1', '在吗', new AbortController().signal)
    const system = seen[0]!.find(message => message.role === 'system')!
    expect(system.content).toContain('回答用中文')
    expect(system.content).toContain('整理周报')
    expect(system.content).toContain('未结束的任务')
  })

  it('keeps a system message even when there is no memory and no task', async () => {
    const context = harness()
    const seen: DeskMessage[][] = []
    const hostWithCapture: CoordinatorHost = {
      ...context.host,
      complete: async messages => { seen.push([...messages]); return { text: '好', toolCalls: [] } },
    }
    await runCoordinatorTurn(hostWithCapture, 'conv-1', '你好', new AbortController().signal)
    const system = seen[0]!.find(message => message.role === 'system')!
    expect(system.content).toContain('你是 Ordin')
  })
})
describe('coordinator loop', () => {
  it('answers directly when the model calls no tool', async () => {
    const context = harness()
    context.scripted.push({ text: '今天想聊点什么？', toolCalls: [] })
    const result = await runCoordinatorTurn(context.host, 'conv-1', '在吗', new AbortController().signal)
    expect(result.reply).toBe('今天想聊点什么？')
    expect(context.store.tickets.list()).toHaveLength(0)
  })

  it('creates a task, then answers with the real ticket id', async () => {
    const context = harness()
    context.scripted.push({
      text: '',
      toolCalls: [{ id: 'call-1', name: 'create_task', arguments: JSON.stringify({ title: '调研', text: '调研三家竞品' }) }],
    })
    context.scripted.push({ text: '已经安排好了，我会把结果发回这里。', toolCalls: [] })
    const result = await runCoordinatorTurn(context.host, 'conv-1', '帮我调研三家竞品', new AbortController().signal)
    expect(result.toolOutcomes).toHaveLength(1)
    expect(result.toolOutcomes[0]!.ok).toBe(true)
    expect(result.reply).toContain('安排')
    expect(context.store.tickets.list()).toHaveLength(1)
  })

  it('keeps the conversation history so a follow-up sees the earlier turn', async () => {
    const context = harness()
    context.scripted.push({ text: '好的', toolCalls: [] })
    await runCoordinatorTurn(context.host, 'conv-1', '第一句', new AbortController().signal)
    const rows = context.store.conversationMessages.list('conv-1')
    expect(rows.map(row => row.role)).toEqual(['user', 'ordin'])
    expect(rows[0]!.content).toBe('第一句')
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const signal = () => new AbortController().signal
const finalAnswer = (text: string) => ({ text, toolCalls: [] })

describe('F4-S3 conversation lifecycle integration', () => {
  it.each(['final', 'tools'])('fences a deleted conversation after deferred model completion (%s)', async kind => {
    const c = harness(); const conversations = new Conversations(c.store); const row = conversations.create()
    const entered = deferred<void>(); const answer = deferred<{ text: string; toolCalls: { id: string; name: string; arguments: string }[] }>()
    const host: CoordinatorHost = { ...c.host, complete: async () => { entered.resolve(); return answer.promise } }
    const turn = runCoordinatorTurn(host, row.id, 'start', signal()).catch(error => error)
    await entered.promise; conversations.delete(row.id, row.revision)
    answer.resolve(kind === 'final' ? finalAnswer('must not send') : { text: 'must not send', toolCalls: [{ id: 'create', name: 'create_task', arguments: JSON.stringify({ title: 'must not create', text: 'work' }) }] })
    expect((await turn).message).toMatch(/deleted/)
    expect(c.store.tickets.list()).toEqual([]); expect(c.sent).toEqual([])
    expect(c.store.conversationMessages.list(row.id).map(m => m.content)).toEqual(['start'])
  })
  it('preserves renamed metadata through model completion and isolates fresh context from old tasks/history', async () => {
    const c = harness(); const conversations = new Conversations(c.store)
    const old = conversations.create(); const fresh = conversations.create()
    const named = conversations.rename(fresh.id, 'Fresh title', fresh.revision)
    await executeCoordinatorTool('create_task', JSON.stringify({ title: 'OLD TASK SECRET', text: 'old work' }), c.host, old.id, signal())
    c.store.conversationMessages.append({ id: 'old-secret', conversationId: old.id, role: 'user', content: 'OLD HISTORY SECRET', at: old.createdAt })
    const host: CoordinatorHost = { ...c.host, complete: async history => {
      expect(JSON.stringify(history)).not.toContain('OLD TASK SECRET'); expect(JSON.stringify(history)).not.toContain('OLD HISTORY SECRET')
      return finalAnswer('fresh answer')
    } }
    await runCoordinatorTurn(host, fresh.id, 'fresh input', signal())
    expect(conversations.get(fresh.id)).toMatchObject({ title: 'Fresh title', revision: named.revision, createdAt: fresh.createdAt })
    expect(conversations.messages(fresh.id).messages.map(m => m.content)).toEqual(['fresh input', 'fresh answer'])
  })
})

describe('F1-R1 coordinator regressions', () => {
  it.each(['', 'Checking'])('pairs multiple tool results with their assistant request (text=%j)', async text => {
    const c = harness()
    const calls = [
      { id: 'lookup', name: 'list_my_tasks', arguments: '{}' },
      { id: 'missing', name: 'get_task_status', arguments: '{"ticketId":"missing"}' },
    ]
    let count = 0
    const host: CoordinatorHost = { ...c.host, complete: async messages => {
      if (count++ === 0) return { text, toolCalls: calls }
      const request = messages.findIndex(message => message.tool_calls !== undefined)
      expect(request).toBeGreaterThan(0)
      expect(messages[request]).toMatchObject({ role: 'assistant', content: text, tool_calls: calls })
      expect(messages.slice(request + 1).map(message => [message.role, message.tool_call_id])).toEqual([['tool', 'lookup'], ['tool', 'missing']])
      expect(JSON.parse(messages[request + 2]!.content).ok).toBe(false)
      return finalAnswer('Done reading')
    } }
    expect((await runCoordinatorTurn(host, 'tools', 'look up', signal())).rounds).toBe(2)
  })

  it('uses latest history including current input, preserving creation and collision-free UUID ids', async () => {
    const c = harness()
    const at = '2020-01-01T00:00:00.000Z'
    c.store.conversations.save({ id: 'history', profileId: 'default', createdAt: at, lastMessageAt: at })
    for (let n = 0; n < 35; n++) c.store.conversationMessages.append({ id: 'old-' + n, conversationId: 'history', at, role: n % 2 ? 'ordin' : 'user', content: 'old ' + n })
    const seen: string[][] = []
    const host: CoordinatorHost = { ...c.host, complete: async messages => { seen.push(messages.slice(1).map(m => m.content)); return finalAnswer('answer') } }
    const clock = vi.spyOn(Date, 'now').mockReturnValue(12345)
    try {
      await runCoordinatorTurn(host, 'history', 'new one', signal(), { historyLimit: 3 })
      await runCoordinatorTurn(host, 'history', 'new two', signal(), { historyLimit: 3 })
    } finally { clock.mockRestore() }
    expect(seen).toEqual([['old 33', 'old 34', 'new one'], ['new one', 'answer', 'new two']])
    expect(c.store.conversations.get('history')?.createdAt).toBe(at)
    const added = c.store.conversationMessages.list('history').slice(35)
    expect(added.map(m => m.content)).toEqual(['new one', 'answer', 'new two', 'answer'])
    for (const message of added) expect(message.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  it('serializes same-store conversation hosts through send, while other conversations progress', async () => {
    const c = harness()
    const entered = deferred<void>()
    const delivery = deferred<void>()
    const secondSeen: string[][] = []
    const firstHost: CoordinatorHost = { ...c.host, complete: async () => finalAnswer('first answer'), send: async () => { entered.resolve(); await delivery.promise } }
    const first = runCoordinatorTurn(firstHost, 'same', 'first', signal())
    await entered.promise
    const secondHost: CoordinatorHost = { ...c.host, complete: async messages => { secondSeen.push(messages.slice(1).map(m => m.content)); return finalAnswer('second answer') } }
    const second = runCoordinatorTurn(secondHost, 'same', 'second', signal())
    try {
      await runCoordinatorTurn(secondHost, 'other', 'parallel', signal())
      expect(c.store.conversationMessages.list('same').map(m => m.content)).toEqual(['first', 'first answer'])
      expect(secondSeen).toEqual([['parallel']])
    } finally { delivery.resolve(); await Promise.all([first, second]) }
    expect(secondSeen[1]).toEqual(['first', 'first answer', 'second'])
    expect(c.store.conversationMessages.list('same').map(m => m.content)).toEqual(['first', 'first answer', 'second', 'second answer'])
  })

  it('releases rejected predecessors and aborts queued input before any write', async () => {
    const c = harness()
    const entered = deferred<void>()
    const blocked = deferred<{ text: string; toolCalls: [] }>()
    const firstHost: CoordinatorHost = { ...c.host, complete: async () => { entered.resolve(); return blocked.promise } }
    const first = runCoordinatorTurn(firstHost, 'queue', 'first', signal()).catch(error => error)
    await entered.promise
    const abort = new AbortController()
    const skipped = runCoordinatorTurn(c.host, 'queue', 'must not persist', abort.signal).catch(error => error)
    const last = runCoordinatorTurn(c.host, 'queue', 'last', signal())
    abort.abort(new Error('queued abort'))
    blocked.reject(new Error('model failed'))
    expect((await first).message).toBe('model failed')
    expect((await skipped).message).toBe('queued abort')
    await last
    expect(c.store.conversationMessages.list('queue').map(m => m.content)).toEqual(['first', 'last', '(no script)'])
    await runCoordinatorTurn(c.host, 'queue', 'after cleanup', signal())
    expect(c.store.conversationMessages.list('queue').at(-2)?.content).toBe('after cleanup')
  })

  it('counts exactly the bounded calls and never claims completion on tool-only exhaustion', async () => {
    const c = harness()
    let count = 0
    const host: CoordinatorHost = { ...c.host, complete: async () => { count++; return { text: '', toolCalls: [{ id: 'read-' + count, name: 'list_my_tasks', arguments: '{}' }] } } }
    const result = await runCoordinatorTurn(host, 'bounded', 'read', signal(), { maxRounds: 2 })
    expect(result.rounds).toBe(2)
    expect(count).toBe(2)
    expect(result.reply).toContain('轮次上限')
    expect(result.reply).not.toBe('已完成。')
    expect(c.sent.at(-1)).toBe(result.reply)
    const zero = await runCoordinatorTurn(host, 'zero', 'read', signal(), { maxRounds: 0 })
    expect(zero.rounds).toBe(0)
    expect(count).toBe(2)
    expect(zero.reply).toContain('轮次上限')
  })

  it('does not infer success from a successful tool when the final model answer is empty', async () => {
    const c = harness()
    c.scripted.push({ text: '', toolCalls: [{ id: 'read', name: 'list_my_tasks', arguments: '{}' }] }, finalAnswer(''))
    const result = await runCoordinatorTurn(c.host, 'empty', 'read', signal())
    expect(result.rounds).toBe(2)
    expect(result.reply).not.toBe('已完成。')
  })
})

it('serializes coordinator tool exchanges through deskLlmGenerate for a strict provider', async () => {
  const c = harness()
  let requests = 0
  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string | null; tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }[] }
    const pending = new Set<string>()
    for (const message of body.messages) {
      if (message.role === 'tool') {
        expect(pending.delete(message.tool_call_id!)).toBe(true)
      } else {
        expect(pending.size).toBe(0)
        for (const call of message.tool_calls ?? []) {
          expect(call.type).toBe('function')
          expect(call.function.name).toBe('list_my_tasks')
          pending.add(call.id)
        }
      }
    }
    expect(pending.size).toBe(0)
    const delta = requests++ === 0
      ? { tool_calls: [{ index: 0, id: 'strict-call', type: 'function', function: { name: 'list_my_tasks', arguments: '{}' } }] }
      : { content: 'Read complete' }
    const chunk = { choices: [{ delta, finish_reason: requests === 1 ? 'tool_calls' : 'stop' }] }
    return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }
  const host: CoordinatorHost = { ...c.host, complete: (history, tools, abort) => deskLlmGenerate({ baseUrl: 'https://strict.invalid/v1', model: 'test', fetchFn }, history, tools, abort) }
  const result = await runCoordinatorTurn(host, 'strict', 'read tasks', signal())
  expect(requests).toBe(2)
  expect(result.reply).toBe('Read complete')
  expect(c.store.conversationMessages.list('strict').map(m => m.role)).toEqual(['user', 'ordin'])
})

it.each([NaN, Infinity, -1, 1.5])('rejects an invalid round bound %s before writing input', async maxRounds => {
  const c = harness()
  await expect(runCoordinatorTurn(c.host, 'invalid', 'must not persist', signal(), { maxRounds })).rejects.toThrow('maxRounds')
  expect(c.store.conversationMessages.list('invalid')).toEqual([])
  expect(c.store.conversations.get('invalid')).toBeUndefined()
})

it('rejects an already aborted turn without creating the conversation', async () => {
  const c = harness()
  const abort = new AbortController()
  abort.abort(new Error('already aborted'))
  await expect(runCoordinatorTurn(c.host, 'aborted', 'skip', abort.signal)).rejects.toThrow('already aborted')
  expect(c.store.conversationMessages.list('aborted')).toEqual([])
  expect(c.store.conversations.get('aborted')).toBeUndefined()
})
