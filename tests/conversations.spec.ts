import { describe, expect, it, vi } from 'vitest'
import { boot } from '../src/app/boot.ts'
import { resolveConfig } from '../src/app/config.ts'
import { silentLogger } from '../src/app/logger.ts'
import { createRuntime } from '../src/app/runtime.ts'
import { ProcessRegistry } from '../src/app/process.ts'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { Conversations } from '../src/app/conversations.ts'
import { BASE_PATH, REQUEST_HEADER, serve, type HttpHost } from '../src/app/http.ts'
import { tempDir } from './helpers/temp.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
function apiHost(dir: string): HttpHost {
  const store = new Store(join(dir, 'api.sqlite3'))
  return {
    context: { logger: silent }, serverPort: () => 0, engine: {} as HttpHost['engine'], decisions: () => [], dismissDecision() {}, raiseDecision: () => 'x', store,
    health: {} as HttpHost['health'], prompts: {} as HttpHost['prompts'], sources: { source: () => undefined }, sourceStatus: () => ({}), delivery: { sends: () => ({ queued: 0, nowhere: 0 }) },
    deleteTicket: async () => ({ deleted: 'x', assets: 'keep', record: 'nothing' }), artifacts: () => [], mountedAt: () => '', executor: { used: () => 0, sandbox: {} as HttpHost['executor']['sandbox'] }, uploads: {} as HttpHost['uploads'],
    createTicketWithUploads: () => ({} as HttpHost['createTicketWithUploads'] extends (...args: never[]) => infer R ? R : never), passes: { requestPass() {} }, nudge: async () => {}, progress: () => ({} as HttpHost['progress'] extends (...args: never[]) => infer R ? R : never), recipes: () => [], machine: { view: () => ({}), promptMaxChars: () => 1 }, settings: () => ({} as HttpHost['settings'] extends () => infer R ? R : never), saveSettings: value => value as never, panelHtml: () => '', setupProblem: () => undefined, mainSession: () => ({ exists: false, running: false, busy: false }), createMainSession: async () => ({}),
    conversationTurn: async (id, text) => { const c = store.conversations.get(id); if (!c) store.conversations.save({ id, createdAt: new Date().toISOString(), lastMessageAt: new Date().toISOString() }); store.conversationMessages.append({ id: Math.random().toString(), conversationId: id, at: new Date().toISOString(), role: 'user', content: text }); return { reply: 'ok', sent: ['ok'], toolOutcomes: [], rounds: 1 } },
  }
}
const headers = { [REQUEST_HEADER]: '1', 'content-type': 'application/json' }
describe('conversation lifecycle', () => {
  it('runs real Runtime turns in separate histories and blocks archived/deleted/foreign input', async () => {
    const dir = tempDir('conv-runtime-')
    const infrastructure = boot({ config: resolveConfig({ stateDir: dir, workRoot: join(dir, 'work'), inboxDir: join(dir, 'inbox'), port: 0 }), logger: silentLogger() })
    const runtime = createRuntime(infrastructure, { logger: silentLogger(), driver: {} as never, proc: new ProcessRegistry(), notifier: null, acceptanceEnabled: false })
    const seen: string[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => { seen.push(String(init.body)); return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) })
    try {
      await runtime.saveModelConfig({ provider: 'stub', apiKeyEnv: '', baseUrl: 'http://stub.local/v1', model: 'test', models: ['test'], apiKey: '', temperature: 0.7, maxTokens: 1024 })
      const a = runtime.conversations.create(); const b = runtime.conversations.create()
      runtime.conversations.rename(a.id, 'preserved', a.revision)
      await runtime.conversationTurn(a.id, 'secret first history')
      await runtime.conversationTurn(b.id, 'fresh history')
      expect(seen[1]).not.toContain('secret first history')
      expect(runtime.conversations.get(a.id)).toMatchObject({ title: 'preserved', revision: 2 })
      expect(runtime.conversationMessages(b.id).map(m => m.content)).toEqual(['fresh history', 'answer'])
      const archived = runtime.conversations.archive(b.id, 1)
      await expect(runtime.conversationTurn(b.id, 'blocked')).rejects.toThrow(/archived/)
      const restored = runtime.conversations.restore(b.id, archived.revision)
      runtime.conversations.delete(b.id, restored.revision)
      await expect(runtime.conversationTurn(b.id, 'blocked')).rejects.toThrow(/deleted/)
      runtime.store.conversations.save({ id: 'foreign-runtime', profileId: 'other', createdAt: a.createdAt, lastMessageAt: a.createdAt })
      await expect(runtime.conversationTurn('foreign-runtime', 'blocked')).rejects.toThrow(/not found/)
      expect(seen).toHaveLength(2)
    } finally { vi.unstubAllGlobals(); runtime.store.close() }
  })
  it('keeps per-id history, metadata, revision conflicts and profile ownership', () => {
    const store = new Store(join(tempDir('conv-store-'), 'db.sqlite3')); const service = new Conversations(store)
    const a = service.create(); const b = service.create()
    store.conversationMessages.append({ id: 'a1', conversationId: a.id, at: a.createdAt, role: 'user', content: 'only a' })
    expect(service.messages(b.id).messages).toEqual([])
    const named = service.rename(a.id, 'Work', a.revision)
    expect(() => service.archive(a.id, a.revision)).toThrow(/revision conflict/)
    const archived = service.archive(a.id, named.revision)
    expect(service.list().map(x => x.id)).not.toContain(a.id)
    expect(service.list({ includeArchived: true })[1]?.id).toBe(a.id)
    const restored = service.restore(a.id, archived.revision)
    expect(restored.title).toBe('Work'); expect(restored.revision).toBe(4)
    store.conversations.save({ id: 'foreign', profileId: 'other', createdAt: a.createdAt, lastMessageAt: a.createdAt })
    store.conversations.save({ id: 'foreign', createdAt: a.createdAt, lastMessageAt: a.createdAt })
    expect(store.conversations.get('foreign')?.profileId).toBe('other')
    expect(() => store.conversations.save({ id: 'foreign', profileId: 'default', createdAt: a.createdAt, lastMessageAt: a.createdAt })).toThrow(/cannot be reassigned/)
    expect(() => service.get('foreign')).toThrow(/not found/)
  })
  it('pages equal-time rows by stable cursor and blocks deleted writes while retaining rows', () => {
    const store = new Store(join(tempDir('conv-page-'), 'db.sqlite3')); const service = new Conversations(store); const c = service.create()
    for (const id of ['m1', 'm2', 'm3']) store.conversationMessages.append({ id, conversationId: c.id, at: c.createdAt, role: 'user', content: id })
    const page = service.messages(c.id, { limit: 2 }); expect(page.messages.map(x => x.id)).toEqual(['m2', 'm3']); expect(page.nextCursor).toBe('m2')
    expect(service.messages(c.id, { limit: 2, before: page.nextCursor! }).messages.map(x => x.id)).toEqual(['m1'])
    const ticket = { id: 't', conversationId: c.id, createdAt: c.createdAt, title: 'preserve' } as never; store.tickets.save(ticket)
    const deleted = service.delete(c.id, c.revision)
    expect(() => service.assertWritable(c.id)).toThrow(/deleted/)
    expect(() => store.conversationMessages.append({ id: 'm4', conversationId: c.id, at: c.createdAt, role: 'user' })).toThrow(/deleted/)
    expect(store.conversationMessages.list(c.id)).toHaveLength(3); expect(store.tickets.get('t')).toBeDefined(); expect(deleted.deletedAt).toBeTruthy()
  })
  it('serves lifecycle routes and keeps the existing message route', async () => {
    const host = apiHost(tempDir('conv-http-')); const serving = await serve(host)
    const request = async (path: string, method = 'GET', body?: unknown) => fetch(serving.url + BASE_PATH + '/api/' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    try {
      const createdRes = await request('conversations', 'POST', {}); expect(createdRes.status).toBe(200); const created = (await createdRes.json()).conversation
      expect((await request('conversations')).status).toBe(200)
      expect((await request('conversations/' + created.id + '/message', 'POST', { text: 'hello' })).status).toBe(200)
      expect((await request('conversations/' + created.id + '/messages')).status).toBe(200)
      const archive = await request('conversations/' + created.id + '/archive', 'POST', { expectedRevision: 1 }); expect(archive.status).toBe(200)
      expect((await request('conversations/' + created.id + '/restore', 'POST', { expectedRevision: 2 })).status).toBe(200)
      expect((await request('conversations/' + created.id, 'PATCH', { title: 'Renamed', expectedRevision: 3 })).status).toBe(200)
      expect((await request('conversations/' + created.id, 'PATCH', { title: 'stale', expectedRevision: 3 })).status).toBe(409)
      expect((await request('conversations/' + created.id, 'DELETE', { expectedRevision: 4 })).status).toBe(200)
      expect((await request('conversations/' + created.id + '/message', 'POST', { text: 'blocked' })).status).toBe(410)
      expect(host.store.conversationMessages.list(created.id)).toHaveLength(1)
      host.store.conversations.save({ id: 'foreign', profileId: 'other', createdAt: created.createdAt, lastMessageAt: created.createdAt })
      expect((await request('conversations/foreign/messages')).status).toBe(404)
      expect((await request('conversations/foreign/message', 'POST', { text: 'blocked' })).status).toBe(404)
      expect((await request('conversations/' + created.id + '/messages?limit=501')).status).toBe(400)
    } finally { await serving.close() }
  })
})
