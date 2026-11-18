/**
 * P2-T6: the Executor's own rules, on a fake WorkerDriver.
 *
 * Migrated from ordin tests/executor.spec.ts. The old file drove a full DSH deployment (tests/helpers/deployment.ts
 * with agents/sessionController/subprocess stubs). This one keeps the SAME state-machine cases — slots, pause,
 * dependencies, stale launches, prepare, effect give-up, attachments, inputs, stop — but replaces the Session host
 * with the frozen WorkerDriver SPI (src/drivers/types.ts) and a real ProcessRegistry. The domain side is real:
 * Engine + SQLite Store + Effects run for actual, so the assertions are about the same state transitions.
 *
 * No real worker CLI runs here. The one place a real process starts is the prepare command, through the real
 * ProcessRegistry (tests/process.spec.ts does the same with sh), because the sandbox's whole job is spawning.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  canRetry, Engine, key, parseSettings, settingsPolicy,
  type Delivery, type Executor, type Mandate, type Report, type Ticket, type Trigger,
} from '../src/core/index.ts'
import type { BackendKind, BackendSession, DriverHealth, FeedResult, LaunchSpec, RunningTurn, TurnResult, WorkerDriver, WorkerEvent, WorkerSpec } from '../src/drivers/types.ts'
import { Effects } from '../src/app/effects.ts'
import { AssetCatalog } from '../src/app/asset-catalog.ts'
import { AssetObjects } from '../src/app/asset-objects.ts'
import { LocalHostSandbox, PrepareFailed, WorkerExecutor, type DeskRelay, type ExecutorHost } from '../src/app/executor.ts'
import { HealthBoard } from '../src/app/health.ts'
import { createLogger, type Logger } from '../src/app/logger.ts'
import { ProcessRegistry } from '../src/app/process.ts'
import { Store } from '../src/app/store.ts'
import { Prompts } from '../src/app/prompts.ts'
import { MAX_REWORK, runAcceptance } from '../src/app/acceptance.ts'
import { TurnChannel } from '../src/drivers/channel.ts'
import { tempDir } from './helpers/temp.ts'

const now = (): string => new Date().toISOString()
const wait = (ms = 10): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** One scripted worker turn: the test decides which events it emits, and when. */
class FakeTurn implements RunningTurn {
  readonly backend = 'dsh' as const
  readonly channel = new TurnChannel()
  readonly feeds: string[] = []
  readonly cancels: string[] = []
  feedBehavior: (text: string) => FeedResult = () => ({ status: 'accepted' })
  cancelBehavior: (reason: string) => Promise<void> = async () => {}
  private resolveDone!: (result: TurnResult) => void
  readonly done: Promise<TurnResult>
  constructor(readonly id: string) {
    this.done = new Promise(resolve => { this.resolveDone = resolve })
  }
  get events(): AsyncIterable<WorkerEvent> { return this.channel.iterable }
  async feed(input: string): Promise<FeedResult> {
    this.feeds.push(input)
    return this.feedBehavior(input)
  }
  async cancel(reason: string): Promise<void> {
    this.cancels.push(reason)
    await this.cancelBehavior(reason)
  }
  started(session?: BackendSession): void { this.channel.push({ kind: 'started', at: now(), ...(session === undefined ? {} : { session }) }) }
  report(report: Report): void { this.channel.push({ kind: 'report', at: now(), report }) }
  error(code: 'backend_error' | 'protocol_error', message: string): void {
    this.channel.push({ kind: 'error', at: now(), error: { code, message, retryable: false } })
  }
  final(result: TurnResult): void {
    this.channel.push({ kind: 'final', at: now(), result })
    this.channel.close()
    this.resolveDone(result)
  }
  closeWithoutFinal(): void { this.channel.close() }
}

class FakeDriver implements WorkerDriver {
  readonly backend = 'dsh' as const
  readonly prepared: WorkerSpec[] = []
  readonly prepareSessions: (BackendSession | undefined)[] = []
  readonly launches: LaunchSpec[] = []
  readonly resumes: { session: BackendSession; spec: LaunchSpec }[] = []
  readonly turns: FakeTurn[] = []
  probeBehavior: (backend: BackendKind) => DriverHealth = backend => ({ backend, ok: true, checkedAt: now(), version: `fake-${backend}`, auth: 'ok', problems: [] })
  /** Push 'started' as soon as a turn exists, like DshDriver does after spawn. */
  autoStart = true
  prepareBehavior: (spec: WorkerSpec) => Promise<LaunchSpec> | LaunchSpec = spec => ({ ...spec, preparedAt: now() })
  launchBehavior?: (spec: LaunchSpec) => Promise<RunningTurn>
  private seq = 0
  private make(cwd: string): FakeTurn {
    const turn = new FakeTurn(`turn-${++this.seq}`)
    this.turns.push(turn)
    if (this.autoStart) turn.started({ backend: 'dsh', id: `session-${turn.id}`, cwd, savedAt: now() })
    return turn
  }
  async prepare(spec: WorkerSpec, session?: BackendSession): Promise<LaunchSpec> {
    this.prepareSessions.push(session)
    this.prepared.push(spec)
    return await this.prepareBehavior(spec)
  }
  async launch(spec: LaunchSpec): Promise<RunningTurn> {
    this.launches.push(spec)
    if (this.launchBehavior !== undefined) return await this.launchBehavior(spec)
    return this.make(spec.cwd)
  }
  async resume(session: BackendSession, spec: LaunchSpec): Promise<RunningTurn> {
    this.resumes.push({ session, spec })
    return this.make(spec.cwd)
  }
  async probe(backend: BackendKind = 'dsh'): Promise<DriverHealth> { return this.probeBehavior(backend) }
  last(): FakeTurn {
    const turn = this.turns.at(-1)
    if (turn === undefined) throw new Error('no turn was started')
    return turn
  }
}

class FakeDelivery implements Delivery {
  readonly reports: { ticketId: string; state: Report['state'] }[] = []
  report(ticket: Ticket, report: Report): void { this.reports.push({ ticketId: ticket.id, state: report.state }) }
}

interface HarnessOptions {
  settings?: object
  autoStart?: boolean
  desk?: DeskRelay
  acceptanceChecker?: typeof runAcceptance
}

async function harness(options: HarnessOptions = {}) {
  const dir = tempDir('ordin-executor-')
  const workRoot = join(dir, 'work')
  mkdirSync(workRoot, { recursive: true })
  const store = new Store(join(dir, 'state.db'))
  const prompts = new Prompts(store)
  const health = new HealthBoard()
  const lifetime = new AbortController()
  const lines: string[] = []
  const logger: Logger = createLogger({ level: 'debug', sink: line => { lines.push(line) }, now })
  const proc = new ProcessRegistry()
  const driver = new FakeDriver()
  driver.autoStart = options.autoStart ?? true
  const delivery = new FakeDelivery()
  let current = parseSettings({ acceptMode: 'auto', allowedSenders: ['operator'], ...(options.settings ?? {}) })
  let executor!: WorkerExecutor
  const effects = new Effects(store, {
    retryIntervalMs: 5, tries: 3, backoffMs: 5,
    health: health.entry('effects'), lifetime: lifetime.signal,
    onPermanentFailure: (kind, _key, payload, error) => executor.gaveUp(kind as 'launch' | 'input', payload as { ticketId: string; assignmentId: string }, error),
  })
  const engine = new Engine({
    repos: store, tx: store, inputConsumptions: store.inputConsumptions,
    policy: () => settingsPolicy(current), delivery,
    executor: {
      prepare: (ticket, mandate) => executor.prepare(ticket, mandate),
      start: (ticket, assignment) => executor.start(ticket, assignment),
      deliver: (ticket, assignment) => executor.deliver(ticket, assignment),
      stop: (ticket, assignment, reason) => executor.stop(ticket, assignment, reason),
    },
  })
  const host: ExecutorHost = {
    logger, proc, driver, engine, store, assets: new AssetCatalog(store, dir), effects, health, skills: () => prompts.skills(),
    lifetime: lifetime.signal, settings: () => current, workRoot: () => workRoot, closing: () => false,
    ...(options.desk === undefined ? {} : { desk: options.desk }),
    ...(options.acceptanceChecker === undefined ? {} : { acceptanceChecker: options.acceptanceChecker }),
  }
  executor = new WorkerExecutor(host)
  const rebuildExecutor = (): void => { executor = new WorkerExecutor(host) }
  onTestFinished(async () => {
    lifetime.abort()
    await proc.stopAll(50)
    store.close()
  })
  const settle = async (): Promise<void> => {
    await effects.runDue()
    await wait(5)
    await effects.runDue()
    await wait(5)
  }
  /** Make a deferred effect due now, as the runtime's nudge does. */
  const dueNow = (ticketId: string, kind = 'launch'): void => {
    const assignmentId = store.tickets.get(ticketId)!.assignments.at(-1)!.id
    store.deferEffect(kind, key(kind, ticketId, assignmentId), Date.now() - 1)
  }
  const save = (next: object): void => {
    current = parseSettings({ acceptMode: 'auto', allowedSenders: ['operator'], ...next })
  }
  return { dir, workRoot, store, prompts, health, lifetime, lines, proc, driver, effects, engine, executor, delivery, settle, dueNow, save, rebuildExecutor, settings: () => current }
}

it('projects managed binary bytes with the actual extension after source task removal',async()=>{
  const c=await harness(), bytes=Buffer.from([0,255,137,80,78,71]), blob=await new AssetObjects(c.dir).put(bytes), at=now();
  c.store.assets.save({id:'png-managed',name:'Friendly label',kind:'reference',createdAt:at,updatedAt:at,archived:false,status:'active',ownerProfileId:'default',storageVersion:1,storage:{kind:'managed-object',...blob,mimeType:'image/png'},source:{ticketId:'deleted-source',path:'result.png'},revision:1,contentHash:blob.objectKey} as any);
  const catalog=new AssetCatalog(c.store,c.dir), ref=catalog.resolveMetadata('png-managed').ref;
  const id=c.engine.createTicket({title:'binary consumer',text:'read it',assetRefs:[ref]}).ticketId!;await c.settle();
  const ticket=c.engine.require(id);expect(readFileSync(join(ticket.execution!.directory,'attachments','asset-png-managed-r1.png'))).toEqual(bytes);
  expect(c.driver.prepared.at(-1)!.prompt).toContain('attachments/asset-png-managed-r1.png');expect(c.driver.launches).toHaveLength(1);
})

it('F2-E1 two workers receive exact pinned imported bytes, and queued archive/hash changes refuse launch', async () => {
  const c = await harness()
  const catalog = new AssetCatalog(c.store, c.dir)
  const content = 'exact\r\n中文\0bytes'
  const imported = catalog.import({ text: content, name: '../../unsafe-name', kind: 'document' })
  const ref = catalog.resolve(imported.id).ref
  catalog.patch(ref.id, { name: 'revision two' })
  for (const title of ['first-import', 'second-import']) {
    const id = c.engine.createTicket({ title, text: 'read selected asset', assetRefs: [ref] }).ticketId!
    await c.settle()
    const ticket = c.engine.require(id)
    expect(ticket.assetRefs).toEqual([ref])
    expect(ticket.attachments).toEqual([])
    const path = join(ticket.execution!.directory, 'attachments', 'asset-' + ref.id + '-r1.txt')
    expect(readFileSync(path)).toEqual(Buffer.from(content, 'utf8'))
    expect(c.driver.prepared.at(-1)!.prompt).toContain('asset-' + ref.id + '-r1.txt')
    const turn = c.driver.last()
    turn.report({ state: 'ready', summary: 'done', at: now() }); turn.final({ status: 'completed', text: 'done' })
    await c.settle()
  }
  const launches = c.driver.launches.length
  for (const changes of [{ archived: true }, { content: 'tampered' }, { deletedAt: 'now' }, { ownerProfileId: 'foreign' }]) {
    const row = c.store.assets.get(ref.id)!
    const currentRef = catalog.resolve(ref.id).ref
    const id = c.engine.createTicket({ title: JSON.stringify(changes), text: 'must refuse', assetRefs: [currentRef] }).ticketId!
    c.store.assets.save({ ...row, ...changes } as any)
    await c.settle()
    expect(c.driver.launches).toHaveLength(launches)
    expect(c.engine.require(id).attention?.question ?? c.engine.require(id).result?.summary ?? JSON.stringify(c.health.problems())).toMatch(/asset|hash|denied|unavailable/i)
    c.store.assets.save(row as any)
  }
})

it('F3-B1 settles replayed launch/input without preparing or resuming an uncertain worker', async () => {
  const c = await harness()
  const id = c.engine.createTicket({ title: 'uncertain-replay', text: 'work' }).ticketId!
  const assignment = c.engine.require(id).assignments[0]!
  c.engine.assignmentStarted(id, assignment.id)
  c.engine.assignmentUncertain(id, assignment.id)
  const held = c.engine.require(id)
  c.effects.enqueue('input', key('input', id, assignment.id), { ticketId: id, assignmentId: assignment.id })
  await c.settle()
  expect(c.driver.prepared).toEqual([])
  expect(c.driver.launches).toEqual([])
  expect(c.driver.resumes).toEqual([])
  expect(c.engine.require(id)).toEqual(held)
  expect(c.store.effectCounts()).toEqual({})
})

const problems = (health: HealthBoard): string =>
  health.problems().map(problem => `${problem.name}: ${problem.detail}`).join('\n')

/** Create a Ticket and let its queued launch run. */
async function one(context: Awaited<ReturnType<typeof harness>>, title = 'work'): Promise<string> {
  const id = context.engine.createTicket({ title, text: `please do ${title}` }).ticketId!
  await context.settle()
  return id
}

describe('F3-D2 usage accounting', () => {
  it('retains event and final highwaters after 600 progress events and database reopen', async () => {
    const c = await harness()
    const id = await one(c)
    const turn = c.driver.last()
    turn.channel.push({ kind: 'usage', at: now(), usage: { input: 20, output: 4, costUsd: .4 } })
    for (let i = 0; i < 600; i++) turn.channel.push({ kind: 'text', at: now(), text: 'progress ' + i })
    turn.channel.push({ kind: 'usage', at: now(), usage: { input: 15, output: 2, costUsd: .2 } })
    turn.report({ state: 'ready', summary: 'done', at: now() })
    turn.channel.push({ kind: 'usage', at: now(), usage: { input: 20, output: 4, costUsd: .4 } })
    turn.final({ status: 'completed', text: 'done', usage: { input: 25, output: 6, costUsd: .5 } })
    await c.settle()
    expect(c.engine.require(id).ended?.outcome).toBe('done')
    expect(c.engine.require(id).usage?.totals).toEqual({ input: 25, output: 6, costUsd: .5, knownCostUsd: .5, costComplete: true })
    expect(c.store.events.list(id).filter(e => e.type.startsWith('worker_')).length).toBeLessThanOrEqual(500)
    const saved = c.engine.require(id).usage
    await c.executor.drain()
    c.store.close()
    vi.spyOn(c.store, 'close').mockImplementation(() => {}) // The harness owns its normal teardown.
    const reopened = new Store(join(c.dir, 'state.db'))
    try { expect(reopened.tickets.get(id)?.usage).toEqual(saved) } finally { reopened.close() }
  })

  it('accumulates two reworked turns and accounts old final before the next token starts', async () => {
    const c = await harness()
    const id = await one(c)
    const old = c.driver.last()
    const first = c.engine.require(id).assignments[0]!.id
    old.channel.push({ kind: 'usage', at: now(), usage: { input: 10, costUsd: .2 } })
    await c.settle()
    c.engine.rework(id, first, 'fix output')
    old.final({ status: 'completed', text: 'old', usage: { input: 12, costUsd: .25 } })
    await c.settle()
    const newer = c.driver.last()
    expect(newer).not.toBe(old)
    newer.final({ status: 'completed', text: 'new', usage: { input: 5, output: 3 } })
    await c.settle()
    const ledger = c.engine.require(id).usage!
    expect(ledger.attempts).toHaveLength(2)
    expect(new Set(ledger.attempts.map(a => a.token)).size).toBe(2)
    expect(ledger.totals).toEqual({ input: 17, output: 3, knownCostUsd: .25, costComplete: false })
  })

  it('captures cancellation final usage after an operator has ended the Ticket', async () => {
    const c = await harness()
    const id = await one(c)
    const turn = c.driver.last()
    c.engine.stopTicket(id, 'stop')
    turn.final({ status: 'cancelled', text: 'stopped', usage: { input: 4, costUsd: 0 } })
    await c.settle()
    expect(c.engine.require(id).ended?.outcome).toBe('stopped')
    expect(c.engine.require(id).usage?.totals).toEqual({ input: 4, costUsd: 0, knownCostUsd: 0, costComplete: true })
  })

  it.each(['completed', 'failed', 'cancelled'] as const)('captures final-only usage for %s', async status => {
    const c = await harness()
    const id = await one(c)
    c.driver.last().final({ status, text: 'finished', usage: { input: 9, cached: 3 } })
    await c.settle()
    expect(c.engine.require(id).executionAttempt?.phase).toBe('settled')
    expect(c.engine.require(id).usage?.totals).toEqual({ input: 9, cached: 3, knownCostUsd: 0, costComplete: false })
  })
})

describe('F3-B2 durable spawn intent', () => {
  it('persists intent before driver launch and holds a throw after possible spawn across executor replacement', async () => {
    const c = await harness()
    const id = c.engine.createTicket({ title: 'spawn-before-started', text: 'work' }).ticketId!
    let observed: Ticket['executionAttempt']
    c.driver.launchBehavior = async () => {
      observed = c.store.tickets.get(id)!.executionAttempt
      throw new Error('spawned, then driver failed before returning turn')
    }
    await c.settle()
    expect(observed).toMatchObject({ assignmentId: c.engine.require(id).assignments[0]!.id, phase: 'intent', token: expect.any(String), bootId: expect.any(String), host: expect.any(String), at: expect.any(String) })
    const held = c.engine.require(id)
    expect(held.recovery?.state).toBe('uncertain')
    expect(held.executionAttempt).toEqual(observed)
    c.rebuildExecutor()
    c.dueNow(id)
    await c.settle()
    expect(c.driver.launches).toHaveLength(1)
    expect(c.engine.require(id)).toEqual(held)
  })

  it('uses a fresh token on same-Assignment resume and ignores old report/final callbacks', async () => {
    const c = await harness()
    const id = await one(c)
    const first = c.engine.require(id).executionAttempt!
    const original = c.driver.last()
    // A closed turn permits a resume; keep its event channel open to inject delayed callbacks.
    c.engine.endExecutionAttempt(id, first.assignmentId, first.token)
    c.rebuildExecutor()
    c.engine.note(id, 'second turn')
    await c.settle()
    const second = c.engine.require(id).executionAttempt!
    expect(second.assignmentId).toBe(first.assignmentId)
    expect(second.token).not.toBe(first.token)
    expect(second.bootId).not.toBe(first.bootId)
    expect(c.driver.resumes).toHaveLength(1)
    const before = c.engine.require(id)
    const history = c.engine.history(id)
    original.report({ state: 'ready', summary: 'stale completion', at: now() })
    original.final({ status: 'completed', text: 'stale final' })
    await wait()
    expect(c.engine.require(id)).toEqual(before)
    expect(c.engine.history(id)).toEqual(history)
    c.driver.last().final({ status: 'completed', text: 'new final' })
    await wait()
    expect(c.engine.require(id).executionAttempt).toMatchObject({ token: second.token, phase: 'settled' })
  })

  it('leaves no intent on probe/prepare failure and retries ordinary pending', async () => {
    const c = await harness()
    c.driver.prepareBehavior = () => { throw new Error('prepare failed before spawn') }
    const id = c.engine.createTicket({ title: 'prepare-only', text: 'work' }).ticketId!
    await c.settle()
    expect(c.engine.require(id).executionAttempt).toBeUndefined()
    expect(c.driver.launches).toHaveLength(0)
    c.driver.prepareBehavior = spec => ({ ...spec, preparedAt: now() })
    c.dueNow(id)
    await c.settle()
    expect(c.driver.launches).toHaveLength(1)
    expect(c.engine.require(id).executionAttempt?.phase).toBe('started')
    c.driver.last().final({ status: 'completed', text: 'done' })
    await wait()
    expect(c.engine.require(id).executionAttempt?.phase).toBe('settled')
    c.driver.probeBehavior = backend => ({ backend, ok: false, checkedAt: now(), auth: 'unknown', problems: ['unavailable'] })
    const other = c.engine.createTicket({ title: 'probe-only', text: 'work' }).ticketId!
    await c.settle()
    expect(c.engine.require(other).executionAttempt).toBeUndefined()
  })
})

describe('LocalHostSandbox (G-3 boundary, real fs)', () => {
  it('prepares, writes, lists, reads and removes a workspace', async () => {
    const dir = tempDir('ordin-sandbox-')
    const workspace = join(dir, 'workspace')
    const sandbox = new LocalHostSandbox()
    await sandbox.prepareWorkspace(workspace)
    expect(existsSync(workspace)).toBe(true)
    await sandbox.deliverAttachment(workspace, 'a.txt', Buffer.from('alpha'))
    expect(readFileSync(join(workspace, 'attachments', 'a.txt'), 'utf8')).toBe('alpha')
    await sandbox.writeWorkspaceFile(workspace, 'RESULT.md', 'done')
    expect(readFileSync(join(workspace, 'RESULT.md'), 'utf8')).toBe('done')
    const listing = await sandbox.listWorkspace(workspace)
    expect(listing.files.map(entry => entry.path)).toContain('RESULT.md')
    const read = await sandbox.readWorkspaceFile(join(workspace, 'RESULT.md'))
    expect(Buffer.from(read.base64, 'base64').toString('utf8')).toBe('done')
    await sandbox.removeWorkspace(workspace)
    expect(existsSync(workspace)).toBe(false)
  })

  it('refuses to write outside the workspace', async () => {
    const dir = tempDir('ordin-sandbox-')
    const workspace = join(dir, 'workspace')
    await new LocalHostSandbox().prepareWorkspace(workspace)
    await expect(new LocalHostSandbox().writeWorkspaceFile(workspace, '../escape.md', 'x')).rejects.toThrow(/outside the workspace/)
  })

  it('materializes an input under the full source Ticket id and is idempotent', async () => {
    const dir = tempDir('ordin-sandbox-')
    const workspace = join(dir, 'workspace')
    const source = join(dir, 'source.txt')
    writeFileSync(source, 'bytes', 'utf8')
    const sandbox = new LocalHostSandbox()
    const first = await sandbox.materializeInput(workspace, source, 'ticket-full-id', 'data/one.txt')
    expect(first).toBe(join('inputs', 'ticket-full-id', 'data', 'one.txt'))
    expect(readFileSync(join(workspace, first), 'utf8')).toBe('bytes')
    // A retry of the same materialization is byte-identical, so it is accepted.
    await expect(sandbox.materializeInput(workspace, source, 'ticket-full-id', 'data/one.txt')).resolves.toBe(first)
  })

  it('refuses escapes, symlink segments and different same-size content', async () => {
    const dir = tempDir('ordin-sandbox-')
    const workspace = join(dir, 'workspace')
    const source = join(dir, 'source.txt')
    writeFileSync(source, 'AAAA', 'utf8')
    const sandbox = new LocalHostSandbox()
    await expect(sandbox.materializeInput(workspace, source, 'ticket', '')).rejects.toThrow(/empty destination/)
    await expect(sandbox.materializeInput(workspace, source, 'ticket', '../escape.txt')).rejects.toThrow(/outside inputs/)
    await expect(sandbox.materializeInput(workspace, source, 'ticket', '/abs.txt')).rejects.toThrow(/outside inputs/)
    // A symlinked directory inside the workspace must not be walked through.
    mkdirSync(join(workspace, 'inputs'), { recursive: true })
    symlinkSync(dir, join(workspace, 'inputs', 'ticket'))
    await expect(sandbox.materializeInput(workspace, source, 'ticket', 'x.txt')).rejects.toThrow(/symbolic link/)
    unlinkSync(join(workspace, 'inputs', 'ticket'))
    // Same size, different bytes: refused rather than silently accepted.
    const target = join(workspace, 'inputs', 'ticket', 'same.txt')
    await sandbox.materializeInput(workspace, source, 'ticket', 'same.txt')
    writeFileSync(source, 'BBBB', 'utf8')
    await expect(sandbox.materializeInput(workspace, source, 'ticket', 'same.txt')).rejects.toThrow(/different content/)
    expect(readFileSync(target, 'utf8')).toBe('AAAA')
  })

  it('reuses a legacy 8-hex-prefix inputs directory instead of splitting it', async () => {
    const dir = tempDir('ordin-sandbox-')
    const workspace = join(dir, 'workspace')
    const source = join(dir, 'source.txt')
    writeFileSync(source, 'x', 'utf8')
    const legacy = join(workspace, 'inputs', 'ticket-f')
    mkdirSync(legacy, { recursive: true })
    const result = await new LocalHostSandbox().materializeInput(workspace, source, 'ticket-full-id', 'kept.txt')
    expect(result).toBe(join('inputs', 'ticket-f', 'kept.txt'))
  })

  it('runs the prepare command in the work root through the process registry', async () => {
    const dir = tempDir('ordin-sandbox-')
    const workspace = join(dir, 'work', 'ticket-dir')
    mkdirSync(workspace, { recursive: true })
    const proc = new ProcessRegistry()
    onTestFinished(async () => { await proc.stopAll(50) })
    const sandbox = new LocalHostSandbox(proc)
    const out = await sandbox.runPrepare('pwd', workspace, { ORDIN_TICKET_ID: 'ticket-1' }, new AbortController().signal)
    expect(out.trim()).toBe(realpathSync(join(dir, 'work')))
    // The process is booked under the Ticket's prepare group, which is what a stop cancels.
    expect(proc.list().some(record => record.owner === 'executor.prepare:ticket-1')).toBe(true)
  })

  it('reports prepare stderr, a stop, and a sandbox with no registry', async () => {
    const dir = tempDir('ordin-sandbox-')
    const workspace = join(dir, 'work', 'ticket-dir')
    mkdirSync(workspace, { recursive: true })
    const proc = new ProcessRegistry()
    onTestFinished(async () => { await proc.stopAll(50) })
    const sandbox = new LocalHostSandbox(proc)
    await expect(sandbox.runPrepare('echo "git: not a repository" >&2; exit 2', workspace, {}, new AbortController().signal))
      .rejects.toThrow('git: not a repository')
    const controller = new AbortController()
    const pending = sandbox.runPrepare('sleep 30', workspace, {}, controller.signal)
    await wait(30)
    controller.abort()
    await expect(pending).rejects.toThrow('stopped before it finished')
    await expect(new LocalHostSandbox().runPrepare('true', workspace, {}, new AbortController().signal))
      .rejects.toThrow(/without a process registry/)
  })
})

describe('worker slots', () => {
  it('dispatches to the Ticket backend and persists selection, probe, version, and directory evidence', async () => {
    const context = await harness()
    const id = context.engine.createTicket({ title: 'chosen worker', text: 'work' }).ticketId!
    context.engine.annotate(id, { workerBackend: 'codex' })
    await context.settle()
    const ticket = context.store.tickets.get(id)!
    expect(context.driver.prepared.at(-1)).toMatchObject({ ticketId: id, backend: 'codex' })
    expect(ticket).toMatchObject({
      workerBackend: 'codex', workerSelectionReason: 'coordinator-choice', workerVersion: 'fake-codex',
      workerProbeOk: true, workerDirectory: ticket.execution!.directory,
    })
    expect(ticket.workerCheckedAt).toBeTruthy()
  })

  it('pins an unspecified Ticket to the configured default at dispatch', async () => {
    const context = await harness({ settings: { executor: { backend: 'claude' } } })
    const id = context.engine.createTicket({ title: 'default worker', text: 'work' }).ticketId!
    await context.settle()
    expect(context.driver.prepared.at(-1)?.backend).toBe('claude')
    expect(context.store.tickets.get(id)).toMatchObject({ workerBackend: 'claude', workerSelectionReason: 'configured-default', workerVersion: 'fake-claude' })
  })

  it('records an unhealthy backend and does not launch it', async () => {
    const context = await harness()
    context.driver.probeBehavior = backend => ({ backend, ok: false, checkedAt: now(), version: `fake-${backend}`, auth: 'missing', problems: ['not logged in'] })
    const id = context.engine.createTicket({ title: 'unavailable worker', text: 'work' }).ticketId!
    await context.settle()
    const ticket = context.store.tickets.get(id)!
    expect(context.driver.launches).toHaveLength(0)
    expect(ticket).toMatchObject({ workerProbeOk: false, workerProbeProblem: 'not logged in' })
    expect(problems(context.health)).toContain('not logged in')
  })
  it('runs only as many workers as the settings allow, and queues the rest', async () => {
    const context = await harness({ settings: { executor: { maxWorkers: 1 } } })
    context.engine.createTicket({ title: 'one', text: 'first' })
    context.engine.createTicket({ title: 'two', text: 'second' })
    await context.settle()
    expect(context.driver.launches).toHaveLength(1)
    const states = context.store.tickets.open().map(ticket => ticket.assignments.at(-1)!.state).sort()
    expect(states).toEqual(['pending', 'running'])
    expect(context.executor.used()).toBe(1)
    // The queued one has no turn: a full slot means the work waits, not that two workers share one.
    expect(context.driver.turns).toHaveLength(1)
    expect(context.store.effectCounts()).toEqual({ launch: 1 })
  })

  it('starts the queued worker once a slot is free, in the directory it was promised', async () => {
    const context = await harness({ settings: { executor: { maxWorkers: 1 } } })
    const first = context.engine.createTicket({ title: 'one', text: 'first' }).ticketId!
    const second = context.engine.createTicket({ title: 'two', text: 'second' }).ticketId!
    await context.settle()
    // Which of the two launched first is the queue's order, not the test's: find the pending one by state.
    const stateOf = (id: string): string => context.store.tickets.get(id)!.assignments.at(-1)!.state
    const queued = stateOf(first) === 'pending' ? first : second
    const launched = queued === first ? second : first
    expect(stateOf(queued)).toBe('pending')
    expect(stateOf(launched)).toBe('running')
    const directory = context.store.tickets.get(queued)!.execution!.directory
    // The running worker reports itself done, which frees its slot.
    context.driver.last().report({ state: 'ready', summary: '做完了', at: now() })
    await wait(5)
    expect(context.store.tickets.get(launched)!.ended).toMatchObject({ outcome: 'done' })
    context.executor.releaseWaitingSlots()
    await context.settle()
    expect(context.driver.launches).toHaveLength(2)
    expect(context.driver.launches[1]!.cwd).toBe(directory)
    expect(stateOf(queued)).toBe('running')
    expect(context.store.effectCounts()).toEqual({})
  })
})

describe('a pause', () => {
  it('holds a queued launch while paused, and runs it when the pause lifts', async () => {
    const context = await harness()
    const id = context.engine.createTicket({ title: 'paused', text: 'work' }).ticketId!
    // Authorized before the pause, so its launch is queued; the pause holds it where it waits.
    context.save({ paused: true })
    await context.settle()
    expect(context.driver.launches).toEqual([])
    expect(context.store.tickets.get(id)!.assignments.at(-1)!.state).toBe('pending')
    expect(context.store.effectCounts()).toEqual({ launch: 1 })
    // Lifting the pause is all it takes: the same queued launch runs, in the directory it was promised.
    const directory = context.store.tickets.get(id)!.execution!.directory
    context.save({})
    context.dueNow(id)
    await context.settle()
    expect(context.driver.launches).toHaveLength(1)
    expect(context.driver.launches[0]!.cwd).toBe(directory)
    expect(context.store.tickets.get(id)!.assignments.at(-1)!.state).toBe('running')
  })

  it('holds a delivery while paused instead of losing it', async () => {
    const context = await harness()
    const id = await one(context)
    context.save({ paused: true })
    context.engine.note(id, 'more')
    await context.settle()
    expect(context.driver.last().feeds).toEqual([])
    context.save({})
    context.dueNow(id, 'input')
    await context.settle()
    expect(context.driver.last().feeds).toHaveLength(1)
  })
})

describe('a launch whose work is no longer wanted', () => {
  it('settles a launch for an Assignment a retry replaced, instead of starting a second worker', async () => {
    const context = await harness()
    const id = await one(context)
    expect(context.driver.launches).toHaveLength(1)
    context.store.enqueueEffect('launch', key('launch', id, 'assignment-gone'), { ticketId: id, assignmentId: 'assignment-gone' })
    await context.settle()
    expect(context.store.effectCounts()).toEqual({})
    expect(context.driver.launches).toHaveLength(1)
    expect(context.store.tickets.get(id)!.assignments).toHaveLength(1)
  })

  it('settles a launch for a Ticket a person stopped before it ran', async () => {
    const context = await harness()
    const id = context.engine.createTicket({ title: 'stopped', text: 'work' }).ticketId!
    context.engine.stopTicket(id)
    await context.settle()
    expect(context.driver.launches).toEqual([])
    expect(context.store.tickets.get(id)!.ended).toMatchObject({ outcome: 'stopped' })
    expect(context.store.effectCounts()).toEqual({})
  })
})

describe('dependencies', () => {
  it('defers a launch until its upstream is done, then starts it when released', async () => {
    const context = await harness()
    const upstream = context.engine.createTicket({ title: 'up', text: 'first' }).ticketId!
    const downstream = context.engine.createTicket({ title: 'down', text: 'second', dependsOn: [upstream] }).ticketId!
    await context.settle()
    expect(context.driver.launches).toHaveLength(1)
    expect(context.driver.launches[0]!.ticketId).toBe(upstream)
    expect(context.store.tickets.get(downstream)!.assignments.at(-1)!.state).toBe('pending')
    context.driver.last().report({ state: 'ready', summary: 'done', at: now() })
    await wait(5)
    context.executor.releaseDependants(upstream)
    context.dueNow(downstream)
    await context.settle()
    expect(context.driver.launches).toHaveLength(2)
    expect(context.driver.launches[1]!.ticketId).toBe(downstream)
  })
})

describe('the prepare command', () => {
  it('runs once per Assignment, in the work root, before the driver launches', async () => {
    const context = await harness({ settings: { executor: { prepare: 'printf prepared > prepared.txt' } } })
    const id = await one(context, 'prepared')
    expect(readFileSync(join(context.workRoot, 'prepared.txt'), 'utf8')).toBe('prepared')
    expect(context.driver.prepared).toHaveLength(1)
    expect(context.driver.launches).toHaveLength(1)
    expect(context.driver.launches[0]!.ticketId).toBe(id)
    expect(context.store.tickets.get(id)!.assignments.at(-1)!.state).toBe('running')
  })

  it('reports a prepare failure and leaves the Ticket retryable, because the directory may be half-made', async () => {
    const context = await harness({ settings: { executor: { prepare: 'echo "git: not a repository" >&2; exit 2' } } })
    const id = await one(context, 'broken')
    await context.settle()
    const ticket = context.store.tickets.get(id)!
    expect(context.driver.launches).toEqual([])
    expect(ticket.ended).toBeUndefined()
    const report = ticket.assignments.at(-1)!.report!
    expect(report).toMatchObject({ state: 'failed' })
    expect(report.summary).toContain('git: not a repository')
    expect(ticket.attention).toBeDefined()
    expect(canRetry(ticket)).toBe(true)
    expect(context.store.effectCounts()).toEqual({})
    expect(problems(context.health)).toContain('Prepare failed')
  })

  it('says plainly when a prepare command was stopped before it finished', async () => {
    const context = await harness({ settings: { executor: { prepare: 'sleep 30' } } })
    const id = context.engine.createTicket({ title: 'cut-short', text: 'work' }).ticketId!
    const running = context.settle()
    await wait(80)
    context.lifetime.abort()
    await running
    const report = context.store.tickets.get(id)!.assignments.at(-1)!.report!
    expect(report).toMatchObject({ state: 'failed' })
    expect(report.summary).toContain('stopped before it finished')
  })
})

describe('a launch that keeps failing', () => {
  it('holds a throwing driver as uncertain without retrying a possible spawn', async () => {
    const context = await harness()
    context.driver.launchBehavior = async () => { throw new Error('backend unavailable') }
    const id = context.engine.createTicket({ title: 'no-driver', text: 'work' }).ticketId!
    for (let pass = 0; pass < 6; pass++) await context.settle()
    const ticket = context.store.tickets.get(id)!
    expect(ticket.assignments.at(-1)!.state).toBe('pending')
    expect(ticket.ended).toBeUndefined()
    expect(ticket.recovery?.state).toBe('uncertain')
    expect(ticket.executionAttempt?.phase).toBe('intent')
    expect(context.driver.launches).toHaveLength(1)
    expect(ticket.attention).toBeDefined()
    expect(canRetry(ticket)).toBe(false)
    expect(context.store.effectCounts()).toEqual({})
    expect(context.driver.turns).toEqual([])
  })

  it('tells the Ticket when gaveUp is called directly, and stays quiet on an ended Ticket', async () => {
    const context = await harness()
    const id = await one(context)
    context.executor.gaveUp('launch', { ticketId: id, assignmentId: 'assignment-1' }, new Error('DSH did not hand it over'))
    const ticket = context.store.tickets.get(id)!
    expect(ticket.assignments.at(-1)!.report).toMatchObject({ state: 'failed' })
    expect(ticket.assignments.at(-1)!.report!.summary).toContain('DSH did not hand it over')
    expect(ticket.attention).toBeDefined()
    context.engine.stopTicket(id)
    expect(() => context.executor.gaveUp('launch', { ticketId: id, assignmentId: 'assignment-1' }, new Error('late'))).not.toThrow()
  })
})

describe('worker backend settings', () => {
  it('passes executor.access to the worker launch spec', async () => {
    const context = await harness({ settings: { executor: { access: 'full' } } })
    await one(context, 'access-full')
    expect(context.driver.launches.at(-1)?.access).toBe('full')
  })
})

describe('worker events', () => {
  it('started marks the Assignment running and confirms its inputs', async () => {
    const context = await harness()
    const id = await one(context)
    const ticket = context.store.tickets.get(id)!
    expect(ticket.assignments.at(-1)!.state).toBe('running')
    expect(ticket.assignments.at(-1)!.deliveredAt).toBeDefined()
  })

  it('report goes to the engine, and a ready report ends the Ticket', async () => {
    const context = await harness()
    const id = await one(context)
    context.driver.last().report({ state: 'progress', summary: 'halfway', at: now() })
    await wait(5)
    expect(context.store.tickets.get(id)!.assignments.at(-1)!.report).toMatchObject({ state: 'progress', summary: 'halfway' })
    context.driver.last().report({ state: 'ready', summary: '全部完成', files: [], at: now() })
    await wait(5)
    const ticket = context.store.tickets.get(id)!
    expect(ticket.ended).toMatchObject({ outcome: 'done' })
    expect(ticket.acceptance?.status).toBe('unverified')
    expect(ticket.result?.summary).toContain('全部完成')
    expect(ticket.result?.summary).toContain('could not verify')
    expect(context.delivery.reports.map(entry => entry.state)).toContain('ready')
  })

  it('persists bounded worker text, tool, usage, and stage events for later progress queries', async () => {
    const context = await harness()
    const id = await one(context)
    const turn = context.driver.last()
    turn.channel.push({ kind: 'text', at: now(), text: 'worker output ' + 'x'.repeat(3000) })
    turn.channel.push({ kind: 'tool', at: now(), name: 'read_file', detail: { content: 'not retained' } })
    turn.channel.push({ kind: 'usage', at: now(), usage: { input: 17, output: 9 } })
    turn.report({ state: 'progress', summary: 'halfway', at: now() })
    await wait(10)
    const events = context.store.events.list(id)
    const text = events.find(event => event.type === 'worker_text')?.detail?.text as string
    expect(text).toHaveLength(2000)
    expect(text.endsWith('…')).toBe(true)
    expect(events.find(event => event.type === 'worker_tool')).toMatchObject({ detail: { name: 'read_file' } })
    expect(events.find(event => event.type === 'worker_tool')?.detail).not.toHaveProperty('content')
    const ticket = context.store.tickets.get(id)!
    expect(events.find(event => event.type === 'worker_tool')?.detail).toMatchObject({
      assignmentId: ticket.assignments.at(-1)!.id, attemptId: ticket.executionAttempt!.token, backend: 'dsh',
    })
    expect(events.find(event => event.type === 'worker_usage')?.detail?.usage).toEqual({ input: 17, output: 9 })
    expect(events.filter(event => event.type === 'worker_phase').at(-1)?.detail).toMatchObject({ phase: 'report', reportState: 'progress' })
  })

  it('final completed ends the turn; a turn without a final report becomes a waiting Report', async () => {
    const context = await harness()
    const id = await one(context)
    context.driver.last().final({ status: 'completed', text: 'finished the work' })
    await wait(5)
    const ticket = context.store.tickets.get(id)!
    expect(ticket.assignments.at(-1)!.report).toMatchObject({ state: 'waiting', summary: 'finished the work' })
    expect(ticket.ended).toBeUndefined()
    expect(context.executor.used()).toBe(0)
  })

  it('final failed is a visible failure with its cause on the Ticket and the board', async () => {
    const context = await harness()
    const id = await one(context)
    context.driver.last().final({ status: 'failed', text: '', error: { code: 'backend_error', message: 'boom', retryable: true } })
    await wait(5)
    const ticket = context.store.tickets.get(id)!
    expect(ticket.ended).toBeUndefined()
    const turnEnded = context.store.events.list(id).find(event => event.type === 'turn_ended')
    expect(turnEnded).toMatchObject({ detail: { reason: 'failed', error: 'backend_error: boom' } })
    expect(ticket.assignments.at(-1)!.report).toMatchObject({ state: 'waiting' })
    expect(problems(context.health)).toContain('boom')
  })

  it('a channel that closes without a final event is a protocol error, never a completion', async () => {
    const context = await harness()
    const id = await one(context)
    context.driver.last().closeWithoutFinal()
    await wait(5)
    const ticket = context.store.tickets.get(id)!
    expect(ticket.ended).toBeUndefined()
    expect(ticket.result).toBeUndefined()
    expect(problems(context.health)).toContain('without a final event')
    expect(ticket.recovery?.state).toBe('uncertain')
    expect(ticket.executionAttempt?.phase).toBe('started')
    expect(canRetry(ticket)).toBe(false)
  })

  it('a final with no started hand-over is reported as a give-up, not as work that ran', async () => {
    const context = await harness({ autoStart: false })
    const id = context.engine.createTicket({ title: 'never-started', text: 'work' }).ticketId!
    const running = context.settle()
    await wait(20)
    context.driver.last().final({ status: 'failed', text: '', error: { code: 'spawn_failed', message: 'no binary', retryable: false } })
    await running
    await wait(5)
    const ticket = context.store.tickets.get(id)!
    expect(ticket.assignments.at(-1)!.state).toBe('pending')
    expect(ticket.assignments.at(-1)!.report!.summary).toContain('before its start was recorded')
    expect(ticket.attention).toBeDefined()
    expect(canRetry(ticket)).toBe(true)
  })
})

describe('asset input delivery', () => {
  async function asset(c: Awaited<ReturnType<typeof harness>>) {
    const bytes = Buffer.from([0, 255, 137, 80, 78, 71]), blob = await new AssetObjects(c.dir).put(bytes), at = now()
    c.store.assets.save({ id: 'input-png', name: 'image', kind: 'reference', createdAt: at, updatedAt: at, archived: false, status: 'active', ownerProfileId: 'default', storageVersion: 1, storage: { kind: 'managed-object', ...blob, mimeType: 'image/png' }, source: { ticketId: 'gone', path: 'result.png' }, revision: 1, contentHash: blob.objectKey } as any)
    const catalog = new AssetCatalog(c.store, c.dir)
    return { bytes, catalog, ref: catalog.resolveMetadata('input-png').ref }
  }
  it('copies exact binary input bytes and feed lists the input-specific path and hash', async () => {
    const c = await harness(), id = await one(c), a = await asset(c)
    const input = c.engine.assetNote(id, 'binary', [a.ref], 'inspect').inputs[0]!
    await c.settle()
    const path = 'attachments/' + input.id + '-asset-input-png-r1.png'
    expect(readFileSync(join(c.engine.require(id).execution!.directory, path))).toEqual(a.bytes)
    expect(c.driver.last().feeds[0]).toContain(path)
    expect(c.driver.last().feeds[0]).toContain(a.ref.contentHash)
    expect(c.engine.require(id).inputs[0]!.deliveredAt).toBeDefined()
  })
  it('keeps queued refs pending and rematerializes them into the resume prompt', async () => {
    const c = await harness(), id = await one(c), a = await asset(c)
    c.driver.last().feedBehavior = () => ({ status: 'queued-for-next-turn', reason: 'later' })
    const input = c.engine.assetNote(id, 'queued', [a.ref], 'next').inputs[0]!
    await c.settle()
    expect(c.engine.require(id).inputs[0]!.deliveredAt).toBeUndefined()
    c.driver.last().final({ status: 'completed', text: 'first' }); await wait(5)
    c.rebuildExecutor(); c.dueNow(id, 'input'); await c.settle()
    expect(c.driver.resumes[0]!.spec.prompt).toContain('attachments/' + input.id + '-asset-input-png-r1.png')
    expect(c.driver.resumes[0]!.spec.prompt).toContain(a.ref.contentHash)
    expect(c.engine.require(id).inputs[0]!.deliveredAt).toBeDefined()
  })
  it.each(['revoked', 'missing'])('refuses %s asset without feeding', async mode => {
    const c = await harness(), id = await one(c), a = await asset(c)
    c.engine.assetNote(id, mode, [a.ref], 'no')
    if (mode === 'revoked') a.catalog.patch(a.ref.id, { archived: true })
    else vi.spyOn(AssetCatalog.prototype, 'resolveBytes').mockRejectedValue(new Error('missing object'))
    await c.settle()
    expect(c.driver.last().feeds).toEqual([])
    expect(c.engine.require(id).inputs[0]!.deliveredAt).toBeUndefined()
    vi.restoreAllMocks()
  })
  it.each(['ended', 'swapped'])('does not copy or feed after delayed resolve and %s assignment', async mode => {
    const c = await harness(), id = await one(c), a = await asset(c)
    let release!: () => void, reached!: () => void
    const gate = new Promise<void>(r => { release = r }), entered = new Promise<void>(r => { reached = r })
    const original = AssetCatalog.prototype.resolveBytes
    const spy = vi.spyOn(AssetCatalog.prototype, 'resolveBytes').mockImplementation(async function(this: AssetCatalog, ref) { const resolved = await original.call(this, ref); reached(); await gate; return resolved })
    const input = c.engine.assetNote(id, mode, [a.ref], 'race').inputs[0]!
    const delivering = c.settle(); await entered
    if (mode === 'ended') c.engine.stopTicket(id)
    else { c.save({ paused: true }); c.engine.assignmentInterrupted(id, c.engine.require(id).assignments.at(-1)!.id, 'replace') }
    release(); await delivering; spy.mockRestore()
    expect(c.driver.turns[0]!.feeds).toEqual([])
    expect(existsSync(join(c.engine.require(id).execution!.directory, 'attachments', input.id + '-asset-input-png-r1.png'))).toBe(false)
    expect(c.engine.require(id).inputs[0]!.deliveredAt).toBeUndefined()
  })
})

describe('inputs', () => {
  it('delivers a waiting Input through feed, naming the operator', async () => {
    const context = await harness()
    const id = await one(context)
    context.engine.note(id, 'more please')
    await context.settle()
    const turn = context.driver.last()
    expect(turn.feeds).toHaveLength(1)
    expect(turn.feeds[0]).toContain('A note from the operator')
    expect(turn.feeds[0]).toContain('more please')
    expect(context.store.tickets.get(id)!.inputs[0]!.deliveredAt).toBeDefined()
  })

  it('queued-for-next-turn stays durable until a resumed prompt actually includes it', async () => {
    const context = await harness()
    const id = await one(context)
    context.driver.last().feedBehavior = () => ({ status: 'queued-for-next-turn', reason: 'dsh 每轮一进程' })
    context.engine.note(id, 'later')
    await context.settle()
    expect(context.driver.last().feeds).toHaveLength(1)
    expect(context.store.tickets.get(id)!.inputs[0]!.deliveredAt).toBeUndefined()
    expect(context.lines.join('\n')).toContain('remains in Ordin')
    // A second pass does not feed it again: it left Ordin's hands exactly once.
    await context.settle()
    expect(context.driver.last().feeds).toHaveLength(1)
    context.driver.last().report({state:'ready',summary:'stale completion',at:now()})
    await wait(5)
    expect(context.store.tickets.get(id)!.ended).toBeUndefined()
    context.driver.last().final({status:'completed',text:'first done'})
    await wait(5)
    context.dueNow(id, 'input')
    await context.settle()
    expect(context.driver.resumes).toHaveLength(1)
    expect(context.driver.resumes[0]!.spec.prompt).toContain('later')
    expect(context.store.tickets.get(id)!.inputs[0]!.deliveredAt).toBeDefined()
    expect(context.driver.last().feeds).toHaveLength(0)
  })

  it('a closed turn fails the delivery visibly instead of silently dropping the input', async () => {
    const context = await harness()
    const id = await one(context)
    context.driver.last().feedBehavior = () => ({ status: 'closed', reason: 'turn over' })
    context.engine.note(id, 'too late')
    await context.settle()
    const assignment = context.store.tickets.get(id)!.assignments.at(-1)!
    expect(assignment.deliveryError).toContain('closed before the input arrived')
    expect(context.store.tickets.get(id)!.inputs[0]!.deliveredAt).toBeUndefined()
  })

  it('holds automated input while a person is being asked, and sends the answer at once', async () => {
    const context = await harness()
    const id = await one(context)
    context.driver.last().report({ state: 'blocked', summary: 'need a decision', question: 'which one?', at: now() })
    await wait(5)
    expect(context.store.tickets.get(id)!.attention).toBeDefined()
    context.engine.note(id, 'automated note')
    await context.settle()
    expect(context.driver.last().feeds).toEqual([])
    context.engine.answer(id, 'the first one')
    context.dueNow(id, 'input')
    await context.settle()
    const feeds = context.driver.last().feeds
    expect(feeds).toHaveLength(2)
    expect(feeds[0]).toContain('automated note')
    expect(feeds[1]).toContain('The answer to your question')
  })

  it('refuses a persisted session pointing outside the Ticket workspace', async () => {
    const context = await harness()
    const id = await one(context)
    context.driver.last().final({ status: 'completed', text: 'first turn done' })
    await wait(5)
    context.store.set('ordin:backend-session:' + id, { backend: 'dsh', id: 'stolen-session', cwd: '/outside-ticket', savedAt: now() })
    context.rebuildExecutor()
    context.engine.note(id, 'followup')
    await context.settle()
    expect(context.driver.resumes).toHaveLength(0)
    expect(context.store.tickets.get(id)?.assignments.at(-1)?.deliveryError).toContain('Invalid persisted backend session')
  })

  it('resumes the persisted session after rebuilding the executor without its memory', async () => {
    const context = await harness()
    const id = await one(context)
    context.driver.last().final({ status: 'completed', text: 'first turn done' })
    await wait(5)
    context.rebuildExecutor()
    context.engine.note(id, 'second turn input')
    await context.settle()
    expect(context.driver.resumes).toHaveLength(1)
    expect(context.driver.resumes[0]!.session.id).toBe('session-turn-1')
    expect(context.driver.prepareSessions.at(-1)?.id).toBe('session-turn-1')
    expect(context.driver.resumes[0]!.spec.prompt).toContain('second turn input')
    expect(context.driver.resumes[0]!.spec.prompt).toContain('exactly one ordin-report fenced JSON block')
    expect(context.driver.last().feeds).toHaveLength(0)
  })

  it('names the worker that wrote an agent-authored input, and never calls it the operator', async () => {
    const context = await harness({ settings: { executor: { maxWorkers: 2 } } })
    const writer = context.engine.createTicket({ title: 'writer', text: 'write' }).ticketId!
    const reader = context.engine.createTicket({ title: 'reader', text: 'read' }).ticketId!
    await context.settle()
    context.engine.noteFromWorker(writer, reader, 'a note from a peer')
    await context.settle()
    // Launch order is not guaranteed to match creation order: find the reader's own turn.
    const readerTurn = context.driver.turns[context.driver.launches.findIndex(spec => spec.ticketId === reader)]!
    const feed = readerTurn.feeds[0] ?? ''
    expect(feed).toContain('not from the operator')
    expect(feed).not.toContain('A note from the operator')
  })
})

describe('stop and resume', () => {
  it('cancels the running turn and its process group', async () => {
    const context = await harness()
    const id = await one(context)
    const assignmentId = context.store.tickets.get(id)!.assignments.at(-1)!.id
    context.proc.spawn({ owner: id, argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], groupId: assignmentId, graceMs: 20 })
    const turn = context.driver.last()
    context.engine.stopTicket(id)
    await context.executor.drain()
    expect(turn.cancels).toEqual(['A person stopped this Ticket'])
    expect(context.store.events.list(id).filter(event => event.type === 'stop_result').at(-1)?.detail).toMatchObject({
      ok: true, turnCancelled: true, processes: [{ groupId: assignmentId, status: 'canceled', exitCode: null }],
    })
    expect(context.store.tickets.get(id)!.ended).toMatchObject({ outcome: 'stopped' })
    turn.final({ status: 'cancelled', text: '' })
    await wait(5)
    expect(context.store.tickets.get(id)!.ended).toMatchObject({ outcome: 'stopped' })
  })

  it('leaves the closing turn intact when only background work stops', async () => {
    const context = await harness()
    const id = await one(context)
    const turn = context.driver.last()
    await context.executor.haltBackground(id, 'reported done')
    expect(turn.cancels).toEqual([])
  })

  it('never cancels a replacement turn after an older halt reaches late cleanup', async () => {
    const context = await harness()
    const id = await one(context)
    const original = context.driver.last()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const reached = new Promise<void>(resolve => { entered = resolve })
    original.cancelBehavior = async () => { entered(); await gate }
    const ending = context.executor.halt(id, 'closing turn', false)
    await reached
    // The Assignment is replaced while the old stop is still inside cancel.
    context.engine.assignmentInterrupted(id, context.store.tickets.get(id)!.assignments.at(-1)!.id, 'retry')
    const next = context.store.tickets.get(id)!.assignments.at(-1)!.id
    context.store.enqueueEffect('launch', key('launch', id, next), { ticketId: id, assignmentId: next })
    original.final({ status: 'cancelled', text: '' })
    release()
    await ending
    await context.settle()
    const replacement = context.driver.last()
    expect(replacement).not.toBe(original)
    expect(original.cancels).toEqual(['closing turn'])
    expect(replacement.cancels).toEqual([])
  })

  it('rejects explicit halt and retains failed stop evidence in drain until a successful retry', async () => {
    const context = await harness()
    const id = await one(context)
    const turn = context.driver.last()
    turn.cancelBehavior = async () => { throw new Error('kill failed') }
    await expect(context.executor.halt(id, 'stop failed', false)).rejects.toThrow(/kill failed/)
    expect(context.store.events.list(id).filter(event => event.type === 'stop_result').at(-1)?.detail).toMatchObject({ ok: false, turnCancelled: false, error: expect.stringContaining('kill failed') })
    expect(problems(context.health)).toContain('Could not stop the work')
    await expect(context.executor.drain()).rejects.toThrow(/stop|drain/i)
    turn.cancelBehavior = async () => {}
    await context.executor.halt(id, 'retry', false)
    await expect(context.executor.drain()).resolves.toBeUndefined()
  })

  it('refuses a stale stop retry after its attempt was replaced', async () => {
    const context = await harness()
    const id = await one(context)
    const original = context.driver.last()
    original.cancelBehavior = async () => { throw new Error('kill failed') }
    const firstAssignment = context.store.tickets.get(id)!.assignments.at(-1)!.id
    await expect(context.executor.halt(id, 'stop failed', false)).rejects.toThrow(/kill failed/)
    // The attempt is replaced: the failed stop's evidence belongs to the OLD Assignment, never the new one.
    context.engine.assignmentInterrupted(id, firstAssignment, 'retry')
    original.final({ status: 'cancelled', text: '' })
    const next = context.store.tickets.get(id)!.assignments.at(-1)!.id
    context.store.enqueueEffect('launch', key('launch', id, next), { ticketId: id, assignmentId: next })
    await context.settle()
    expect(context.driver.last()).not.toBe(original)
    await expect(context.executor.retryFailedStops()).rejects.toThrow(/stop retry failed/i)
    expect(context.driver.last().cancels).toEqual([])
  })
})

describe('stuck launches', () => {
  it('keeps counting an in-flight launch and rescues it without launching twice', async () => {
    const context = await harness()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    context.driver.prepareBehavior = async spec => { await gate; return { ...spec, preparedAt: now() } }
    const id = context.engine.createTicket({ title: 'slow', text: 'work' }).ticketId!
    const running = context.settle()
    for (let tries = 0; tries < 50 && context.driver.prepared.length === 0; tries++) await wait(5)
    expect(context.driver.prepared).toHaveLength(1)
    expect(context.executor.stuckLaunches(0, Date.now()).map(item => item.ticketId)).toEqual([id])
    expect(context.executor.used()).toBe(1)
    context.executor.rescueStuckLaunch(id, context.store.tickets.get(id)!.assignments.at(-1)!.id)
    release()
    await running
    await context.settle()
    expect(context.driver.launches).toHaveLength(1)
    expect(context.executor.stuckLaunches(0, Date.now())).toEqual([])
    expect(context.executor.used()).toBe(1)
  })

  it('does not launch when an asset is archived during asynchronous driver preparation', async () => {
    const context = await harness()
    const catalog = new AssetCatalog(context.store, context.dir)
    const imported = catalog.import({ text: 'pinned bytes', name: 'input', kind: 'document' })
    const ref = catalog.resolve(imported.id).ref
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    context.driver.prepareBehavior = async spec => { await gate; return { ...spec, preparedAt: now() } }
    const id = context.engine.createTicket({ title: 'revoked-during-driver-prepare', text: 'work', assetRefs: [ref] }).ticketId!
    const running = context.settle()
    for (let tries = 0; tries < 50 && context.driver.prepared.length === 0; tries++) await wait(5)
    expect(context.driver.prepared).toHaveLength(1)
    catalog.patch(ref.id, { archived: true })
    release()
    await running
    expect(context.driver.launches).toEqual([])
    expect(context.store.tickets.get(id)?.executionAttempt).toBeUndefined()
  })

  it.each(['dsh', 'codex', 'claude'] as const)('does not launch %s when its pinned skill is disabled during prepare', async backend => {
    const c = await harness()
    const skill = c.prompts.saveSkill({ name: 'revoked', title: 'Revoked', description: 'fixture', content: 'Synthetic skill' })
    const skillRefs = [{ name: skill.name, revision: skill.revision!, contentHash: skill.contentHash! }]
    const id = c.engine.createTicket({ title: 'skill revocation', text: 'work', skillRefs }).ticketId!
    c.engine.annotate(id, { workerBackend: backend })
    c.driver.prepareBehavior = spec => {
      expect(spec.prompt).toContain('revoked revision 1')
      c.prompts.setSkillEnabled(skill.name, false)
      return { ...spec, preparedAt: now() }
    }
    await c.settle()
    expect(c.driver.prepared).toHaveLength(1)
    expect(c.driver.launches).toEqual([])
    expect(c.engine.require(id).executionAttempt).toBeUndefined()
  })

  it('does not launch after a stop commits during prepare', async () => {
    const context = await harness()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    context.driver.prepareBehavior = async spec => { await gate; return { ...spec, preparedAt: now() } }
    const id = context.engine.createTicket({ title: 'stopped-during-prepare', text: 'work' }).ticketId!
    const running = context.settle()
    for (let tries = 0; tries < 50 && context.driver.prepared.length === 0; tries++) await wait(5)
    context.engine.stopTicket(id)
    await context.executor.halt(id, 'stop during prepare', false)
    release()
    await running
    context.dueNow(id)
    await context.settle()
    expect(context.driver.launches).toEqual([])
    expect(context.store.tickets.get(id)!.ended).toMatchObject({ outcome: 'stopped' })
  })
})

describe('files that came with the request', () => {
  it('copies an outside attachment into attachments/ before the worker starts', async () => {
    const context = await harness()
    const dir = tempDir('ordin-attach-')
    const source = join(dir, 'report.csv')
    writeFileSync(source, 'a,b\n1,2\n', 'utf8')
    const id = context.engine.createTicket({ title: 'with file', text: 'use it', attachments: [source] }).ticketId!
    await context.settle()
    const directory = context.store.tickets.get(id)!.execution!.directory
    expect(readFileSync(join(directory, 'attachments', 'report.csv'), 'utf8')).toBe('a,b\n1,2\n')
    expect(context.driver.launches).toHaveLength(1)
  })

  it('refuses a symbolic-link attachment as a prepare failure', async () => {
    const context = await harness()
    const dir = tempDir('ordin-attach-')
    const real = join(dir, 'real.txt')
    writeFileSync(real, 'x', 'utf8')
    const link = join(dir, 'link.txt')
    symlinkSync(real, link)
    const id = context.engine.createTicket({ title: 'link', text: 'x', attachments: [link] }).ticketId!
    await context.settle()
    const report = context.store.tickets.get(id)!.assignments.at(-1)!.report!
    expect(report).toMatchObject({ state: 'failed' })
    expect(report.summary).toContain('symbolic links may not be attached')
    expect(context.driver.launches).toEqual([])
  })

  it('refuses a file from inside the work root that no artifact authorized', async () => {
    const context = await harness()
    const producer = await one(context, 'producer')
    const producerDir = context.store.tickets.get(producer)!.execution!.directory
    writeFileSync(join(producerDir, 'secret.txt'), 'not yours', 'utf8')
    const consumer = context.engine.createTicket({ title: 'consumer', text: 'use', attachments: [join(producerDir, 'secret.txt')] }).ticketId!
    await context.settle()
    const report = context.store.tickets.get(consumer)!.assignments.at(-1)!.report!
    expect(report).toMatchObject({ state: 'failed' })
    expect(report.summary).toContain('could not be copied')
  })
})

describe('the prompt and environment a worker is given', () => {
  it.each(['dsh', 'codex', 'claude'] as const)('AL-5 sends only the pinned skill revision to %s', async backend => {
    const c = await harness()
    const old = c.prompts.saveSkill({ name: 'chosen', title: 'Chosen', description: 'old craft', content: 'EXACT OLD CONTENT' })
    const refs = [{ name: old.name, revision: old.revision!, contentHash: old.contentHash! }]
    const id = c.engine.createTicket({ title: 'pinned', text: 'perform request', skillRefs: refs }).ticketId!
    c.prompts.saveSkill({ name: 'chosen', title: 'Chosen', description: 'new craft', content: 'DIFFERENT NEW CONTENT' })
    c.prompts.saveSkill({ name: 'unrequested', title: 'Other', description: 'other', content: 'OTHER CONTENT' })
    c.engine.annotate(id, { workerBackend: backend })
    await c.settle()
    expect(c.driver.launches).toHaveLength(1)
    expect(c.driver.launches[0]).toMatchObject({ backend, ticketId: id })
    const prompt = c.driver.launches[0]!.prompt
    const path = join(c.engine.require(id).execution!.directory, 'skills', old.name, 'r1-' + old.contentHash, 'SKILL.md')
    expect(prompt).toContain('perform request')
    expect(prompt).toContain(old.name + ' revision 1: ' + path)
    expect(prompt).not.toContain('unrequested')
    expect(prompt).not.toContain('revision 2')
    expect(readFileSync(path, 'utf8')).toBe('EXACT OLD CONTENT')
    expect(c.engine.require(id).skillRefs).toEqual(refs)
    expect(c.store.events.list(id).filter(event => event.type === 'skill_used')).toEqual([])
    expect(c.prompts.skills().every(skill => skill.useCount === 0)).toBe(true)
  })

  it('F2-C1 leaves custom skill prompt and directory absent without refs', async () => {
    const c = await harness()
    c.prompts.saveSkill({ name: 'not-selected', title: 'Other', description: 'other', content: 'OTHER CONTENT' })
    const id = c.engine.createTicket({ title: 'no-selection', text: 'perform request' }).ticketId!
    await c.settle()
    expect(c.driver.launches).toHaveLength(1)
    expect(c.driver.launches[0]!.prompt).toContain('perform request')
    expect(c.driver.launches[0]!.prompt).not.toContain('<skills>')
    expect(c.driver.launches[0]!.prompt).not.toContain('not-selected')
    expect(existsSync(join(c.engine.require(id).execution!.directory, 'skills'))).toBe(false)
  })

  it('F2-C1 refuses a pinned hash mismatch before preparing or launching a worker', async () => {
    const c = await harness()
    const saved = c.prompts.saveSkill({ name: 'chosen', title: 'Chosen', description: 'craft', content: 'EXACT CONTENT' })
    const id = c.engine.createTicket({ title: 'bad-hash', text: 'perform request', skillRefs: [{ name: saved.name, revision: saved.revision!, contentHash: '0'.repeat(64) }] }).ticketId!
    await c.settle()
    expect(c.driver.prepared).toEqual([])
    expect(c.driver.launches).toEqual([])
    expect(existsSync(join(c.engine.require(id).execution!.directory, 'skills'))).toBe(false)
    expect(c.store.effectCounts().launch).toBeGreaterThan(0)
  })
  it('carries the request, the scope, the directory and anything added since', async () => {
    const context = await harness()
    const id = await one(context, 'context')
    context.engine.note(id, 'one more thing')
    const ticket = context.store.tickets.get(id)!
    const text = context.executor.taskText(ticket)
    expect(text).toContain(`# Ticket ${id}: context`)
    expect(text).toContain('please do context')
    expect(text).toContain(ticket.mandate.scope)
    expect(text).toContain(ticket.execution!.directory)
    expect(text).toContain('## Added since the request')
    expect(text).toContain('one more thing')
    expect(text).toContain('exactly one ordin-report fenced JSON block')
    expect(text).toContain('progress, waiting, ready, blocked, failed, dropped')
    expect(text).toContain('require a non-empty question')
    expect(text).toContain('relative paths inside this Ticket workspace')
    const fence = String.fromCharCode(96).repeat(3)
    const json = text.split(fence + 'ordin-report\n')[1]!.split('\n' + fence)[0]!
    expect(JSON.parse(json)).toEqual({state:'ready',summary:'Explain what was completed',files:[]})
    const environment = context.executor.environment(ticket)
    expect(environment).toMatchObject({
      ORDIN_TICKET_ID: id,
      ORDIN_TICKET_TITLE: 'context',
      ORDIN_DIRECTORY: ticket.execution!.directory,
      ORDIN_POLICY_VERSION: ticket.mandate.policyVersion,
      ORDIN_SENDER: 'operator',
    })
  })
})

describe('the triage desk', () => {
  it('relays a main-desk triage item and marks it started before the desk turn resolves', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const relayed: { key: string; text: string; ticketId: string }[] = []
    const desk: DeskRelay = { relay: async (relayKey, text, ticketId) => { relayed.push({ key: relayKey, text, ticketId }); await gate } }
    const context = await harness({
      desk,
      settings: { sources: { chat: { enabled: true } }, triage: { enabled: true, sources: ['chat'], desk: 'main' } },
    })
    const trigger: Trigger = {
      id: 'trigger-triage', source: 'telegram', kind: 'chat', at: now(),
      actor: { id: 'operator', kind: 'person' }, text: 'what is this?', title: 'triage me',
    }
    const result = context.engine.receive(trigger)
    expect(result.stored).toBe('stored')
    const id = result.ticketId!
    const running = context.settle()
    await wait(20)
    expect(relayed).toHaveLength(1)
    expect(relayed[0]!.text).toContain('you are the triage desk')
    expect(relayed[0]!.key).toBe(`triage:${context.store.tickets.get(id)!.assignments.at(-1)!.id}`)
    // assignmentStarted came BEFORE the (still blocked) relay: the desk's close_ticket never sees a pending attempt.
    expect(context.store.tickets.get(id)!.assignments.at(-1)!.state).toBe('running')
    expect(context.driver.launches).toEqual([])
    release()
    await running
  })
})

describe('the migration boundary', () => {
  it('executor.ts references no DSH plugin surface', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'app', 'executor.ts'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const forbidden of ['@deepseek-ai', 'sessionController', 'dsh-subprocess', 'ctx.agents', 'subprocess', 'stopBackground', 'promptWorker']) {
      expect(code, `executor.ts must not reference ${forbidden}`).not.toContain(forbidden)
    }
    expect(code).toContain('WorkerDriver')
    expect(code).toContain('ProcessRegistry')
  })
})


describe('acceptance lifecycle ordering (F1-R3)', () => {
  function delayed() {
    let enter!: () => void
    let resolve!: (value: Awaited<ReturnType<typeof runAcceptance>>) => void
    let reject!: (error: Error) => void
    const entered = new Promise<void>(done => { enter = done })
    const verdict = new Promise<Awaited<ReturnType<typeof runAcceptance>>>((done, fail) => { resolve = done; reject = fail })
    const checker: typeof runAcceptance = async () => { enter(); return await verdict }
    const finish = (status: 'accepted' | 'rework' = 'accepted') => resolve({ status, checkedAt: now(), checks: [], ...(status === 'rework' ? { reworkReason: 'fix result' } : {}) })
    return { checker, entered, finish, reject }
  }

  it('sequences ready and final behind acceptance without a transient waiting report', async () => {
    const check = delayed()
    const context = await harness({ acceptanceChecker: check.checker })
    const id = await one(context)
    const turn = context.driver.last()
    turn.report({ state: 'ready', summary: 'finished', at: now() })
    turn.final({ status: 'completed', text: 'finished' })
    await check.entered
    await context.settle()
    expect(context.delivery.reports).toEqual([])
    expect(context.store.tickets.get(id)!.assignments.at(-1)!.report).toBeUndefined()
    check.finish()
    await context.settle()
    expect(context.store.tickets.get(id)!.ended?.outcome).toBe('done')
    expect(context.delivery.reports).toEqual([{ ticketId: id, state: 'ready' }])
  })

  it('discards a verdict after cancellation while the check is pending', async () => {
    const check = delayed()
    const context = await harness({ acceptanceChecker: check.checker })
    const id = await one(context)
    const turn = context.driver.last()
    turn.report({ state: 'ready', summary: 'finished', at: now() })
    await check.entered
    context.engine.stopTicket(id)
    check.finish()
    turn.final({ status: 'cancelled', text: '' })
    await context.settle()
    expect(context.store.tickets.get(id)!.ended?.outcome).toBe('stopped')
    expect(context.store.tickets.get(id)!.acceptance).toBeUndefined()
    expect(context.delivery.reports).toEqual([])
  })

  it('discards a verdict when a new input arrives even if delivered during the check', async () => {
    const check = delayed()
    const context = await harness({ acceptanceChecker: check.checker })
    const id = await one(context)
    const turn = context.driver.last()
    turn.report({ state: 'ready', summary: 'old scope', at: now() })
    await check.entered
    context.engine.note(id, 'new requirement')
    await context.settle()
    check.finish()
    turn.final({ status: 'completed', text: 'old scope' })
    await context.settle()
    const ticket = context.store.tickets.get(id)!
    expect(ticket.ended).toBeUndefined()
    expect(ticket.acceptance).toBeUndefined()
    expect(context.delivery.reports.some(report => report.state === 'ready')).toBe(false)
  })

  it('discards a rework verdict after its assignment is replaced', async () => {
    const check = delayed()
    const context = await harness({ acceptanceChecker: check.checker })
    const id = await one(context)
    const original = context.driver.last()
    const assignment = context.store.tickets.get(id)!.assignments.at(-1)!.id
    original.report({ state: 'ready', summary: 'old attempt', at: now() })
    await check.entered
    context.engine.assignmentInterrupted(id, assignment, 'retry')
    const replacement = context.store.tickets.get(id)!.assignments.at(-1)!.id
    check.finish('rework')
    original.final({ status: 'completed', text: 'old attempt' })
    await context.settle()
    const ticket = context.store.tickets.get(id)!
    expect(ticket.assignments.at(-1)!.id).toBe(replacement)
    expect(ticket.acceptance).toBeUndefined()
    expect(ticket.assignments).toHaveLength(2)
    expect(ticket.inputs.some(input => input.text.includes('fix result'))).toBe(false)
  })

  it('records checker rejection through pump health and turn failure', async () => {
    const check = delayed()
    const context = await harness({ acceptanceChecker: check.checker })
    const id = await one(context)
    context.driver.last().report({ state: 'ready', summary: 'finished', at: now() })
    await check.entered
    check.reject(new Error('acceptance unavailable'))
    await context.settle()
    expect(problems(context.health)).toContain('acceptance unavailable')
    expect(context.store.tickets.get(id)!.ended).toBeUndefined()
    expect(context.store.tickets.get(id)!.acceptance).toBeUndefined()
    expect(context.store.tickets.get(id)!.recovery?.state).toBe('uncertain')
  })

  it('defers replacement launch until the old token settles after rework', async () => {
    const check = delayed()
    const context = await harness({ acceptanceChecker: check.checker })
    const id = await one(context)
    const original = context.driver.last()
    original.report({ state: 'ready', summary: 'unfinished', at: now() })
    await check.entered
    check.finish('rework')
    await wait(50)
    await context.settle()
    expect(context.store.tickets.get(id)!.assignments).toHaveLength(2)
    expect(context.driver.launches).toHaveLength(1)
    expect(context.driver.last()).toBe(original)
    expect(context.store.tickets.get(id)!.executionAttempt?.assignmentId).toBe(context.store.tickets.get(id)!.assignments[0]!.id)
    original.final({ status: 'completed', text: 'unfinished' })
    await wait(10)
    await context.settle()
    expect(context.driver.launches.length + context.driver.resumes.length).toBe(2)
    expect(context.driver.last()).not.toBe(original)
    expect(context.store.tickets.get(id)!.assignments[1]!.state).toBe('running')
  })

  it('reworks before old final and leaves the replacement turn untouched', async () => {
    const check = delayed()
    const context = await harness({ acceptanceChecker: check.checker })
    const id = await one(context)
    const original = context.driver.last()
    original.report({ state: 'ready', summary: 'unfinished', at: now() })
    original.final({ status: 'completed', text: 'unfinished' })
    await check.entered
    check.finish('rework')
    await context.settle()
    const ticket = context.store.tickets.get(id)!
    expect(ticket.assignments).toHaveLength(2)
    expect(ticket.assignments[0]!.endedReason).toBe('rework')
    expect(ticket.assignments[1]!.state).toBe('running')
    expect(ticket.assignments[1]!.report).toBeUndefined()
    expect(ticket.acceptance?.status).toBe('rework')
    expect(context.driver.last()).not.toBe(original)
    expect(context.driver.last().cancels).toEqual([])
    expect(context.delivery.reports).toEqual([])
  })

  it.each(['accepted', 'rework'] as const)('rolls back the %s verdict if its transition fails', async status => {
    const check = delayed()
    const context = await harness({ acceptanceChecker: check.checker })
    const id = await one(context)
    const transition = vi.spyOn(context.engine, status === 'rework' ? 'rework' : 'report')
      .mockImplementation(() => { throw new Error('transition unavailable') })
    context.driver.last().report({ state: 'ready', summary: 'finished', at: now() })
    await check.entered
    check.finish(status)
    await context.settle()
    transition.mockRestore()
    const ticket = context.store.tickets.get(id)!
    expect(ticket.acceptance).toBeUndefined()
    expect(ticket.assignments).toHaveLength(1)
    expect(ticket.ended).toBeUndefined()
    expect(problems(context.health)).toContain('transition unavailable')
  })

  it('includes acceptance criteria in the first worker prompt', async () => {
    const context = await harness()
    context.engine.createTicket({ title: 'criteria', text: 'work', acceptanceCriteria: 'The CSV must contain a total row.' })
    await context.settle()
    expect(context.driver.launches[0]!.prompt).toContain('## Acceptance criteria')
    expect(context.driver.launches[0]!.prompt).toContain('The CSV must contain a total row.')
  })
})

describe('independent acceptance (M1-D integration)', () => {
  const mk = (title: string): Report => ({ state: 'ready', summary: title, at: now() })

  it('accepts a ready report whose named file exists and ends the Ticket done', async () => {
    const context = await harness()
    const id = context.engine.createTicket({ title: 'acc', text: 'work' }).ticketId!
    await context.settle()
    const directory = context.store.tickets.get(id)!.execution!.directory!
    writeFileSync(join(directory, 'result.md'), '# ok\n', 'utf8')
    context.driver.last().report({ ...mk('做完了'), files: ['result.md'] })
    await wait(30)
    const after = context.store.tickets.get(id)!
    expect(after.ended).toMatchObject({ outcome: 'done' })
    expect(after.acceptance).toMatchObject({ status: 'accepted', checks: expect.any(Array) })
    expect(context.delivery.reports.at(-1)).toMatchObject({ ticketId: id, state: 'ready' })
  })

  it('sends a ready with a missing file back for rework, then accepts the fixed retry', async () => {
    const context = await harness()
    const id = context.engine.createTicket({ title: 'acc-rework', text: 'work' }).ticketId!
    await context.settle()
    const directory = context.store.tickets.get(id)!.execution!.directory!
    // Round 1: the worker claims a file that does not exist.
    context.driver.last().report({ ...mk('做完了'), files: ['missing.md'] })
    context.driver.last().final({ status: 'completed', text: '做完了' })
    await wait(30)
    await context.settle()
    const afterRework = context.store.tickets.get(id)!
    expect(afterRework.ended).toBeUndefined()
    expect(afterRework.acceptance).toMatchObject({ status: 'rework' })
    expect(afterRework.assignments).toHaveLength(2)
    expect(afterRework.assignments[0]).toMatchObject({ state: 'ended', endedReason: 'rework' })
    expect(afterRework.assignments[1]!.state).toBe('running')
    expect(afterRework.inputs.at(-1)?.text).toContain('did not pass Ordin acceptance')
    // Round 2: the worker fixes the file and reports again.
    writeFileSync(join(directory, 'missing.md'), '# fixed\n', 'utf8')
    await context.settle()
    context.driver.last().report({ ...mk('修好了'), files: ['missing.md'] })
    await wait(30)
    await context.settle()
    const afterFix = context.store.tickets.get(id)!
    expect(afterFix.ended).toMatchObject({ outcome: 'done' })
    expect(afterFix.acceptance).toMatchObject({ status: 'accepted' })
    expect(afterFix.result?.summary).toBe('修好了')
  })

  it('marks the result unverified once the rework budget is exhausted', async () => {
    const context = await harness()
    const id = context.engine.createTicket({ title: 'acc-unverified', text: 'work' }).ticketId!
    await context.settle()
    for (let round = 0; round <= MAX_REWORK; round++) {
      await context.settle()
      context.driver.last().report({ ...mk('第' + round + '轮'), files: ['never-there.md'] })
      context.driver.last().final({ status: 'completed', text: 'done' })
      await wait(30)
      await context.settle()
    }
    const after = context.store.tickets.get(id)!
    expect(after.ended).toMatchObject({ outcome: 'done' })
    expect(after.acceptance).toMatchObject({ status: 'unverified' })
    expect(after.result?.summary).toContain('could not verify')
    expect(after.assignments.filter(a => a.endedReason === 'rework')).toHaveLength(MAX_REWORK)
  })

  it('marks text-only results unverified without pretending files were checked', async () => {
    const verdict = await runAcceptance({ ticket: { assignments: [] } as unknown as Ticket, report: mk('只有文字'), directory: '/nonexistent' })
    expect(verdict.status).toBe('unverified')
  })
})
