import { assetResultKey } from '../src/app/assets.ts'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { canRetry, ticketStage } from '../src/core/index.ts'
import { join as joinPath } from 'node:path'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { boot } from '../src/app/boot.ts'
import { resolveConfig } from '../src/app/config.ts'
import { silentLogger } from '../src/app/logger.ts'
import { ProcessRegistry } from '../src/app/process.ts'
import { createRuntime } from '../src/app/runtime.ts'
import { TurnChannel } from '../src/drivers/channel.ts'
import type { BackendSession, DriverHealth, LaunchSpec, RunningTurn, WorkerDriver, WorkerSpec } from '../src/drivers/types.ts'
import { tempDir } from './helpers/temp.ts'
import * as nodeFs from 'node:fs'

async function waitFor<T>(read: () => T | undefined, ms: number): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

class InstantDriver implements WorkerDriver {
  readonly backend = 'dsh' as const
  readonly launched: LaunchSpec[] = []
  constructor(private readonly releaseReport?: Promise<void>) {}
  async probe(): Promise<DriverHealth> {
    return { backend: 'dsh', ok: true, checkedAt: new Date().toISOString(), version: 'fake-1', auth: 'ok', problems: [] }
  }
  async prepare(spec: WorkerSpec): Promise<LaunchSpec> { return { ...spec, preparedAt: new Date().toISOString() } }
  async launch(spec: LaunchSpec): Promise<RunningTurn> { return await this.turn(spec) }
  async resume(_session: BackendSession, spec: LaunchSpec): Promise<RunningTurn> { return await this.turn(spec) }
  private async turn(spec: LaunchSpec): Promise<RunningTurn> {
    this.launched.push(spec)
    const channel = new TurnChannel()
    const session: BackendSession = { backend: 'dsh', id: `fake-session-${spec.ticketId}`, cwd: spec.cwd, savedAt: new Date().toISOString() }
    const done = (async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
      channel.push({ kind: 'started', at: new Date().toISOString(), session, pid: 123 })
      await this.releaseReport
      // The fake worker produces its claimed artifact, so M1-F has something real to register.
      try { mkdirSync(spec.cwd, { recursive: true }); writeFileSync(joinPath(spec.cwd, 'result.md'), '# 完成\n', 'utf8') } catch {}
      channel.push({ kind: 'report', at: new Date().toISOString(), report: { state: 'ready', summary: '任务完成', at: new Date().toISOString(), files: ['result.md'] } })
      const result = { status: 'completed' as const, text: '完成', session }
      channel.push({ kind: 'final', at: new Date().toISOString(), result })
      channel.close()
      return result
    })()
    return {
      id: `fake-turn-${spec.assignmentId}`, backend: 'dsh', events: channel.iterable,
      done,
      feed: async () => this.releaseReport === undefined
        ? { status: 'accepted' }
        : { status: 'queued-for-next-turn', reason: 'This backend cannot accept an input mid-turn' },
      cancel: async () => {},
    }
  }
}

function context(name: string, driver = new InstantDriver(), acceptanceEnabled = false) {
  const stateDir = tempDir(`ordin-runtime-${name}-`)
  const workRoot = join(stateDir, 'work')
  const inboxDir = join(stateDir, 'inbox')
  const config = resolveConfig({ stateDir, workRoot, inboxDir, port: 0 })
  const infrastructure = boot({ config, logger: silentLogger() })
  const proc = new ProcessRegistry()
  const runtime = createRuntime(infrastructure, { logger: silentLogger(), driver, proc, notifier: null, acceptanceEnabled })
  return { runtime, driver, inboxDir, stateDir }
}

describe('PANEL-6 persisted progress facts', () => {
  it('keeps only current assignment and attempt evidence through reopening, and projects no control token', async () => {
    const { runtime: initial, stateDir, inboxDir, driver } = context('panel-progress')
    let runtime = initial
    try {
      await runtime.start()
      runtime.saveSettings({ acceptMode: 'auto' })
      runtime.engine.createTicket({ title: 'progress fixture', text: 'fixture' })
      runtime.saveSettings({ paused: true })
      const t = runtime.store.tickets.list().find(t => t.title === 'progress fixture')!
      const assignment = t.assignments.at(-1)!
      const token = 'internal-control-token'
      runtime.engine.beginExecutionAttempt(t.id, assignment.id, { token, bootId: 'fixture', host: 'fixture' })
      runtime.engine.executionAttemptStarted(t.id, assignment.id, token)
      const add = (type: any, detail: any, at = '2026-01-01T00:00:00Z') => runtime.store.events.append({ticketId:t.id,type,at,detail})
      add('worker_text', {assignmentId:'old-assignment',text:'OLD ASSIGNMENT'})
      add('worker_text', {assignmentId:assignment.id,attemptId:'old-attempt',text:'OLD ATTEMPT'})
      add('worker_phase', {assignmentId:assignment.id,attemptId:token,phase:'started',backend:'dsh',connectionId:'00000000-0000-4000-8000-000000000001'})
      add('worker_text', {assignmentId:assignment.id,attemptId:token,text:'CURRENT'})
      add('worker_tool', {assignmentId:assignment.id,attemptId:token,name:'read_file'}, '2026-01-01T00:00:01Z')
      expect(runtime.progress(t.id)).toMatchObject({ executionState:'running', lastSaid:'CURRENT', backend:'dsh', connectionId:'00000000-0000-4000-8000-000000000001', lastEventAt:'2026-01-01T00:00:01Z', lastEvent:{type:'worker_tool'}, recentTools:[{name:'read_file'}] })
      const headers = {'x-ordin-request':'1'}
      const base = runtime.status().panel + 'api/tickets/' + t.id
      const detail = await (await fetch(base, {headers})).json()
      const progress = await (await fetch(base + '/progress', {headers})).json()
      const events = await (await fetch(base + '/events', {headers})).json()
      expect(detail.executionFingerprint).toMatch(/^[0-9a-f]{64}$/)
      expect(progress.executionFingerprint).toBe(detail.executionFingerprint)
      expect(JSON.stringify({detail,progress,events})).not.toContain(token)
      expect(events.events.some((e:any) => e.detail?.attemptId)).toBe(false)
      runtime.engine.endExecutionAttempt(t.id, assignment.id, token)
      runtime.engine.beginExecutionAttempt(t.id, assignment.id, {token:'new-token',bootId:'fixture',host:'fixture'})
      expect(runtime.progress(t.id)).toMatchObject({loaded:false,recentTools:[]})
      expect(runtime.progress(t.id).lastSaid).toBeUndefined()
      add('worker_phase', {assignmentId:assignment.id,attemptId:'new-token',phase:'started',backend:'codex',connectionId:'00000000-0000-4000-8000-000000000002'})
      await runtime.stop()
      const config = resolveConfig({ stateDir, workRoot: join(stateDir, 'work'), inboxDir, port: 0 })
      runtime = createRuntime(boot({ config, logger: silentLogger() }), { logger: silentLogger(), driver, proc: new ProcessRegistry(), notifier: null, acceptanceEnabled: false })
      await runtime.start()
      expect(runtime.progress(t.id)).toMatchObject({executionState:'recovery',backend:'codex',connectionId:'00000000-0000-4000-8000-000000000002',recentTools:[]})
    } finally { await runtime.stop() }
  })
})

describe('F4-D1 scenario consumers', () => {
  it('routes conversation scenario, explicit selection, and main triage through the same endpoint and local credential', async () => {
    const { runtime, driver } = context('scenarios')
    const requests: { url: string; auth: string | null; body: Record<string, unknown> }[] = []
    const fakeFetch: typeof fetch = async (url, init) => {
      requests.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) })
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }
    vi.stubGlobal('fetch', fakeFetch)
    try {
      await runtime.saveModelConfig({ provider: 'stub', apiKeyEnv: '', baseUrl: 'http://stub.local/v1', model: 'global', models: ['global', 'talk', 'judge'], apiKey: 'LOCAL_TEST_KEY', temperature: 0.7, maxTokens: 1024 })
      runtime.saveSettings({ ...runtime.settings(), acceptMode: 'auto', triage: { enabled: true, desk: 'main', sources: ['inbox'] }, deskLlm: { ...runtime.settings().deskLlm, scenarios: { conversation: 'talk', triage: 'judge' } } })
      await runtime.conversationTurn('scenario-chat', 'hello')
      await runtime.conversationTurn('explicit-chat', 'hello', 'global')
      await expect(runtime.conversationTurn('bad-chat', 'hello', 'unknown')).rejects.toThrow(/saved model/)
      await runtime.start()
      const received = runtime.engine.receive({ id: 'scenario-inbox', source: 'inbox', kind: 'inbox', actor: { id: 'operator', kind: 'person' }, text: 'hello triage', title: 'triage', at: new Date().toISOString() })
      const ticketId = received.ticketId!
      await waitFor(() => runtime.store.tickets.get(ticketId)?.ended, 4000)
      await runtime.deskLoop!.relay('ordinary-relay', 'ordinary desk question')
      runtime.saveSettings({ ...runtime.settings(), deskLlm: { ...runtime.settings().deskLlm, scenarios: { conversation: '', triage: '' } } })
      await runtime.conversationTurn('fallback-chat', 'hello')
      expect(requests.map(r => r.body.model)).toEqual(['talk', 'global', 'judge', 'global', 'global'])
      for (const request of requests) {
        expect(request.url).toBe('http://stub.local/v1/chat/completions')
        expect(request.auth).toBe('Bearer LOCAL_TEST_KEY')
        expect(request.body).toMatchObject({ temperature: 0.7, max_tokens: 1024 })
      }
      expect(runtime.settings().deskLlm.model).toBe('global')
      expect(driver.launched).toEqual([])
    } finally { await runtime.stop(); vi.unstubAllGlobals() }
  })
})

describe('F3-D1 task wall-clock budgets', () => {
  const start = Date.parse('2026-01-01T00:00:00.000Z')
  const iso = (elapsed: number) => new Date(start + elapsed).toISOString()
  const grace = 10 * 60_000

  function runningBudget(ticketBudget?: number, sourceBudget?: number, globalBudget = 600_000) {
    const fixture = context('task-budget')
    const { runtime } = fixture
    runtime.saveSettings({ acceptMode: 'auto', watchdog: { maxRuntimeMs: globalBudget } })
    const id = runtime.engine.createTicket({ title: 'budget', text: 'work',
      ...(ticketBudget === undefined ? {} : { estimatedBudgetMs: ticketBudget }),
    }).ticketId!
    const ticket = runtime.store.tickets.get(id)!
    const record = runtime.store.triggers.get(ticket.origin.triggerId)!
    if (sourceBudget !== undefined) runtime.store.triggers.save({ ...record, trigger: {
      ...record.trigger, meta: { ...record.trigger.meta, runtimeBudgetMs: sourceBudget },
    } })
    runtime.store.tickets.save({ ...ticket, assignments: [{ ...ticket.assignments[0]!, state: 'running', startedAt: iso(0) }] })
    // No pump or CLI: exercise the real Runtime/Store/Engine with its injected fake driver and explicit clock.
    return { ...fixture, id }
  }

  it.each([
    ['source when Ticket is absent', undefined, 300_000, 600_000, 300_000],
    ['global fallback', undefined, undefined, 600_000, 600_000],
    ['source above a lower model estimate', 60_000, 300_000, 600_000, 300_000],
    ['source below a higher model estimate', 900_000, 300_000, 600_000, 300_000],
  ] as const)('uses %s, notifies once at the configured limit, then stops after ten minutes', async (_name, ticketBudget, sourceBudget, globalBudget, budget) => {
    const { runtime, driver, id } = runningBudget(ticketBudget, sourceBudget, globalBudget)
    try {
      runtime.enforceRuntimeBudgets(start + budget - 1)
      const warnings = () => runtime.engine.history(id).filter(event => event.type === 'budget_warning' && event.detail?.kind === 'limit')
      expect(warnings()).toHaveLength(0)
      runtime.enforceRuntimeBudgets(start + budget)
      expect(warnings()).toHaveLength(1)
      expect(runtime.store.tickets.get(id)!.ended).toBeUndefined()
      runtime.enforceRuntimeBudgets(start + budget + grace - 1)
      expect(warnings()).toHaveLength(1)
      expect(runtime.store.tickets.get(id)!.inputs).toEqual([])
      expect(runtime.store.tickets.get(id)!.ended).toBeUndefined()
      runtime.enforceRuntimeBudgets(start + budget + grace)
      expect(runtime.store.tickets.get(id)!.ended).toMatchObject({ outcome: 'stopped', by: 'system' })
      expect(driver.launched).toEqual([])
    } finally { await runtime.stop() }
  })

  it.each(['wait', 'overlap'] as const)('keeps elapsed time from the earliest persisted start across retries (%s)', async mode => {
    const { runtime, id } = runningBudget(undefined, 60_000)
    try {
      const ticket = runtime.store.tickets.get(id)!
      const first = ticket.assignments[0]!
      runtime.store.tickets.save({ ...ticket, assignments: [
        { ...first, state: 'ended', endedAt: iso(mode === 'wait' ? 10_000 : 55_000), endedReason: 'retried' },
        { id: 'retry', state: 'running', createdAt: iso(45_000), startedAt: iso(45_000) },
      ] })
      runtime.enforceRuntimeBudgets(start + 59_999)
      const warnings = () => runtime.engine.history(id).filter(event => event.type === 'budget_warning')
      expect(warnings()).toHaveLength(0)
      runtime.enforceRuntimeBudgets(start + 60_000)
      expect(warnings()).toHaveLength(1)
      runtime.enforceRuntimeBudgets(start + 60_000 + grace)
      expect(runtime.store.tickets.get(id)!.ended?.outcome).toBe('stopped')
    } finally { await runtime.stop() }
  })

  it('leaves uncertain recovery untouched even beyond budget plus grace', async () => {
    const { runtime, id } = runningBudget(60_000, 300_000)
    try {
      const ticket = runtime.store.tickets.get(id)!
      const held = { ...ticket, recovery: { state: 'uncertain' as const, assignmentId: ticket.assignments[0]!.id,
        at: iso(0), reason: 'operator reconciliation required' } }
      runtime.store.tickets.save(held)
      runtime.enforceRuntimeBudgets(start + 60_000 + grace)
      runtime.enforceRuntimeBudgets(start + 60_000 + grace + 1)
      expect(runtime.store.tickets.get(id)).toEqual(held)
    } finally { await runtime.stop() }
  })

  it('keeps unbudgeted work unlimited when all fallbacks are disabled', async () => {
    const { runtime, id } = runningBudget(undefined, 0, 0)
    try {
      const original = runtime.store.tickets.get(id)
      runtime.enforceRuntimeBudgets(start + 86_400_000)
      expect(runtime.store.tickets.get(id)).toEqual(original)
    } finally { await runtime.stop() }
  })

  it('warns about the model estimate without stopping at the old deadline', async () => {
    const { runtime, id } = runningBudget(120_000, 0, 0)
    try {
      runtime.enforceRuntimeBudgets(start + 120_000)
      runtime.enforceRuntimeBudgets(start + 120_000 + grace + 1)
      expect(runtime.store.tickets.get(id)!.ended).toBeUndefined()
      const warnings = runtime.engine.history(id).filter(event => event.type === 'budget_warning')
      expect(warnings).toMatchObject([{ by: { kind: 'system' }, detail: { kind: 'estimate', budgetMs: 120_000 } }])
      expect(runtime.store.tickets.get(id)!.inputs).toEqual([])
      expect(runtime.store.tickets.get(id)!.notes).toEqual([expect.objectContaining({ text: expect.stringContaining('不会停止 Worker') })])
    } finally { await runtime.stop() }
  })

  it('delivers a ready result during the configured grace on a backend that queues inputs', async () => {
    let finish!: () => void
    const releaseReport = new Promise<void>(resolve => { finish = resolve })
    const { runtime, driver } = context('budget-delivery', new InstantDriver(releaseReport), true)
    try {
      runtime.saveSettings({ acceptMode: 'auto', watchdog: { maxRuntimeMs: 120_000 } })
      const id = runtime.engine.createTicket({ title: 'budget delivery', text: 'work' }).ticketId!
      await runtime.effects.runDue()
      const startedAt = await waitFor(() => runtime.store.tickets.get(id)?.assignments.at(-1)?.startedAt, 2_000)
      const softDeadline = Date.parse(startedAt) + 120_000
      runtime.enforceRuntimeBudgets(softDeadline)
      await runtime.effects.runDue()
      finish()
      await waitFor(() => runtime.engine.history(id).find(event => event.detail?.phase === 'final'), 2_000)
      runtime.enforceRuntimeBudgets(softDeadline + grace)
      const ticket = runtime.store.tickets.get(id)!
      expect(ticket.ended?.outcome).toBe('done')
      expect(ticket.result).toMatchObject({ files: ['result.md'] })
      expect(ticket.acceptance?.status).toBe('accepted')
      expect(driver.launched).toHaveLength(1)
    } finally { finish(); await runtime.stop() }
  })
})

describe('F3-B2 pending intent recovery', () => {
  it('holds an outstanding old attempt when rework already queued a new pending Assignment', async () => {
    const { runtime, driver } = context('rework-before-final')
    try {
      runtime.saveSettings({ acceptMode: 'auto', allowedSenders: ['operator'] })
      const id = runtime.engine.createTicket({ title: 'rework-crash', text: 'work' }).ticketId!
      const original = runtime.store.tickets.get(id)!
      const assignmentId = original.assignments[0]!.id
      runtime.store.tickets.save({ ...original, executionAttempt: { token: 'old', assignmentId, bootId: 'old-boot', host: 'host', phase: 'started', at: new Date().toISOString() }, assignments: [{ ...original.assignments[0]!, state: 'ended', endedReason: 'rework' }, { id: 'next', state: 'pending', createdAt: new Date().toISOString() }] })
      await runtime.start()
      await runtime.effects.runDue()
      const held = runtime.store.tickets.get(id)!
      expect(held.recovery).toMatchObject({ state: 'uncertain', assignmentId })
      expect(held.assignments.at(-1)).toMatchObject({ id: 'next', state: 'pending' })
      expect(held.executionAttempt).toMatchObject({ token: 'old', phase: 'started' })
      expect(driver.launched).toEqual([])
    } finally { await runtime.stop() }
  })

  it('holds outstanding pending intent on restart while an ordinary pending ticket still launches', async () => {
    const first = context('pending-intent')
    let runtime = first.runtime
    const driver = first.driver
    let id = ''
    try {
      runtime.saveSettings({ acceptMode: 'auto', allowedSenders: ['operator'] })
      id = runtime.engine.createTicket({ title: 'possibly-spawned', text: 'work' }).ticketId!
      const original = runtime.store.tickets.get(id)!
      const assignmentId = original.assignments[0]!.id
      runtime.store.tickets.save({ ...original, executionAttempt: { token: 'old-token', assignmentId, bootId: 'old-boot', host: 'test-host', phase: 'intent', at: new Date().toISOString() } })
      const ordinaryId = runtime.engine.createTicket({ title: 'never-spawned', text: 'work' }).ticketId!
      await runtime.stop()
      const config = resolveConfig({ stateDir: first.stateDir, workRoot: join(first.stateDir, 'work'), inboxDir: first.inboxDir, port: 0 })
      runtime = createRuntime(boot({ config, logger: silentLogger() }), { logger: silentLogger(), driver, proc: new ProcessRegistry(), notifier: null, acceptanceEnabled: false })
      await runtime.start()
      await runtime.effects.runDue()
      const held = runtime.store.tickets.get(id)!
      expect(held.assignments).toEqual(original.assignments)
      expect(held.recovery).toMatchObject({ state: 'uncertain', assignmentId })
      expect(held.executionAttempt).toMatchObject({ token: 'old-token', phase: 'intent' })
      expect(driver.launched.some(spec => spec.ticketId === id)).toBe(false)
      await waitFor(() => driver.launched.find(spec => spec.ticketId === ordinaryId), 2000)
      expect(driver.launched.filter(spec => spec.ticketId === ordinaryId)).toHaveLength(1)
    } finally { await runtime.stop() }
  })
})

describe('F3-B1 uncertain restart recovery', () => {
  it('holds the original Assignment after SIGKILL while its detached worker survives', async () => {
    const first = context('sigkill-orphan')
    let runtime = first.runtime
    const driver = first.driver
    const marker = join(first.stateDir, 'owned-worker.pid')
    const parent = spawn(process.execPath, ['-e', `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',cwd:process.argv[1]}); fs.writeFileSync(process.argv[2],String(child.pid)); process.stdout.write('ready'); setInterval(()=>{},1000)`, first.stateDir, marker], { cwd: first.stateDir, stdio: ['ignore', 'pipe', 'pipe'] })
    let workerPid: number | undefined
    try {
      await once(parent.stdout!, 'data')
      workerPid = Number(readFileSync(marker, 'utf8'))
      expect(Number.isSafeInteger(workerPid) && workerPid > 1).toBe(true)
      const parentExit = once(parent, 'exit')
      parent.kill('SIGKILL')
      expect(await parentExit).toEqual([null, 'SIGKILL'])
      expect(() => process.kill(workerPid!, 0)).not.toThrow()
      runtime.saveSettings({ acceptMode: 'auto', allowedSenders: ['operator'] })
      runtime.engine.createTicket({ title: 'orphan', text: 'do work' })
      const pending = runtime.store.tickets.list().find(ticket => ticket.title === 'orphan')!
      const id = pending.id
      runtime.engine.assignmentStarted(id, pending.assignments[0]!.id)
      const running = runtime.store.tickets.get(id)!
      runtime.store.tickets.save({ ...running, execution: { ...running.execution!, sessionId: 'original-session' }, workerDirectory: running.execution!.directory })
      const original = runtime.store.tickets.get(id)!
      // Simulate the crash window after started was persisted but before launch was settled.
      runtime.store.claimEffects('launch', 50)
      const signal = vi.spyOn(process, 'kill')
      try {
        await runtime.start()
        await runtime.effects.runDue()
        expect(driver.launched).toEqual([])
        expect(signal).not.toHaveBeenCalled()
        const held = runtime.store.tickets.get(id)!
        expect(held.assignments).toEqual(original.assignments)
        expect(held.execution).toEqual(original.execution)
        expect(held.workerDirectory).toBe(original.workerDirectory)
        expect(held.recovery).toMatchObject({ state: 'uncertain', assignmentId: original.assignments[0]!.id })
        expect(ticketStage(held)).toBe('waiting')
        expect(canRetry(held)).toBe(false)
        expect(runtime.progress(id)).toMatchObject({ agentStatus: 'waiting', lastSaid: expect.stringContaining('operator reconciliation'), sessionId: 'original-session' })
        const history = runtime.engine.history(id)
        expect(history.some(event => event.type === 'interrupted')).toBe(false)
        expect(history.at(-1)).toMatchObject({ type: 'worker_phase', detail: { phase: 'operator-reconciliation' } })
        await runtime.stop()
        const config = resolveConfig({ stateDir: first.stateDir, workRoot: join(first.stateDir, 'work'), inboxDir: first.inboxDir, port: 0 })
        runtime = createRuntime(boot({ config, logger: silentLogger() }), { logger: silentLogger(), driver, proc: new ProcessRegistry(), notifier: null, acceptanceEnabled: false })
        await runtime.start()
        await runtime.effects.runDue()
        expect(runtime.store.tickets.get(id)).toEqual(held)
        expect(runtime.engine.history(id)).toEqual(history)
        expect(driver.launched).toEqual([])
        expect(signal).not.toHaveBeenCalled()
      } finally { signal.mockRestore() }
      expect(() => process.kill(workerPid!, 0)).not.toThrow()
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) { const exited = once(parent, 'exit'); parent.kill('SIGKILL'); await exited }
      if (workerPid === undefined && existsSync(marker)) workerPid = Number(readFileSync(marker, 'utf8'))
      if (workerPid !== undefined && Number.isSafeInteger(workerPid) && workerPid > 1) {
        try { process.kill(workerPid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
      await runtime.stop()
    }
  })
})

describe('standalone runtime assembly', () => {
  it('keeps compatible backend warnings visible without rejecting availability', async () => {
    const { runtime, driver } = context('health-capability-warning')
    try {
      await runtime.start()
      vi.spyOn(driver, 'probe').mockResolvedValue({ backend: 'dsh', ok: true, checkedAt: '', auth: 'unknown', problems: [], warnings: ['degraded_capability: backend permissions'] })
      expect((await runtime.checkExecution()).ok).toBe(true)
      expect(runtime.health.snapshot()['execution-backend']?.detail).toContain('degraded_capability')
    } finally { await runtime.stop() }
  })
  it('keeps the newer health result when same-backend checks complete out of order', async () => {
    const { runtime, driver } = context('health-out-of-order')
    let finishOld!: (health: DriverHealth) => void
    let finishNew!: (health: DriverHealth) => void
    const old = new Promise<DriverHealth>(resolve => { finishOld = resolve })
    const newer = new Promise<DriverHealth>(resolve => { finishNew = resolve })
    try {
      await runtime.start()
      const probe = vi.spyOn(driver, 'probe').mockReturnValueOnce(old).mockReturnValueOnce(newer)
      const first = runtime.checkExecution()
      const second = runtime.checkExecution()
      // runOperation admits work in a microtask; wait for both probes to be owned, without a clock race.
      await Promise.resolve()
      expect(probe).toHaveBeenCalledTimes(2)
      finishNew({ backend: 'dsh', ok: true, checkedAt: 'new-check', auth: 'ok', problems: [] })
      await second
      finishOld({ backend: 'dsh', ok: false, checkedAt: 'old-check', auth: 'expired', problems: ['old-error'] })
      expect(await first).toMatchObject({ ok: false })
      expect(runtime.executionStatus().health).toMatchObject({ ok: true, checkedAt: 'new-check' })
      expect(runtime.health.snapshot()['execution-backend']?.ok).toBe(true)
    } finally {
      finishOld({ backend: 'dsh', ok: false, checkedAt: '', auth: 'unknown', problems: [] })
      finishNew({ backend: 'dsh', ok: true, checkedAt: '', auth: 'ok', problems: [] })
      await runtime.stop()
    }
  })

  it('does not replace the selected backend summary when another backend responds late', async () => {
    const { runtime, driver } = context('health-selection-race')
    let finish!: (health: DriverHealth) => void
    const delayed = new Promise<DriverHealth>(resolve => { finish = resolve })
    try {
      await runtime.start()
      vi.spyOn(driver, 'probe').mockReturnValueOnce(delayed)
      const pending = runtime.checkExecution()
      await Promise.resolve()
      runtime.saveSettings({ executor: { backend: 'codex' } })
      finish({ backend: 'dsh', ok: true, checkedAt: 'late-dsh', auth: 'ok', problems: [] })
      await pending
      expect(runtime.executionStatus()).toEqual({ selected: 'codex', health: null })
      expect(runtime.health.snapshot()['execution-backend']?.detail).toContain('codex')
      expect(runtime.health.snapshot()['execution-backend']?.ok).toBe(false)
    } finally {
      finish({ backend: 'dsh', ok: false, checkedAt: '', auth: 'unknown', problems: [] })
      await runtime.stop()
    }
  })

  it('checks the current execution backend through protected HTTP and exposes no stale selection', async () => {
    const { runtime, driver } = context('execution-health')
    try {
      await runtime.start()
      const probe = vi.spyOn(driver, 'probe')
      const base = runtime.status().panel + 'api/execution/'
      const headers = { 'x-ordin-request': '1' }
      expect(await (await fetch(base + 'status', { headers })).json()).toEqual({ selected: 'dsh', health: null })
      expect(probe).not.toHaveBeenCalled()
      expect((await fetch(base + 'check', { method: 'POST' })).status).toBe(403)
      const checked = await fetch(base + 'check', { method: 'POST', headers })
      expect(checked.status).toBe(200)
      expect(await checked.json()).toMatchObject({ backend: 'dsh', ok: true })
      expect(await (await fetch(base + 'status', { headers })).json()).toMatchObject({ health: { ok: true } })
      runtime.saveSettings({ executor: { backend: 'codex' } })
      expect(await (await fetch(base + 'status', { headers })).json()).toEqual({ selected: 'codex', health: null })
      expect(runtime.health.snapshot()['execution-backend']?.ok).toBe(false)
      probe.mockRejectedValueOnce(new Error('not logged in'))
      expect(await (await fetch(base + 'check', { method: 'POST', headers })).json()).toMatchObject({ backend: 'codex', ok: false, problems: ['Error: not logged in'] })
    } finally { await runtime.stop() }
  })

  it('serves live desk configuration over HTTP without restarting the runtime', async () => {
    const { runtime } = context('desk-status')
    try {
      await runtime.start()
      const url = runtime.status().panel + 'api/desk/status'
      const get = async () => {
        const response = await fetch(url, { headers: { 'x-ordin-request': '1' } })
        expect(response.status).toBe(200)
        return await response.json()
      }
      expect(await get()).toMatchObject({ state: 'idle', configured: false, model: '' })
      runtime.saveSettings({ deskLlm: { baseUrl: 'http://127.0.0.1:1/v1', provider: 'local-test', model: 'configured-model' } })
      expect(await get()).toMatchObject({ state: 'idle', configured: true, provider: 'local-test', model: 'configured-model', recentErrors: [] })
      runtime.saveSettings({ deskLlm: {} })
      expect(await get()).toMatchObject({ state: 'idle', configured: false, model: '' })
      // Creating a domain event exercises refresh; it must not clear the unconfigured desk problem.
      runtime.engine.createTicket({ title: 'observe-only', text: 'record this request' })
      expect(runtime.health.snapshot().desk?.ok).toBe(false)
    } finally { await runtime.stop() }
  })

  it('routes configured desk reports with request id first and body second', async () => {
    const { runtime } = context('desk-order')
    try {
      await runtime.start()
      runtime.saveSettings({ acceptMode: 'auto', deskLlm: { baseUrl: 'http://127.0.0.1:1/v1', model: 'test' } })
      const relay = vi.spyOn(runtime.deskLoop!, 'relay').mockResolvedValue()
      const ticketId = runtime.engine.createTicket({ title: 'desk-order', text: 'test' }).ticketId!
      const ticket = runtime.store.tickets.get(ticketId)!
      runtime.delivery.report(ticket, { state: 'ready', summary: 'body-order-marker', at: new Date().toISOString() })
      await runtime.effects.runDue()
      const [requestId, text, routedTicket] = await waitFor(() => relay.mock.calls.find(call => call[1].includes('body-order-marker')), 5000)
      expect(text).toContain('body-order-marker')
      expect(requestId).not.toContain('body-order-marker')
      expect(routedTicket).toBe(ticketId)
      relay.mockRestore()
    } finally { await runtime.stop() }
  })

  it('stores an unconfigured desk notice once without waking the model or retrying notify', async () => {
    const { runtime } = context('desk-unconfigured')
    try {
      await runtime.start()
      runtime.saveSettings({ acceptMode: 'auto' })
      const relay = vi.spyOn(runtime.deskLoop!, 'relay')
      const ticketId = runtime.engine.createTicket({ title: 'desk-off', text: 'test' }).ticketId!
      const ticket = runtime.store.tickets.get(ticketId)!
      runtime.delivery.report(ticket, { state: 'ready', summary: 'notice-persist-marker', at: new Date().toISOString() })
      // The executor reports asynchronously now (acceptance runs first), so wait for the notice itself rather than
      // counting passes; the assertion below is about it happening exactly once.
      await waitFor(() => runtime.store.deskHistory.recent(100).some(row => row.content.includes('notice-persist-marker')) ? true : undefined, 5000)
      await runtime.effects.runDue()
      expect(relay).not.toHaveBeenCalled()
      const notices = runtime.store.deskHistory.recent(100).filter(row => row.content.includes('notice-persist-marker'))
      expect(notices).toHaveLength(1)
      expect(runtime.store.effectCounts().notify ?? 0).toBe(0)
      expect(runtime.health.snapshot().desk?.ok).toBe(false)
      relay.mockRestore()
    } finally { await runtime.stop() }
  })

  it('starts a real panel on a loopback dynamic port and stops cleanly', async () => {
    const { runtime } = context('panel')
    try {
      await runtime.start()
      const status = runtime.status()
      expect(status.ready).toBe(true)
      expect(status.panel).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ordin\/$/)
      const panel = await fetch(status.panel)
      expect(panel.status).toBe(200)
      expect(await panel.text()).toContain('ordin')
      const state = await fetch(`${status.panel}api/state`, { headers: { 'x-ordin-request': '1' } })
      expect(state.status).toBe(200)
      expect(await state.json()).toHaveProperty('settings')
    } finally {
      await runtime.stop()
    }
    expect(runtime.status().ready).toBe(false)
  })

  it('takes an inbox request to a Ticket, a ready report, RESULT.md and panel visibility', { timeout: 15000 }, async () => {
    const { runtime, driver, inboxDir, stateDir } = context('flow')
    try {
      await runtime.start()
      runtime.saveSettings({ acceptMode: 'auto', sources: { inbox: { directory: inboxDir, pollMs: 1000 } } })
      mkdirSync(inboxDir, { recursive: true })
      writeFileSync(join(inboxDir, 'request.md'), '---\ntitle: 一体化测试\n---\n请直接完成。\n', 'utf8')
      const ticket = await waitFor(() => runtime.store.tickets.list().find(t => t.ended !== undefined), 5000)
      expect(ticket.title).toBe('一体化测试')
      expect(ticket.ended?.outcome).toBe('done')
      expect(driver.launched).toHaveLength(1)
      const directory = ticket.execution!.directory!
      const resultText = await waitFor(() => {
        const path = join(directory, 'RESULT.md')
        if (!existsSync(path)) return undefined
        const text = readFileSync(path, 'utf8')
        return text.includes('任务完成') ? text : undefined
      }, 5000)
      expect(resultText).toContain('任务完成')
      // M1-F: the finished Ticket's artifacts are registered as searchable data assets.
      const registered = await waitFor(() => {
        const rows = runtime.store.assets.list({ includeArchived: true })
        return rows.length > 0 ? rows : undefined
      }, 5000)
      expect(registered[0]).toMatchObject({ source: { ticketId: ticket.id } })
      expect(runtime.store.assets.search('完成').length).toBeGreaterThan(0)
      expect(runtime.status().panel).toContain('/ordin/')
      expect(stateDir).toBe(runtime.machine.stateDir)
    } finally {
      await runtime.stop()
    }
  })
})

describe('F2-B1 durable asset lifecycle', () => {
  function endedFixture() {
    const fixture = context('durable-assets')
    const { runtime } = fixture
    runtime.saveSettings({ acceptMode: 'auto' })
    const id = runtime.engine.createTicket({ title: 'assets', text: 'work' }).ticketId!
    const original = runtime.store.tickets.get(id)!
    const directory = join(runtime.machine.workRoot, id)
    mkdirSync(directory, { recursive: true })
    const at = new Date().toISOString()
    const ticket = { ...original, execution: { name: id, directory },
      assignments: original.assignments.map(a => ({ ...a, state: 'ended' as const })),
      ended: { outcome: 'done' as const, by: 'system' as const, at, reason: 'completed' },
      result: { summary: 'durable bytes', files: ['artifact.md'], at }, acceptance: { status: 'accepted' as const },
    }
    runtime.store.tickets.save(ticket)
    const resultKey = assetResultKey(ticket)
    const key = id + ':' + resultKey
    const payload = { ticketId: id, resultKey }
    return { ...fixture, ticket, directory, key, payload }
  }

  it('awaits registration, retains failed effect and health, then retries with persisted Ticket', async () => {
    const f = endedFixture()
    const { runtime } = f
    try {
      runtime.effects.enqueue('asset-registration', f.key, f.payload)
      await runtime.effects.drain()
      await runtime.effects.runDue()
      await runtime.effects.drain()
      expect(runtime.effects.pending('asset-registration', f.key)).toBe(true)
      expect(runtime.health.snapshot().assets).toMatchObject({ ok: false, detail: expect.stringContaining('Asset registration failed') })
      expect(runtime.health.snapshot().effects).toMatchObject({ ok: false, detail: expect.stringContaining('asset-registration failed 1') })
      writeFileSync(join(f.directory, 'artifact.md'), 'durable bytes')
      runtime.effects.enqueue('asset-registration', f.key, f.payload)
      await runtime.effects.drain()
      await runtime.effects.runDue()
      await runtime.effects.drain()
      expect(runtime.effects.pending('asset-registration', f.key)).toBe(false)
      const registered = runtime.store.assets.list({ includeArchived: true })
      expect(registered).toHaveLength(1)
      expect(registered[0]).toMatchObject({ revision: 1, status: 'active', source: { ticketId: f.ticket.id } })
      expect(runtime.health.snapshot().assets?.ok).toBe(true)
    } finally { await runtime.stop() }
  })

  it('replays a queued compact registration after restart without another ended event', async () => {
    const f = endedFixture()
    let runtime = f.runtime
    try {
      writeFileSync(join(f.directory, 'artifact.md'), 'replay bytes')
      runtime.effects.enqueue('asset-registration', f.key, f.payload)
      expect(runtime.effects.pending('asset-registration', f.key)).toBe(true)
      expect(runtime.store.assets.list()).toEqual([])
      await runtime.stop()
      const config = resolveConfig({ stateDir: f.stateDir, workRoot: join(f.stateDir, 'work'), inboxDir: f.inboxDir, port: 0 })
      runtime = createRuntime(boot({ config, logger: silentLogger() }), { logger: silentLogger(), driver: f.driver, proc: new ProcessRegistry(), notifier: null, acceptanceEnabled: false })
      expect(runtime.effects.pending('asset-registration', f.key)).toBe(true)
      await runtime.effects.runDue()
      const [replayed] = runtime.store.assets.list({ includeArchived: true })
      expect(runtime.store.assets.list({ includeArchived: true })).toHaveLength(1)
      expect(replayed).toMatchObject({ status: 'active', revision: 1, source: { ticketId: f.ticket.id } })
      const archived = { ...replayed!, id: String(replayed!.id), kind: String(replayed!.kind), name: String(replayed!.name), createdAt: String(replayed!.createdAt), updatedAt: String(replayed!.updatedAt), archived: true, tags: ['operator-tag'] }
      runtime.store.assets.save(archived)
      runtime.effects.enqueue('asset-registration', f.key, f.payload)
      await runtime.effects.runDue()
      expect(runtime.store.assets.list({ includeArchived: true })).toEqual([{ ...replayed, archived: true, tags: ['operator-tag'] }])
      writeFileSync(join(f.directory, 'artifact.md'), 'new content creates a revision')
      const current = { ...f.ticket, result: { ...f.ticket.result!, summary: 'new result', files: ['artifact.md'] } }
      runtime.store.tickets.save(current)
      const changedKey = assetResultKey(current)
      runtime.effects.enqueue('asset-registration', f.ticket.id + ':' + changedKey, { ticketId: f.ticket.id, resultKey: changedKey })
      await runtime.effects.runDue()
      const versions = runtime.store.assets.list({ includeArchived: true })
      expect(versions).toHaveLength(2)
      expect(versions.map(asset => asset.revision).sort()).toEqual([1, 2])
      expect(runtime.effects.pending('asset-registration', f.key)).toBe(false)
    } finally { await runtime.stop() }
  })
})

it('F2-C2 worker promotion creates only disabled sourced candidates', async () => {
  const { runtime } = context('skill-candidate')
  runtime.saveSettings({ acceptMode: 'auto' })
  try {
    const id = runtime.engine.createTicket({ title: 'script', text: 'work' }).ticketId!
    const original = runtime.store.tickets.get(id)!
    const directory = join(runtime.machine.workRoot, id); mkdirSync(directory, { recursive: true })
    runtime.store.tickets.save({ ...original, execution: { name: id, directory } })
    writeFileSync(join(directory, 'tool.mjs'), 'throw new Error("must never execute");')
    const result = await runtime.promoteSkill(id, { name: 'from-worker', title: 'Worker', description: 'candidate', script_path: 'tool.mjs' })
    expect(result).toMatchObject({ ok: true, skill_name: 'ordin-from-worker' })
    const skill = runtime.prompts.skill('ordin-from-worker')!
    expect(skill).toMatchObject({ enabled: false, state: 'candidate', source: 'worker', fromTicketId: id, revision: 1 })
    expect(skill.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(runtime.proc.list()).toEqual([])
    expect(() => runtime.prompts.setSkillEnabled(skill.name, true)).toThrow(/approval/i)
  } finally { await runtime.stop() }
})
