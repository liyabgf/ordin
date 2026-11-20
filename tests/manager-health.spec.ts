import { expect, it, vi } from 'vitest'
import { WorkerConnections } from '../src/app/worker-connections.ts'
import { deskLlmGenerate } from '../src/desk/llm.ts'
import { boot } from '../src/app/boot.ts'
import { resolveConfig } from '../src/app/config.ts'
import { Conversations } from '../src/app/conversations.ts'
import { silentLogger } from '../src/app/logger.ts'
import { inspectManagerHealth } from '../src/app/manager-health.ts'
import { ProcessRegistry } from '../src/app/process.ts'
import { createRuntime } from '../src/app/runtime.ts'
import { tempDir } from './helpers/temp.ts'
import type { DriverHealth } from '../src/drivers/types.ts'

vi.mock('../src/desk/llm.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/desk/llm.ts')>(), deskLlmGenerate: vi.fn() }))

function runtimeFixture() {
  const stateDir = tempDir('ordin-manager-health-')
  const config = resolveConfig({ stateDir, workRoot: stateDir + '/work', inboxDir: stateDir + '/inbox', port: 0 })
  const driver = {
    backend: 'dsh' as const,
    probe: vi.fn(async (): Promise<DriverHealth> => ({ backend: 'dsh', ok: true, checkedAt: new Date().toISOString(), auth: 'ok', problems: [] })),
    prepare: vi.fn(async () => { throw Error('not used') }),
    launch: vi.fn(async () => { throw Error('not used') }),
    resume: vi.fn(async () => { throw Error('not used') }),
  }
  const connections = new WorkerConnections(stateDir, () => driver)
  const reopen = () => createRuntime(boot({ config, logger: silentLogger() }), {
    logger: silentLogger(), driver, proc: new ProcessRegistry(), notifier: null, acceptanceEnabled: false, connections,
  })
  return { runtime: reopen(), reopen, driver }

}

it('distinguishes unknown, stale, fresh pass/fail, and exposes no raw probe diagnostics', async () => {
  const { runtime } = runtimeFixture()
  try {
    const { id: conversationId } = new Conversations(runtime.store).create()
    const now = Date.parse('2026-11-19T06:00:00.000Z')
    const base = { store: runtime.store, selected: 'dsh' as const, conversationId, now }
    const secret = 'https://user:password@localhost/?token=opaque /Users/private/work'
    const health = { backend: 'dsh', ok: false, checkedAt: '2026-11-19T06:00:00.000Z', auth: 'unknown', binary: secret,
      version: secret, problems: [secret], warnings: ['degraded_capability: ' + secret, secret] } satisfies DriverHealth
    expect(inspectManagerHealth({ ...base, health: null })).toMatchObject({ configuration: 'unknown', probe: { state: 'unknown', lastResult: null, freshness: 'unobserved' } })
    const failed = inspectManagerHealth({ ...base, health })
    expect(failed.probe).toEqual({ state: 'failed', lastResult: 'failed', observedAt: '2026-11-19T06:00:00.000Z', ageMs: 0,
      freshness: 'fresh', warnings: ['degraded-capability', 'other'] })
    expect(JSON.stringify(failed)).not.toMatch(/password|opaque|Users|localhost/)
    expect(inspectManagerHealth({ ...base, health: { ...health, ok: true }, now: now + 900_000 }).probe).toMatchObject({ state: 'passed', freshness: 'fresh', ageMs: 900_000 })
    expect(inspectManagerHealth({ ...base, health: { ...health, ok: true }, now: now + 900_001 }).probe).toMatchObject({ state: 'unknown', lastResult: 'passed', freshness: 'stale', ageMs: 900_001 })
    for (const invalid of [{ ...health, backend: 'codex' as const }, { ...health, checkedAt: 'invalid' }, { ...health, checkedAt: '2026-11-20T00:00:00Z' }]) {
      expect(inspectManagerHealth({ ...base, health: invalid }).probe).toMatchObject({ state: 'unknown', freshness: 'unobserved', ageMs: null })
    }
  } finally { await runtime.stop() }
})

it('reports only recent authorized receipts for the selected backend after reopening the Store', async () => {
  const fixture = runtimeFixture()
  let { runtime } = fixture
  try {
    const { id: conversationId } = new Conversations(runtime.store).create()
    const { id: otherId } = new Conversations(runtime.store).create()
    const now = Date.parse('2026-11-19T06:00:00.000Z')
    const at = new Date(now).toISOString()
    runtime.saveSettings({ acceptMode: 'auto' })
    let serial = 0
    const make = (options: { backend?: string; conversation?: string; owner?: string; deleted?: boolean; start?: string; role?: 'triage' }) => {
      const { ticketId: id } = runtime.engine.createTicket({ title: 'receipt-fixture', text: 'work ' + ++serial })
      if (id === undefined) throw new Error('ticket fixture was not created')
      const ticket = runtime.store.tickets.get(id)!
      runtime.store.tickets.save({ ...ticket, workerBackend: options.backend ?? 'dsh', conversationId: options.conversation ?? conversationId,
        ...(options.owner ? { ownerProfileId: options.owner } : {}), ...(options.deleted ? { deleted: { at, assets: 'delete' } } : {}),
        assignments: [{ id: id + '-assignment', createdAt: at, state: options.start ? 'ended' : 'pending', ...(options.start ? { startedAt: options.start, endedAt: options.start } : {}), ...(options.role ? { role: options.role } : {}) }],
        ...(options.start && options.role !== 'triage' ? { ended: { outcome: 'done', at, by: 'agent', reason: 'completed' } } : {}) })
      return id
    }
    const good = make({ start: at })
    make({ backend: 'claude', start: at })
    make({ conversation: otherId, start: at })
    make({ conversation: 'missing', start: at })
    make({ owner: 'foreign', start: at })
    make({ deleted: true, start: at })
    make({ start: '2026-11-01T06:00:00.000Z' })
    make({ start: at, role: 'triage' })
    const ticket = runtime.store.tickets.get(good)!
    runtime.store.tickets.save({ ...ticket, ended: { outcome: 'done', at, by: 'agent', reason: 'private /Users/path' } })
    await runtime.stop()
    runtime = fixture.reopen()
    const input = { store: runtime.store, selected: 'dsh' as const, health: null, conversationId, now }
    expect(inspectManagerHealth(input)).toMatchObject({ taskEvidence: 'recent-task-receipt', taskReceipts: [{ ticketId: good, observedAt: at, assignmentState: 'ended', outcome: 'done' }] })
    expect(inspectManagerHealth({ ...input, selected: 'codex' })).toMatchObject({ taskEvidence: 'unknown', taskReceipts: [] })
    expect(JSON.stringify(inspectManagerHealth(input))).not.toContain('/Users/path')
    expect(() => inspectManagerHealth({ ...input, conversationId: 'missing' })).toThrow(/default Profile/)
  } finally { await runtime.stop() }
})

it('inspects Runtime through the Coordinator without probing or exposing internal errors', async () => {
  const fixture = runtimeFixture()
  const { driver } = fixture
  let { runtime } = fixture
  const inspect = async () => {
    vi.mocked(deskLlmGenerate)
      .mockResolvedValueOnce({ text: '', finishReason: 'tool_calls', toolCalls: [{ name: 'inspect_runtime', id: 'inspect', arguments: '{}' }] })
      .mockResolvedValueOnce({ text: 'done', finishReason: 'stop', toolCalls: [] })
    return (await runtime.conversationTurn('health-check', '检查执行端')).toolOutcomes[0]
  }
  try {
    runtime.saveSettings({ deskLlm: { baseUrl: 'http://127.0.0.1:1/v1', model: 'mock' } })
    expect(await inspect()).toMatchObject({ ok: true, data: { backend: 'dsh', configuration: 'not-configured', probe: { state: 'unknown' } } })
    expect(driver.probe).not.toHaveBeenCalled()
    await runtime.saveWorkerConnection('dsh', { value: 'http://127.0.0.1:1/connect?token=fixture-secret', allowDshPermissions: true })
    await runtime.checkExecution()
    const outcome = await inspect()
    expect(outcome).toMatchObject({ ok: true, data: { backend: 'dsh', configuration: 'configured', probe: { state: 'passed' } } })
    expect(JSON.stringify(outcome)).not.toContain('fixture-secret')
    runtime.saveSettings({ ...runtime.settings(), executor: { backend: 'codex' } })
    expect(await inspect()).toMatchObject({ ok: true, data: { backend: 'codex', configuration: 'not-configured', probe: { state: 'unknown' } } })
    expect(driver.probe).toHaveBeenCalledTimes(2)
    expect(driver.launch).not.toHaveBeenCalled()
    await runtime.stop()
    runtime = fixture.reopen()
    runtime.saveSettings({ ...runtime.settings(), executor: { backend: 'dsh' } })
    expect(await inspect()).toMatchObject({ ok: true, data: { backend: 'dsh', configuration: 'configured', probe: { state: 'unknown', freshness: 'unobserved' } } })
    const originalList = runtime.store.tickets.list.bind(runtime.store.tickets)
    vi.spyOn(runtime.store.tickets, 'list').mockImplementationOnce(() => originalList()).mockImplementationOnce(() => { throw new Error('fixture-secret') })
    expect(await inspect()).toEqual({ name: 'inspect_runtime', ok: false, error: 'Runtime evidence unavailable' })
  } finally { await runtime.stop() }
})
