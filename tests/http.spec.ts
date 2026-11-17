/**
 * HTTP 面板与 API 的路由测试：fake HttpHost + 真 node:http server（127.0.0.1，port 0），不依赖 runtime/boot。
 * Engine 跑在 Memory 仓库上，Store 落在临时目录；测试经真实 HTTP 往返（undici fetch），不是直接调 handler。
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync } from 'node:fs'
import { SkillCandidates } from '../src/app/skill-candidates.ts'
import { ProcessRegistry } from '../src/app/process.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/app/store.ts'
import { Memories } from '../src/app/memories.ts'
import { HealthBoard } from '../src/app/health.ts'
import { PROMPT_MAX_CHARS, Prompts } from '../src/app/prompts.ts'
import { Uploads } from '../src/app/uploads.ts'
import { Engine, Memory, parseSettings, settingsPolicy, UserError } from '../src/core/index.ts'
import type { Assignment, Delivery, Executor, Mandate, Report, Ticket } from '../src/core/index.ts'
import type { Settings } from '../src/core/policy.ts'
import {
  BASE_PATH, LEGACY_BASE_PATH, LEGACY_REQUEST_HEADER, REQUEST_HEADER,
  panelPage, sameOrigin, serve, type HttpHost, type Serving,
} from '../src/app/http.ts'
import { startServer } from '../src/app/server.ts'
import { tempDir } from './helpers/temp.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

class FakeExecutor implements Executor {
  prepare(ticket: Ticket, _mandate: Mandate): Ticket { return ticket }
  start(_ticket: Ticket, _assignment: Assignment): void {}
  deliver(_ticket: Ticket, _assignment: Assignment): void {}
  stop(_ticket: Ticket, _assignment: Assignment, _reason: string): void {}
}

class FakeDelivery implements Delivery {
  report(_ticket: Ticket, _report: Report): void {}
}

/**
 * The fake HttpHost: real Store / Prompts / Uploads / HealthBoard / Engine（Memory 仓库），
 * 只有执行器、Source、desk 与 runtime 职责（progress/recipes/mainSession 等）是桩。
 */
function fakeHost(dir: string, overrides: Partial<HttpHost> = {}): HttpHost {
  const store = new Store(join(dir, 'ordin.sqlite3'))
  const memory = new Memory()
  let current: Settings = parseSettings({})
  const engine = new Engine({
    repos: memory, tx: memory, policy: () => settingsPolicy(current),
    executor: new FakeExecutor(), delivery: new FakeDelivery(),
  })
  return {
    context: { logger: silent },
    serverPort: () => 0,
    engine,
    decisions: () => [],
    dismissDecision: () => { throw new Error('not wired in the fake host') },
    raiseDecision: () => 'decision-fake',
    store,
    health: new HealthBoard(),
    prompts: new Prompts(store),
    sources: { source: () => undefined },
    sourceStatus: () => ({}),
    delivery: { sends: () => ({ queued: 0, nowhere: 0 }) },
    deleteTicket: async id => { throw new Error('not wired in the fake host: deleteTicket ' + id) },
    artifacts: () => [],
    mountedAt: () => '2026-11-15T00:00:00.000Z',
    executor: {
      used: () => 0,
      sandbox: {
        listWorkspace: async () => ({ files: [], count: 0, truncated: false }),
        readWorkspaceFile: async () => ({ base64: '', size: 0, mtime: '2026-11-15T00:00:00.000Z' }),
      },
    },
    uploads: new Uploads(dir),
    createTicketWithUploads: () => { throw new Error('not wired in the fake host') },
    passes: { requestPass: () => {} },
    nudge: async () => {},
    progress: ticketId => { throw new UserError('ticket_missing', { ticketId }) },
    recipes: () => [],
    machine: {
      view: () => ({ stateDir: dir, workRoot: join(dir, 'work'), inboxDir: join(dir, 'inbox') }),
      promptMaxChars: () => PROMPT_MAX_CHARS,
    },
    settings: () => current,
    saveSettings: value => {
      current = parseSettings(value)
      store.saveSettings(current)
      return current
    },
    panelHtml: () => panelPage(),
    setupProblem: () => undefined,
    mainSession: () => ({ exists: false, running: false, busy: false }),
    createMainSession: async () => ({}),
    ...overrides,
  }
}

interface Panel {
  readonly dir: string
  readonly host: HttpHost
  readonly serving: Serving
  readonly port: number
  readonly url: string
}

async function withPanel(run: (panel: Panel) => Promise<void>, overrides: Partial<HttpHost> = {}): Promise<void> {
  const dir = tempDir('ordin-http-')
  const host = fakeHost(dir, overrides)
  const serving = await serve(host, { port: 0 })
  try {
    await run({ dir, host, serving, port: serving.port, url: serving.url })
  } finally {
    await serving.close()
    host.store.close()
  }
}

const PANEL_HEADERS = { 'content-type': 'application/json', [REQUEST_HEADER]: '1' }

const api = (port: number, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch('http://127.0.0.1:' + port + BASE_PATH + '/api/' + path, {
    ...init,
    headers: { ...PANEL_HEADERS, ...(init.headers ?? {}) },
  })

const page = (port: number, path: string): Promise<Response> => fetch('http://127.0.0.1:' + port + path)

/** 轮询直到条件成立；自诊断地失败，不拍脑袋 sleep。 */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for: ' + what)
}

describe('scenario settings HTTP contract', () => {
  it('roundtrips scenarios through settings and state without credentials and rejects unsaved models', async () => {
    await withPanel(async ({ port }) => {
      const deskLlm = { model: 'global', models: ['global', 'talk', 'judge'], scenarios: { conversation: 'talk', triage: 'judge' } }
      const saved = await api(port, 'settings', { method: 'PUT', body: JSON.stringify({ deskLlm }) })
      expect(saved.status).toBe(200)
      expect((await saved.json()).settings.deskLlm).toMatchObject(deskLlm)
      const state = await api(port, 'state')
      expect(state.status).toBe(200)
      const data = await state.json()
      expect(data.settings.deskLlm).toMatchObject(deskLlm)
      expect(data.settings.deskLlm).not.toHaveProperty('apiKey')
      const invalid = await api(port, 'settings', { method: 'PUT', body: JSON.stringify({ deskLlm: { ...deskLlm, scenarios: { triage: 'unknown' } } }) })
      expect(invalid.status).toBe(400)
      expect((await invalid.json()).issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'deskLlm.scenarios.triage' })]))
      const secret = await api(port, 'settings', { method: 'PUT', body: JSON.stringify({ deskLlm: { ...deskLlm, apiKey: 'DO_NOT_STORE' } }) })
      expect(secret.status).toBe(400)
    })
  })
})

describe('memory lifecycle', () => {
  it('proposes, confirms, revises, and soft deletes through trusted HTTP routes', async () => {
    await withPanel(async ({ port, host }) => {
      const memories = new Memories(host.store)
      const serviceHost = { ...host, memories }
      const serving = await serve(serviceHost, { port: 0 })
      try {
        const proposed = await api(serving.port, 'memories', { method: 'POST', body: JSON.stringify({ kind: 'preference', content: 'Use concise replies', confidence: 'confirmed' }) })
        expect(proposed.status).toBe(400)
        const created = await api(serving.port, 'memories', { method: 'POST', body: JSON.stringify({ kind: 'preference', content: 'Use concise replies' }) })
        expect(created.status).toBe(200)
        const candidate = await created.json() as Record<string, any>
        const id = candidate.id as string
        expect(candidate.confidence).toBe('inferred')
        expect((await api(serving.port, 'memories')).status).toBe(200)
        const confirm = await api(serving.port, 'memories/' + id + '/confirm', { method: 'POST', body: '{}' })
        expect(confirm.status).toBe(200)
        expect((await confirm.json() as Record<string, any>).confirmation.actor).toBe('operator')
        const corrected = await api(serving.port, 'memories/' + id, { method: 'PATCH', body: JSON.stringify({ content: 'Use concise, direct replies', expectedRevision: 2 }) })
        expect(corrected.status).toBe(200)
        expect((await corrected.json() as Record<string, any>).confidence).toBe('inferred')
        expect((await api(serving.port, 'memories/' + id + '/revisions')).status).toBe(200)
        const conflict = await api(serving.port, 'memories/' + id, { method: 'PATCH', body: JSON.stringify({ content: 'stale', expectedRevision: 2 }) })
        expect(conflict.status).toBe(409)
        const deleted = await api(serving.port, 'memories/' + id, { method: 'DELETE', body: '{}' })
        expect(deleted.status).toBe(200)
        expect((await deleted.json() as Record<string, any>).deleted.actor).toBe('operator')
      } finally { await serving.close() }
    })
  })
})

describe('面板页', () => {
  it('正典与兼容前缀都提供 panel/index.html 的真实内容', async () => {
    await withPanel(async ({ port }) => {
      const html = readFileSync(join(root, 'panel', 'index.html'), 'utf8')
      for (const path of ['/ordin/', '/ordin', '/ordin/index.html', '/ordin/', '/ordin']) {
        const response = await page(port, path)
        expect(response.status, path).toBe(200)
        expect(response.headers.get('content-type'), path).toContain('text/html')
        expect(response.headers.get('cache-control'), path).toBe('no-store')
        expect(await response.text(), path).toBe(html)
      }
      const missing = await page(port, '/ordin/nope')
      expect(missing.status).toBe(404)
    })
  })
})

describe('状态与设置', () => {
  it('GET state：设置、计数、机器视图、策略版本、主 Session 状态', async () => {
    await withPanel(async ({ port, dir }) => {
      const response = await api(port, 'state')
      expect(response.status).toBe(200)
      const body = await response.json() as Record<string, any>
      expect(typeof body.settings.acceptMode).toBe('string')
      expect(body.settingsRevision).toBe(0)
      expect(body.counts.workerSlots).toEqual({ used: 0, max: body.settings.executor.maxWorkers })
      expect(body.counts.sends).toEqual({ queued: 0, nowhere: 0 })
      expect(body.machine.stateDir).toBe(dir)
      expect(typeof body.policyVersion).toBe('string')
      expect(body.mainSession).toEqual({ exists: false, running: false, busy: false })
      expect(body.health).toEqual({})
      expect(body.sources).toEqual({})
      expect(body.mountedAt).toBe('2026-11-15T00:00:00.000Z')
    })
  })

  it('PUT settings：合法写入 revision 递增并立刻生效；非法值 400 带 issues', async () => {
    await withPanel(async ({ port }) => {
      const before = await (await api(port, 'state')).json() as Record<string, any>
      const changed = { ...before.settings, paused: true }
      const put = await api(port, 'settings', { method: 'PUT', body: JSON.stringify(changed) })
      expect(put.status).toBe(200)
      const saved = await put.json() as Record<string, any>
      expect(saved.settings.paused).toBe(true)
      expect(saved.settingsRevision).toBe(1)
      const after = await (await api(port, 'state')).json() as Record<string, any>
      expect(after.paused).toBe(true)
      expect(after.settings.paused).toBe(true)
      expect(after.settingsRevision).toBe(1)
      const bad = await api(port, 'settings', { method: 'PUT', body: JSON.stringify({ ...before.settings, acceptMode: 'bogus' }) })
      expect(bad.status).toBe(400)
      const badBody = await bad.json() as Record<string, any>
      expect(badBody.error).toContain('Invalid settings')
      expect(Array.isArray(badBody.issues)).toBe(true)
    })
  })
})

describe('同源守卫', () => {
  it('sameOrigin：Host 必须 loopback+实际端口，标记头必须 1，Origin 必须同源', () => {
    const req = (headers: Record<string, string>) => ({ headers })
    expect(sameOrigin(req({ host: '127.0.0.1:7471', [REQUEST_HEADER]: '1' }), 7471)).toBe(true)
    expect(sameOrigin(req({ host: 'localhost:7471', [REQUEST_HEADER]: '1' }), 7471)).toBe(true)
    expect(sameOrigin(req({ host: '[::1]:7471', [REQUEST_HEADER]: '1' }), 7471)).toBe(true)
    expect(sameOrigin(req({ host: '127.0.0.1:7471', [LEGACY_REQUEST_HEADER]: '1' }), 7471)).toBe(true)
    expect(sameOrigin(req({ host: '127.0.0.1:7471', [REQUEST_HEADER]: '1', origin: 'http://127.0.0.1:7471' }), 7471)).toBe(true)
    expect(sameOrigin(req({ host: '127.0.0.1:9999', [REQUEST_HEADER]: '1' }))).toBe(true)
    expect(sameOrigin(req({ host: 'evil.example:7471', [REQUEST_HEADER]: '1' }), 7471)).toBe(false)
    expect(sameOrigin(req({ host: '127.0.0.1:9999', [REQUEST_HEADER]: '1' }), 7471)).toBe(false)
    expect(sameOrigin(req({ host: '127.0.0.1:7471' }), 7471)).toBe(false)
    expect(sameOrigin(req({ host: '127.0.0.1:7471', [REQUEST_HEADER]: '0' }), 7471)).toBe(false)
    expect(sameOrigin(req({ host: '127.0.0.1:7471', [REQUEST_HEADER]: '1', origin: 'https://evil.example' }), 7471)).toBe(false)
  })

  it('过线请求：缺标记头 403 JSON，异源 Origin 403，带标记头 200', async () => {
    await withPanel(async ({ port }) => {
      const bare = await page(port, '/ordin/api/state')
      expect(bare.status).toBe(403)
      expect(await bare.json()).toEqual({ error: 'A same-origin management request is required' })
      const foreign = await api(port, 'state', { headers: { origin: 'https://evil.example' } })
      expect(foreign.status).toBe(403)
      const own = await api(port, 'state', { headers: { origin: 'http://127.0.0.1:' + port } })
      expect(own.status).toBe(200)
    })
  })
})

describe('请求体限制', () => {
  it('超过 128 KiB 的 body 400；非 JSON body 400', async () => {
    await withPanel(async ({ port }) => {
      const tooBig = await api(port, 'settings', { method: 'PUT', body: 'x'.repeat(200 * 1024) })
      expect(tooBig.status).toBe(400)
      expect((await tooBig.json() as Record<string, any>).error).toContain('exceeds 131072 bytes')
      const notJson = await api(port, 'settings', { method: 'PUT', body: '{nope' })
      expect(notJson.status).toBe(400)
      expect((await notJson.json() as Record<string, any>).error).toBe('The request body is not JSON')
    })
  })

  it('未知 API 路由 404 JSON', async () => {
    await withPanel(async ({ port }) => {
      const response = await api(port, 'nope')
      expect(response.status).toBe(404)
      expect((await response.json() as Record<string, any>).error).toBe('No route for GET /ordin/api/nope')
    })
  })
})

describe('启动与关闭', () => {
  it('port 0 分配动态端口，绑定 127.0.0.1，close 后拒绝新连接', async () => {
    const dir = tempDir('ordin-http-')
    const host = fakeHost(dir)
    const serving = await serve(host, { port: 0 })
    try {
      expect(serving.port).toBeGreaterThan(0)
      expect(serving.url).toBe('http://127.0.0.1:' + serving.port)
      const ok = await api(serving.port, 'state')
      expect(ok.status).toBe(200)
    } finally {
      await serving.close()
      host.store.close()
    }
    await expect(api(serving.port, 'state')).rejects.toThrow()
  })

  it('拒绝绑定非 loopback 地址', async () => {
    await expect(startServer(() => {}, { host: '0.0.0.0' })).rejects.toThrow('loopback')
    await expect(startServer(() => {}, { host: '192.168.1.10' })).rejects.toThrow('loopback')
  })
})

describe('drain 与 close', () => {
  it('drain 等活动请求完成；close 停止接受新请求但不掐断进行中的响应', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const nudges: string[] = []
    await withPanel(async ({ port, serving }) => {
      const pending = api(port, 'pass', { method: 'POST', body: '{}' })
      await until(() => nudges.length === 1, 'nudge started')
      let drained = false
      const draining = serving.drain().then(() => { drained = true })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(drained).toBe(false)
      const closing = serving.close()
      await expect(api(port, 'state')).rejects.toThrow()
      release()
      const response = await pending
      expect(response.status).toBe(200)
      const body = await response.json() as Record<string, any>
      expect(body.requested).toBe(true)
      expect(body.effects).toBeDefined()
      await closing
      expect(drained).toBe(true)
      expect(nudges).toEqual(['start', 'end'])
    }, {
      nudge: async () => { nudges.push('start'); await gate; nudges.push('end') },
    })
  })
})

describe('兼容前缀与 desk 未接入', () => {
  it('/ordin/api/* 带 x-ordin-request 正常工作；panel 资产里的旧标记头被钉住兼容', async () => {
    await withPanel(async ({ port }) => {
      const legacy = await page(port, '/ordin/api/state')
      expect(legacy.status).toBe(403)
      const ok = await fetch('http://127.0.0.1:' + port + '/ordin/api/state', { headers: { [LEGACY_REQUEST_HEADER]: '1' } })
      expect(ok.status).toBe(200)
      const body = await ok.json() as Record<string, any>
      expect(body.settings).toBeDefined()
      // panel/index.html 是 P1-T3 资产、本卡禁改：它若仍带旧标记头，兼容就必须在——这条断言钉住这个约定。
      const asset = readFileSync(join(root, 'panel', 'index.html'), 'utf8')
      if (asset.includes(LEGACY_REQUEST_HEADER)) {
        expect(sameOrigin({ headers: { host: '127.0.0.1:' + port, [LEGACY_REQUEST_HEADER]: '1' } }, port)).toBe(true)
      }
    })
  })

  it('desk/status 未接入时答 disabled；desk/providers 未接入时答 501（不假装空列表）', async () => {
    await withPanel(async ({ port }) => {
      const status = await (await api(port, 'desk/status')).json() as Record<string, any>
      expect(status).toEqual({ state: 'disabled', configured: false, provider: '', model: '', recentErrors: [] })
      const providers = await api(port, 'desk/providers')
      expect(providers.status).toBe(501)
      expect((await providers.json() as Record<string, any>).error).toContain('not wired')
    })
  })
})

describe('路由表覆盖', () => {
  it('tickets 列表与详情：空库列表为空；未知 id 映射 404 ticket_missing', async () => {
    await withPanel(async ({ port }) => {
      const list = await (await api(port, 'tickets')).json() as Record<string, any>
      expect(list).toEqual({ offset: 0, limit: 50, count: 0, tickets: [] })
      const missing = await api(port, 'tickets/nope')
      expect(missing.status).toBe(404)
      const body = await missing.json() as Record<string, any>
      expect(body.code).toBe('ticket_missing')
    })
  })

  it('POST tickets 校验失败 400 带 issues（不落半张票）', async () => {
    await withPanel(async ({ port }) => {
      const response = await api(port, 'tickets', { method: 'POST', body: JSON.stringify({ title: '', request: '' }) })
      expect(response.status).toBe(400)
      const body = await response.json() as Record<string, any>
      expect(Array.isArray(body.issues)).toBe(true)
      expect(body.issues.length).toBeGreaterThan(0)
    })
  })

  it('POST decisions：缺 title/detail 400；齐全时走同一写入者', async () => {
    await withPanel(async ({ port }) => {
      const bad = await api(port, 'decisions', { method: 'POST', body: JSON.stringify({ title: 'x' }) })
      expect(bad.status).toBe(400)
      expect((await bad.json() as Record<string, any>).error).toContain('title and a detail')
      const ok = await api(port, 'decisions', { method: 'POST', body: JSON.stringify({ title: 't', detail: 'd', source: 'test' }) })
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual({ raised: 'decision-fake', queue: 0 })
    })
  })

  it('只读列表路由的形状：decisions/triggers/lost/schedules/prompts/effects/projects/works/recipes/changes/operator-queue/desk-messages', async () => {
    await withPanel(async ({ port }) => {
      expect(await (await api(port, 'decisions')).json()).toEqual({ count: 0, decisions: [] })
      expect(await (await api(port, 'triggers')).json()).toEqual({ count: 0, triggers: [] })
      const lost = await (await api(port, 'lost')).json() as Record<string, any>
      expect(lost.total).toBe(0)
      expect(lost.shown).toBe(0)
      expect(lost.rows).toEqual([])
      expect(lost.payloads).toEqual([])
      expect(lost.bounds.keep).toBeGreaterThan(0)
      const schedules = await (await api(port, 'schedules')).json() as Record<string, any>
      expect(typeof schedules.zone).toBe('string')
      expect(schedules.schedules).toEqual([])
      const prompts = await (await api(port, 'prompts')).json() as Record<string, any>
      expect(typeof prompts.revision).toBe('number')
      expect(prompts.roles.map((role: { role: string }) => role.role)).toEqual(['worker', 'orchestrator', 'triage'])
      expect(Array.isArray(prompts.builtInSkills)).toBe(true)
      const effects = await (await api(port, 'effects')).json() as Record<string, any>
      expect(typeof effects.counts).toBe('object')
      expect(await (await api(port, 'projects')).json()).toEqual({ projects: [] })
      expect(await (await api(port, 'works')).json()).toEqual({ works: [] })
      expect(await (await api(port, 'recipes')).json()).toEqual([])
      expect(await (await api(port, 'changes')).json()).toEqual({ changes: [] })
      expect(await (await api(port, 'operator-queue')).json()).toEqual({ items: [] })
      const messages = await (await api(port, 'desk/messages')).json() as Record<string, any>
      expect(messages.messages).toEqual([])
      expect(typeof messages.latestSeq).toBe('number')
      const deskDecisions = await (await api(port, 'desk-decisions')).json() as Record<string, any>
      expect(deskDecisions).toEqual({ count: 0, decisions: [] })
    })
  })

  it('POST schedules/preview：合法时间给出下一次运行；非法 400 带 issues', async () => {
    await withPanel(async ({ port }) => {
      const ok = await api(port, 'schedules/preview', {
        method: 'POST',
        body: JSON.stringify({ id: 'probe', prompt: 'do a thing', timing: { kind: 'every', seconds: 60 } }),
      })
      expect(ok.status).toBe(200)
      const body = await ok.json() as Record<string, any>
      expect(body.next.length).toBeGreaterThan(0)
      expect(typeof body.describe).toBe('string')
      expect(typeof body.zone).toBe('string')
      const bad = await api(port, 'schedules/preview', { method: 'POST', body: JSON.stringify({}) })
      expect(bad.status).toBe(400)
      const badBody = await bad.json() as Record<string, any>
      expect(Array.isArray(badBody.issues)).toBe(true)
    })
  })

  it('POST main-session 走宿主实现，返回其原样结果', async () => {
    await withPanel(async ({ port }) => {
      const response = await api(port, 'main-session', { method: 'POST', body: '{}' })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({})
    })
  })
})

it('F2-C2 gates candidate syntax validation and explicit approval through real HTTP', async () => {
  await withPanel(async ({ host, port, dir }) => {
    const workspace = join(dir, 'task'); mkdirSync(workspace)
    const proc = new ProcessRegistry()
    const service = new SkillCandidates(host.prompts, proc, dir, () => workspace)
    Object.defineProperty(host, 'skillCandidates', { value: service })
    const skill = host.prompts.saveSkillCandidate({ name: 'http-candidate', title: 'HTTP', description: 'candidate', content: 'throw new Error("never execute");', program: 'throw new Error("never execute");', scriptPath: 'tool.mjs', fromTicketId: 'ticket-http' })
    const expected = { expectedRevision: skill.revision!, expectedHash: skill.contentHash! }
    const post = (action: string, body: unknown) => api(port, 'prompts/skills/' + skill.name + '/' + action, { method: 'POST', body: JSON.stringify(body) })
    expect((await post('approve', expected)).status).toBe(409)
    expect((await post('toggle', { enabled: true })).status).toBe(409)
    expect((await post('approve', { actor: 'spoofed' })).status).toBe(400)
    expect((await post('validate', { ...expected, argv: ['sh', '-c', 'true'] })).status).toBe(400)
    expect((await post('approve', { ...expected, actor: 'spoofed' })).status).toBe(400)
    const checked = await post('validate', expected)
    expect(checked.status).toBe(200)
    expect((await checked.json()).skill).toMatchObject({ enabled: false, validation: { kind: 'syntax', result: 'verified', exitCode: 0 } })
    const approved = await post('approve', expected); expect(approved.status).toBe(200)
    expect((await approved.json()).skill).toMatchObject({ enabled: true, state: 'active', approval: { actor: 'operator' } })
    expect(proc.list().every(record => record.status !== 'running')).toBe(true)
  })
})
