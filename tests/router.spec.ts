import { describe, expect, it } from 'vitest'
import { DriverRouter } from '../src/drivers/router.ts'
import type { BackendKind, BackendSession, LaunchSpec, RunningTurn, WorkerDriver } from '../src/drivers/types.ts'

const spec = { ticketId: 'ticket', assignmentId: 'attempt', prompt: 'work', cwd: '/tmp', access: 'edit' as const }
function fixture() {
  let selected: BackendKind = 'dsh'
  const calls: string[] = []
  const driver = (backend: BackendKind): WorkerDriver => ({
    backend,
    probe: async () => ({ backend, ok: true, auth: 'ok', checkedAt: '', problems: [] }),
    prepare: async value => { calls.push(backend + ':prepare'); return { ...value, preparedAt: '' } },
    launch: async () => { calls.push(backend + ':launch'); return { backend } as RunningTurn },
    resume: async () => { calls.push(backend + ':resume'); return { backend } as RunningTurn },
  })
  const router = new DriverRouter({ dsh: driver('dsh'), codex: driver('codex'), claude: driver('claude') }, () => selected)
  return { router, calls, select: (backend: BackendKind) => { selected = backend } }
}
describe('backend routing', () => {
  it.each(['dsh', 'codex', 'claude'] as const)('rejects unimplemented tool registration on %s before driver preparation', async backend => {
    const {router, calls} = fixture()
    const requested = {...spec, backend, mcpReport: {}}
    const session: BackendSession = {backend, id:'prior', cwd:spec.cwd, savedAt:''}
    await expect(router.prepare(requested)).rejects.toThrow('Tool registration is not supported')
    await expect(router.prepare(requested, session)).rejects.toThrow('Tool registration is not supported')
    expect(calls).toEqual([])
  })
  it('reads changed settings for new work without restarting the server', async () => {
    const { router, calls, select } = fixture()
    await router.launch(await router.prepare(spec))
    select('codex')
    expect((await router.probe()).backend).toBe('codex')
    await router.launch(await router.prepare({ ...spec, assignmentId: 'next' }))
    expect(calls).toEqual(['dsh:prepare', 'dsh:launch', 'codex:prepare', 'codex:launch'])
  })
  it('pins prepared work across a concurrent settings change', async () => {
    const { router, calls, select } = fixture()
    const prepared = await router.prepare(spec)
    select('claude')
    expect((await router.launch(prepared)).backend).toBe('dsh')
    expect(calls).toEqual(['dsh:prepare', 'dsh:launch'])
  })
  it('routes a Ticket to its explicit backend instead of the global default', async () => {
    const { router, calls } = fixture()
    await router.launch(await router.prepare({ ...spec, backend: 'claude' }))
    expect(calls).toEqual(['claude:prepare', 'claude:launch'])
  })
  it('resumes with the session owner even when another backend is selected', async () => {
    const { router, calls, select } = fixture()
    select('codex')
    const session: BackendSession = { backend: 'claude', id: 'old', cwd: '/tmp', savedAt: '' }
    const prepared = await router.prepare(spec, session)
    expect((await router.resume(session, prepared)).backend).toBe('claude')
    expect(calls).toEqual(['claude:prepare', 'claude:resume'])
  })
  it('does not check an unavailable selected backend when resuming another owner', async () => {
    const { router, select } = fixture()
    select('codex')
    const session: BackendSession = { backend: 'claude', id: 'old', cwd: '/tmp', savedAt: '' }
    const drivers = {
      dsh: { backend: 'dsh' } as WorkerDriver,
      codex: { backend: 'codex', prepare: async () => { throw new Error('Codex not logged in') } } as unknown as WorkerDriver,
      claude: { backend: 'claude', probe: async () => ({backend:'claude',ok:true,auth:'ok',checkedAt:'',problems:[]}), prepare: async (s: typeof spec) => ({ ...s, preparedAt: '' }), launch: async () => ({backend:'claude'} as RunningTurn), resume: async () => ({ backend: 'claude' } as RunningTurn) } as WorkerDriver,
    } as const
    const recovery = new DriverRouter(drivers, () => 'codex')
    await expect(recovery.prepare(spec)).rejects.toThrow('not logged in')
    const prepared = await recovery.prepare(spec, session)
    expect((await recovery.resume(session, prepared)).backend).toBe('claude')
    const wrong = await router.prepare(spec)
    await expect(router.resume(session, wrong)).rejects.toThrow('does not match')
  })

  it('rejects unprepared or reused launch specs', async () => {
    const { router } = fixture()
    await expect(router.launch({ ...spec, preparedAt: '' })).rejects.toThrow('prepared')
    const prepared = await router.prepare(spec)
    await router.launch(prepared)
    await expect(router.launch(prepared)).rejects.toThrow('prepared')
  })
})
