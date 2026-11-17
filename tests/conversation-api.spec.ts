/** The conversation API: a real HTTP server, a stub coordinator, and the honest 503 when no model is configured. */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { Engine, Memory, parseSettings, settingsPolicy, type Delivery, type Executor, type Report, type Ticket } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { HealthBoard } from '../src/app/health.ts'
import { Prompts } from '../src/app/prompts.ts'
import { Uploads } from '../src/app/uploads.ts'
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
  const memory = new Memory()
  let current = parseSettings({})
  const engine = new Engine({
    repos: memory, tx: memory, policy: () => settingsPolicy(current),
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

describe('conversation API', () => {
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
