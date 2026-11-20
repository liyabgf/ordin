/** The conversation API: a real HTTP server, a stub coordinator, and the honest 503 when no model is configured. */
import { describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { join } from 'node:path'
import { Engine, parseSettings, settingsPolicy, type Delivery, type Executor, type Report, type Ticket } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { HealthBoard } from '../src/app/health.ts'
import { Prompts } from '../src/app/prompts.ts'
import { Uploads } from '../src/app/uploads.ts'
import { readChatAction, runCoordinatorTurn } from '../src/app/coordinator.ts'
import { BASE_PATH, REQUEST_HEADER, serve, type HttpHost } from '../src/app/http.ts'
import { tempDir } from './helpers/temp.ts'

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
class FakeExecutor implements Executor {
  prepare(ticket: Ticket): Ticket { return ticket }
  start(): void {}
  deliver(): void {}
  stop(): void {}
}

function host(dir: string, overrides: Partial<HttpHost> = {}): HttpHost {
  const store = new Store(join(dir, 'api.sqlite3'))
  let current = parseSettings({ acceptMode: 'auto', allowedSenders: ['operator'] })
  const engine = new Engine({
    repos: store, tx: store, inputConsumptions: store.inputConsumptions, policy: () => settingsPolicy(current),
    executor: new FakeExecutor(),
    delivery: { report: (_t: Ticket, _r: Report): void => {} } as Delivery,
  })
  return {
    context: { logger: silent },
    serverPort: () => 0,
    engine,
    decisions: () => [],
    dismissDecision: () => { throw new Error('not wired') },
    raiseDecision: () => 'd1',
    store,
    chatAction: (conversationId, actionId) => readChatAction(store, conversationId, actionId),
    health: new HealthBoard(),
    prompts: new Prompts(store),
    sources: { source: () => undefined },
    sourceStatus: () => ({}),
    delivery: { sends: () => ({ queued: 0, nowhere: 0 }) },
    deleteTicket: async () => { throw new Error('not wired') },
    artifacts: () => [],
    mountedAt: () => '2026-11-15T00:00:00Z',
    executor: { used: () => 0, sandbox: { listWorkspace: async () => ({ files: [], count: 0, truncated: false }), readWorkspaceFile: async () => ({ base64: '', size: 0, mtime: '' }) } },
    uploads: new Uploads(dir),
    createTicketWithUploads: () => { throw new Error('not wired') },
    passes: { requestPass: () => {} },
    nudge: async () => {},
    progress: () => ({ sessionId: '', sessionTitle: '', loaded: false, recentTools: [] }),
    recipes: () => [],
    machine: { view: () => ({}), promptMaxChars: () => 100_000 },
    settings: () => current,
    saveSettings: value => { current = parseSettings(value); return current },
    panelHtml: () => '<html>panel</html>',
    setupProblem: () => undefined,
    mainSession: () => ({ exists: false, running: false, busy: false }),
    createMainSession: async () => ({ error: 'none' }),
    ...overrides,
  }
}

const headers = { [REQUEST_HEADER]: '1' }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

describe('conversation API', () => {
  it('finds the same ticket after the client disconnects, a concurrent duplicate, and a server restart', async () => {
    const dir = tempDir('ordin-action-receipt-')
    const actionId = 'c7b89b82-16a5-4c0e-96d1-c1ef98145f12'
    const newActionId = '02c92fc9-e723-4c34-9ca0-15ffec90067e'
    const route = BASE_PATH + '/api/conversations/c1'
    const payload = (id: string) => JSON.stringify({ text: 'create task', actionId: id })
    const postHeaders = { ...headers, 'content-type': 'application/json' }
    const post = (url: string, id = actionId) => fetch(url + route + '/message', {
      method: 'POST', headers: postHeaders, body: payload(id),
    })
    const get = async (url: string, id = actionId) => {
      const response = await fetch(url + route + '/actions/' + id, { headers })
      expect(response.status).toBe(200)
      return (await response.json()).receipt
    }
    const created = deferred<void>()
    const release = deferred<void>()
    const duplicateEntered = deferred<void>()
    const makeHost = (live: HttpHost, pauseFirst = false): HttpHost => {
      let arrivals = 0
      return {
        ...live,
        conversationTurn: async (id, text, _model, _refs, actionId) => {
          const arrival = ++arrivals
          if (pauseFirst && arrival === 2) duplicateEntered.resolve()
          let round = 0
          const result = await runCoordinatorTurn({
            engine: live.engine, store: live.store, send: async () => {},
            complete: async () => {
              if (++round === 1) return { text: '', toolCalls: [{ id: 'create', name: 'create_task', arguments: JSON.stringify({ title: 'one task', text: 'work' }) }] }
              if (pauseFirst && arrival === 1) { created.resolve(); await release.promise }
              return { text: 'Created', toolCalls: [] }
            },
            workRoot: () => '/tmp/work', stopTask: async () => ({ stopped: false }),
          }, id, text, new AbortController().signal, { actionId })
          return { reply: result.reply, sent: [result.reply], toolOutcomes: result.toolOutcomes, rounds: result.rounds }
        },
      }
    }
    let originalReceipt
    const backing = host(dir)
    try {
      const serving = await serve(makeHost(backing, true))
      const connection = request(serving.url + route + '/message', { method: 'POST', headers: postHeaders })
      const closed = new Promise<void>(resolve => connection.once('close', resolve))
      const responses: number[] = []
      connection.on('response', response => { responses.push(response.statusCode ?? 0); response.resume() })
      const errors: string[] = []
      connection.on('error', error => { errors.push((error as NodeJS.ErrnoException).code ?? error.message) })
      connection.end(payload(actionId))
      let duplicate: Promise<Response> | undefined
      try {
        await Promise.race([created.promise, closed.then(() => { throw new Error('Client closed before the first tool ran: ' + errors.join(', ')) })])
        const inProgress = await get(serving.url)
        expect(inProgress, JSON.stringify(inProgress)).toMatchObject({ id: actionId, state: 'received', task: { ticketId: expect.any(String) } })
        expect(backing.store.tickets.list().map(ticket => ticket.id)).toEqual([inProgress.task.ticketId])
        duplicate = post(serving.url)
        await Promise.race([duplicateEntered.promise, duplicate.then(response => { throw new Error('Duplicate did not enter the coordinator: ' + response.status) })])
        connection.destroy()
        await closed
        expect(responses).toEqual([])
        release.resolve()
        const replay = await duplicate
        expect(replay.status).toBe(409)
        await replay.body?.cancel()
        originalReceipt = await get(serving.url)
        expect(originalReceipt).toEqual({ ...inProgress, state: 'finished' })
        expect(backing.store.tickets.list().map(ticket => ticket.id)).toEqual([originalReceipt.task.ticketId])
      } finally {
        connection.destroy()
        release.resolve()
        await duplicate?.catch(() => {})
        await serving.close()
      }
    } finally { backing.store.close() }

    const restarted = host(dir)
    try {
      const serving = await serve(makeHost(restarted))
      try {
        const replay = await post(serving.url)
        expect(replay.status).toBe(409)
        await replay.body?.cancel()
        expect(await get(serving.url)).toEqual(originalReceipt)
        expect(restarted.store.tickets.list().map(ticket => ticket.id)).toEqual([originalReceipt.task.ticketId])
        const distinct = await post(serving.url, newActionId)
        expect(distinct.status).toBe(200)
        expect((await distinct.json()).toolOutcomes).toEqual([expect.objectContaining({ name: 'create_task', ok: true })])
        const nextReceipt = await get(serving.url, newActionId)
        expect(nextReceipt.task.ticketId).not.toBe(originalReceipt.task.ticketId)
        expect(restarted.store.tickets.list().map(ticket => ticket.id).sort()).toEqual([originalReceipt.task.ticketId, nextReceipt.task.ticketId].sort())
      } finally { await serving.close() }
    } finally { restarted.store.close() }
  })
  it('runs a coordinator turn and returns every sent line', async () => {
    const serving = await serve(host(tempDir('ordin-api-'), {
      conversationTurn: async (_id, text) => ({ reply: '收到：' + text, sent: ['收到：' + text], toolOutcomes: [], rounds: 1 }),
      conversationMessages: () => [{ id: 'm1', role: 'user', content: 'hi' }],
    }))
    try {
      const response = await fetch(serving.url + BASE_PATH + '/api/conversations/c1/message', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ text: '在吗' }) })
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.reply).toBe('收到：在吗')
      expect(body.sent).toEqual(['收到：在吗'])
      const history = await fetch(serving.url + BASE_PATH + '/api/conversations/c1/messages', { headers })
      expect((await history.json()).messages[0].content).toBe('hi')
    } finally { await serving.close() }
  })

  it('answers 503 with the real reason when the model is not configured', async () => {
    const serving = await serve(host(tempDir('ordin-api-'), {
      conversationTurn: async () => { throw new Error('模型尚未配置：请在设置里填写服务地址与模型名称') },
    }))
    try {
      const response = await fetch(serving.url + BASE_PATH + '/api/conversations/c1/message', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) })
      expect(response.status).toBe(503)
      expect((await response.json()).error).toContain('尚未配置')
    } finally { await serving.close() }
  })

  it('answers 501 when the coordinator is not wired at all', async () => {
    const serving = await serve(host(tempDir('ordin-api-')))
    try {
      const response = await fetch(serving.url + BASE_PATH + '/api/conversations/c1/message', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) })
      expect(response.status).toBe(501)
    } finally { await serving.close() }
  })

  it('refuses an empty message and a cross-origin request', async () => {
    const serving = await serve(host(tempDir('ordin-api-'), { conversationTurn: async () => ({ reply: '', sent: [], toolOutcomes: [], rounds: 1 }) }))
    try {
      const empty = await fetch(serving.url + BASE_PATH + '/api/conversations/c1/message', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ text: '   ' }) })
      expect(empty.status).toBe(400)
      const crossOrigin = await fetch(serving.url + BASE_PATH + '/api/conversations/c1/message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) })
      expect(crossOrigin.status).toBe(403)
    } finally { await serving.close() }
  })

  it('serves the standalone chat page', async () => {
    const serving = await serve(host(tempDir('ordin-api-')))
    try {
      const response = await fetch(serving.url + BASE_PATH + '/chat')
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('Ordin')
    } finally { await serving.close() }
  })
})
