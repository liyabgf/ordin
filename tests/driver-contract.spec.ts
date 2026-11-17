import { describe, expect, it } from 'vitest'
import { failedResult, type BackendSession, type LaunchSpec, type RunningTurn, type WorkerDriver } from '../src/drivers/types.ts'

const session: BackendSession = { backend: 'dsh', id: 'session-1', cwd: '/tmp/ticket-1', savedAt: '2026-11-15T00:00:00Z' }
const spec: LaunchSpec = { ticketId: 'ticket-1', assignmentId: 'assignment-1', cwd: '/tmp/ticket-1', prompt: '做事', access: 'full', preparedAt: '2026-11-15T00:00:00Z' }

function fakeDriver(): WorkerDriver {
  const turn = (): RunningTurn => ({
    id: 'turn-1', backend: 'dsh', events: (async function * () {})(), done: Promise.resolve({ status: 'completed', text: 'done', session }),
    feed: async () => ({ status: 'queued-for-next-turn', reason: 'dsh headless 每轮一进程' }),
    cancel: async () => {},
  })
  return {
    backend: 'dsh',
    probe: async () => ({ backend: 'dsh', ok: true, checkedAt: '2026-11-15T00:00:00Z', version: '0.2.2-rc.3', auth: 'ok', problems: [] }),
    prepare: async value => ({ ...value, preparedAt: '2026-11-15T00:00:00Z' }),
    launch: async () => turn(),
    resume: async () => turn(),
  }
}

describe('WorkerDriver 冻结契约', () => {
  it('prepare 保留 Ticket/Assignment/cwd/prompt/access 身份', async () => {
    const prepared = await fakeDriver().prepare(spec)
    expect(prepared).toMatchObject({ ticketId: 'ticket-1', assignmentId: 'assignment-1', cwd: '/tmp/ticket-1', access: 'full' })
  })

  it('launch 与 resume 都返回同一个 RunningTurn 形状', async () => {
    const driver = fakeDriver()
    const launched = await driver.launch(spec)
    const resumed = await driver.resume(session, spec)
    for (const turn of [launched, resumed]) {
      expect(turn.backend).toBe('dsh')
      expect(await turn.done).toMatchObject({ status: 'completed', text: 'done' })
      expect(await turn.feed('追问')).toMatchObject({ status: 'queued-for-next-turn' })
    }
  })

  it('失败结果必须带错误码，不能伪装成 completed', () => {
    const result = failedResult('auth_expired', '登录过期', false, session)
    expect(result.status).toBe('failed')
    expect(result.error).toMatchObject({ code: 'auth_expired', retryable: false })
    expect(failedResult('cancelled', '取消').status).toBe('cancelled')
  })
})
