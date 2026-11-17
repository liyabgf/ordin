import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { Engine, parseSettings, settingsPolicy, type Executor, type Delivery, type Ticket } from '../src/core/index.ts'
import { executeCoordinatorTool, runCoordinatorTurn, buildSystemContext, type CoordinatorHost } from '../src/app/coordinator.ts'
import { Memories } from '../src/app/memories.ts'
import { tempDir } from './helpers/temp.ts'

function fixture() {
  const store = new Store(join(tempDir('ordin-profile-'), 'state.sqlite3'))
  for (const [id, profileId] of [['here', 'default'], ['other', 'default'], ['foreign', 'someone-else']]) store.conversations.save({ id: id!, profileId: profileId!, createdAt: 'now', lastMessageAt: 'now' })
  const executor: Executor = { prepare: t => ({ ...t, execution: { name: t.id, directory: '/tmp/work/' + t.id } }), start() {}, deliver() {}, stop() {} }
  const engine = new Engine({ repos: store, tx: store, inputConsumptions: store.inputConsumptions, policy: () => settingsPolicy(parseSettings({ acceptMode: 'auto', allowedSenders: ['operator'] })), executor, delivery: { report() {} } as Delivery })
  const send = vi.fn(async () => {})
  const stopTask = vi.fn(async () => ({ stopped: true }))
  const complete = vi.fn(async () => ({ text: 'answer', toolCalls: [] }))
  const host: CoordinatorHost = { engine, store, send, stopTask, complete, workRoot: () => '/tmp/work' }
  const call = (name: string, args: Record<string, unknown> = {}, conversationId = 'here') => executeCoordinatorTool(name, JSON.stringify(args), host, conversationId, new AbortController().signal)
  const task = (conversationId?: string) => engine.createTicket({ title: 'secret-' + (conversationId ?? 'legacy'), text: 'work', ...(conversationId === undefined ? {} : { conversationId }) }).ticketId!
  return { store, engine, host, send, stopTask, complete, call, task }
}

it('shares default Profile tasks across conversations and retains legacy local access', async () => {
  const c = fixture()
  for (const id of [c.task('other'), c.task()]) {
    expect((await c.call('get_task_status', { ticketId: id })).ok).toBe(true)
    expect((await c.call('add_task_input', { ticketId: id, text: 'note' })).ok).toBe(true)
    expect((await c.call('cancel_or_pause_task', { ticketId: id, action: 'cancel', reason: 'stop' })).ok).toBe(true)
  }
  expect((await c.call('list_my_tasks')).data?.tasks).toHaveLength(2)
})

it('denies foreign and orphan tasks consistently without mutations or source leakage', async () => {
  const c = fixture()
  for (const conversation of ['foreign', 'missing']) {
    const id = c.task(conversation)
    const before = c.store.tickets.get(id)
    for (const [name, args] of [ ['get_task_status', { ticketId: id }], ['add_task_input', { ticketId: id, text: 'bad' }], ['cancel_or_pause_task', { ticketId: id, action: 'cancel', reason: 'bad' }], ['propose_memory', { kind: 'task-lesson', content: 'secret', sourceTicketId: id }] ] as const) expect((await c.call(name, args)).ok).toBe(false)
    expect(c.store.tickets.get(id)).toEqual(before)
  }
  expect(c.stopTask).not.toHaveBeenCalled()
  expect(c.store.memory.list({})).toEqual([])
  expect((await c.call('list_my_tasks')).data?.tasks).toEqual([])
  expect(buildSystemContext(c.host, 'here').content).not.toContain('secret-')
})

it('rejects foreign turns and foreign or absent tool contexts before side effects', async () => {
  const c = fixture()
  await expect(runCoordinatorTurn(c.host, 'foreign', 'intrusion', new AbortController().signal)).rejects.toThrow(/access|profile/i)
  for (const id of ['foreign', 'missing']) expect((await c.call('reply', { text: 'bad' }, id)).ok).toBe(false)
  expect(c.store.conversationMessages.list('foreign')).toEqual([])
  expect(c.complete).not.toHaveBeenCalled()
  expect(c.send).not.toHaveBeenCalled()
})

it('refuses entire tasks for missing, external, traversing, unregistered and foreign asset refs', async () => {
  const c = fixture()
  const owned = c.task('other'), foreign = c.task('foreign')
  const register = (id: string, ticketId: string, path: string) => c.store.assets.save({ id, kind: 'report', name: 'needle', source: { ticketId, path }, createdAt: 'now', updatedAt: 'now' })
  register('absolute', owned, '/etc/passwd'); register('escape', owned, '../secret'); register('unregistered', owned, 'fake.txt'); register('foreign', foreign, 'out.txt')
  c.store.tickets.save({ ...c.store.tickets.get(foreign)!, result: { at: 'now', summary: 'done', files: ['out.txt'] } })
  const count = c.store.tickets.list().length
  for (const id of ['missing', 'absolute', 'escape', 'unregistered', 'foreign']) expect((await c.call('create_task', { title: 'bad', text: 'bad', assetRefs: [id] })).ok).toBe(false)
  expect(c.store.tickets.list()).toHaveLength(count)
  expect((await c.call('search_assets', { query: 'needle' })).data?.assets).toEqual([])
  c.engine.assignmentStarted(owned, c.store.tickets.get(owned)!.assignments[0]!.id)
  c.engine.report(owned, { state: 'ready', summary: 'done', files: ['reports/out.txt'] })
  register('good', owned, 'reports/out.txt')
  const result = await c.call('create_task', { title: 'good', text: 'good', assetRefs: ['good'] })
  expect(result.ok).toBe(true)
  expect(c.store.tickets.get(String(result.data?.ticketId))?.attachments).toEqual([expect.objectContaining({ source: '/tmp/work/' + owned + '/reports/out.txt' })])
})

it('restricts scoped memory to explicit same owned Work evidence and filters retrieval and context', async () => {
  const c = fixture()
  const id = c.task('here')
  c.store.works.save({ id: 'known', name: 'work', createdAt: 'now' })
  c.engine.attachWork(id, 'known')
  const proposed = await c.call('propose_memory', { kind: 'project-fact', content: 'needle owned', scope: 'known', sourceTicketId: id, confirmed: true })
  expect(proposed.ok).toBe(true)
  const memoryId = String(proposed.data?.memoryId)
  // F2 semantic migration: model confirmation flags never authorize context injection.
  expect(c.store.memory.get(memoryId)?.confidence).toBe('inferred')
  expect((await c.call('search_assets', { query: 'needle' })).data?.memory).toEqual([])
  expect(buildSystemContext(c.host, 'here').content).not.toContain('needle owned')
  const confirmed = new Memories(c.store).confirm(memoryId, {})
  expect(confirmed).toMatchObject({ confidence: 'confirmed', confirmation: { actor: 'operator', at: expect.any(String) } })
  for (const scope of ['unknown', 'project:made-up']) expect((await c.call('propose_memory', { kind: 'project-fact', content: 'needle bad', scope })).ok).toBe(false)
  c.store.memory.save({ id: 'hidden', kind: 'project-fact', scope: 'unknown', content: 'needle hidden', createdAt: 'now', updatedAt: 'now' })
  c.store.memory.save({ id: 'bad-source', kind: 'task-lesson', scope: 'global', sourceTicketId: c.task('foreign'), content: 'needle foreign', createdAt: 'now', updatedAt: 'now' })
  expect((await c.call('search_assets', { query: 'needle' })).data?.memory).toHaveLength(1)
  expect(buildSystemContext(c.host, 'here').content).toContain('needle owned')
  expect(buildSystemContext(c.host, 'other').content).not.toContain('needle owned')
  expect(buildSystemContext(c.host, 'here').content).not.toContain('needle foreign')
  expect(c.store.memory.get(memoryId)).toMatchObject({ confidence: 'confirmed', audit: expect.arrayContaining([expect.objectContaining({ action: 'confirm', actor: 'operator' })]) })
})
