/**
 * M1-H: the whole loop through real HTTP — a stub OpenAI-compatible model, the real coordinator, Engine,
 * Executor, independent acceptance and asset registration, with a fake worker driver that produces a real file.
 *
 * This is the M1 exit story: 对话 → 分流 → 建任务 → 执行 → 独立验收 → 回报.
 */
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { boot } from '../src/app/boot.ts'
import { createRuntime } from '../src/app/runtime.ts'
import { BASE_PATH, REQUEST_HEADER } from '../src/app/http.ts'
import type { DriverHealth, LaunchSpec, RunningTurn, TurnResult, WorkerDriver, WorkerSpec, WorkerEvent, BackendSession } from '../src/drivers/types.ts'
import { TurnChannel } from '../src/drivers/channel.ts'
import { ProcessRegistry } from '../src/app/process.ts'
import { resolveConfig } from '../src/app/config.ts'
import { tempDir } from './helpers/temp.ts'

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`

/** A model that first asks for create_task, then answers with text. */
async function stubModel(server: Server): Promise<{ url: string; calls: number }> {
  const state = { calls: 0 }
  server.on('request', (request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      state.calls++
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (state.calls === 1) {
        response.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'create_task', arguments: JSON.stringify({ title: '整理周报', text: '整理本周工作周报' }) } }] } }] }))
        response.write(sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }))
      } else {
        response.write(sse({ choices: [{ delta: { content: '已经安排好了，完成后我会告诉你。' } }] }))
        response.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
      }
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  return { url: 'http://127.0.0.1:' + address.port, get calls() { return state.calls } }
}

class ProductiveDriver implements WorkerDriver {
  readonly backend = 'codex' as const
  async probe(): Promise<DriverHealth> { return { backend: 'codex', ok: true, checkedAt: new Date().toISOString(), version: 'stub', auth: 'ok', problems: [] } }
  async prepare(spec: WorkerSpec): Promise<LaunchSpec> { return { ...spec, preparedAt: new Date().toISOString() } }
  async launch(spec: LaunchSpec): Promise<RunningTurn> { return this.turn(spec) }
  async resume(_session: BackendSession, spec: LaunchSpec): Promise<RunningTurn> { return this.turn(spec) }
  private turn(spec: LaunchSpec): RunningTurn {
    const channel = new TurnChannel()
    const session: BackendSession = { backend: 'codex', id: 'stub-' + spec.ticketId, cwd: spec.cwd, savedAt: new Date().toISOString() }
    setTimeout(() => {
      channel.push({ kind: 'started', at: new Date().toISOString(), session, pid: 1 })
      try {
        mkdirSync(spec.cwd, { recursive: true })
        writeFileSync(join(spec.cwd, '周报.md'), '# 本周周报\n\n工作内容。\n', 'utf8')
      } catch { /* the acceptance check reports a missing file honestly */ }
      channel.push({ kind: 'report', at: new Date().toISOString(), report: { state: 'ready', summary: '周报已写好', at: new Date().toISOString(), files: ['周报.md'] } })
      channel.push({ kind: 'final', at: new Date().toISOString(), result: { status: 'completed', text: '完成', session } })
      channel.close()
    }, 0)
    return { id: 'turn-' + spec.assignmentId, backend: 'codex', events: channel.iterable, done: Promise.resolve({ status: 'completed', text: '完成', session } as TurnResult), feed: async () => ({ status: 'accepted' }), cancel: async () => {} }
  }
}

const waitFor = async <T>(read: () => T | undefined, timeoutMs = 8000): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe('M1 end-to-end: a message becomes accepted, reported work', () => {
  it('runs 对话 → 建任务 → 执行 → 独立验收 → 回报 and keeps the result after restart', async () => {
    const model = createServer()
    const stub = await stubModel(model)
    const stateDir = tempDir('ordin-e2e-')
    const config = resolveConfig({ stateDir, workRoot: join(stateDir, 'work'), inboxDir: join(stateDir, 'inbox'), port: 0 })
    const startable = () => createRuntime(boot({ config, logger: silent }), {
      logger: silent, driver: new ProductiveDriver(), proc: new ProcessRegistry(), notifier: null,
    })
    let runtime = startable()
    try {
      await runtime.start()
      runtime.saveSettings({
        acceptMode: 'auto', allowedSenders: ['operator'],
        deskLlm: { baseUrl: stub.url, model: 'stub-model', provider: 'stub', apiKeyEnv: '', temperature: 0, maxTokens: 512 },
      })
      const response = await fetch(runtime.status().panel.replace(/\/$/, '') + '/api/conversations/e2e-1/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [REQUEST_HEADER]: '1' },
        body: JSON.stringify({ text: '帮我整理本周工作周报' }),
      })
      expect(response.status).toBe(200)
      const body = await response.json() as { reply: string; sent?: string[] }
      expect(body.reply).toContain('安排')
      expect(stub.calls).toBeGreaterThanOrEqual(2)

      const ticket = await waitFor(() => runtime.store.tickets.list().find(candidate => candidate.title === '整理周报'))
      expect(ticket.conversationId).toBe('e2e-1')
      const finished = await waitFor(() => {
        const current = runtime.store.tickets.get(ticket.id)!
        return current.ended === undefined ? undefined : current
      })
      expect(finished.ended).toMatchObject({ outcome: 'done' })
      expect(finished.acceptance).toMatchObject({ status: 'accepted' })
      expect(finished.result?.files).toContain('周报.md')
      await waitFor(() => runtime.store.conversationMessages.list('e2e-1').find(row => row.ticketId === ticket.id))
      // Recovery may replay a durable report after its effect was already delivered.
      runtime.delivery.report(finished, { state: 'ready', summary: finished.result!.summary, files: finished.result!.files, at: finished.result!.at })
      await runtime.effects.runDue()
      expect(runtime.store.conversationMessages.list('e2e-1').filter(row => row.ticketId === ticket.id)).toHaveLength(1)

      const history = await fetch(runtime.status().panel.replace(/\/$/, '') + '/api/conversations/e2e-1/messages', { headers: { [REQUEST_HEADER]: '1' } })
      const rows = (await history.json() as { messages: { role: string; content?: string; ticketId?: string; report?: { state: string; summary: string }; acceptance?: { status: string } }[] }).messages
      expect(rows.map(row => row.role)).toContain('user')
      const outcome = rows.find(row => row.role === 'ordin' && row.ticketId === ticket.id)!
      expect(outcome).toMatchObject({ report: { state: 'ready', summary: '周报已写好' }, acceptance: { status: 'accepted' } })
      expect(outcome.content).toContain('周报已写好')
      expect(outcome.content).toContain('Acceptance: accepted')
      expect(stub.calls).toBe(2)
      const otherHistory = await fetch(runtime.status().panel.replace(/\/$/, '') + '/api/conversations/unrelated/messages', { headers: { [REQUEST_HEADER]: '1' } })
      expect((await otherHistory.json() as { messages: unknown[] }).messages).toEqual([])

      const asset = await waitFor(() => runtime.store.assets.list({ includeArchived: true })[0])
      expect(asset).toMatchObject({ source: { ticketId: ticket.id } })

      await runtime.stop()
      expect(existsSync(join(stateDir, 'ordin.lock'))).toBe(false)
      runtime = startable()
      await runtime.start()
      const get = async (route: string) => {
        const reply = await fetch(runtime.status().panel + 'api/' + route, { headers: { [REQUEST_HEADER]: '1' } })
        expect(reply.status, route).toBe(200)
        return await reply.json()
      }
      expect(await get(`tickets/${ticket.id}`)).toMatchObject({
        id: ticket.id, stage: 'done', ended: finished.ended, acceptance: { status: 'accepted' }, result: finished.result,
      })
      expect(runtime.store.tickets.open().map(row => row.id)).not.toContain(ticket.id)
      const { events } = await get(`tickets/${ticket.id}/events`) as { events: { type: string; detail?: unknown }[] }
      expect(events.filter(event => event.type === 'report')).toEqual([
        expect.objectContaining({ detail: expect.objectContaining({ state: 'ready' }) }),
      ])
      const reopenedHistory = await get('conversations/e2e-1/messages') as { messages: typeof rows }
      expect(reopenedHistory.messages.filter(row => row.ticketId === ticket.id)).toEqual([outcome])
      expect(stub.calls).toBe(2)
    } finally {
      await runtime.stop()
      await new Promise<void>(resolve => model.close(() => resolve()))
    }
  }, 30000)
})
