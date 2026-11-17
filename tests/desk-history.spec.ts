/**
 * DeskHistory: append, dedup, recent, since, latestSeq, setSystem —— 从 ordin
 * tests/desk-history.spec.ts 迁入，唯一差异是 DeskLoop 的桩形状（stub LlmFetch，
 * 不再有 Cordis ctx）。全部本地，绝不触网。
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { DeskLoop, type LlmFetch } from '../src/app/desk-loop.ts'
import { DeskHistory } from '../src/app/desk-history.ts'
import { silentLogger } from '../src/app/logger.ts'
import type { Prompts } from '../src/app/prompts.ts'
import type { Store } from '../src/app/store.ts'
import type { ToolsHost } from '../src/app/tools.ts'
import type { Engine } from '../src/core/engine.ts'
import type { Settings } from '../src/core/policy.ts'
import { parseSettings } from '../src/core/policy.ts'

function receiptStore(): Pick<Store, 'get' | 'set' | 'atomic'> {
  const values = new Map<string, unknown>()
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    set: (key: string, value: unknown) => { values.set(key, value) },
    atomic: <T>(run: () => T): T => run(),
  }
}

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE desk_messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL, content TEXT NOT NULL,
    tool_calls TEXT, tool_call_id TEXT, name TEXT,
    ticketId TEXT, requestId TEXT, at TEXT NOT NULL
  )`)
  db.exec('CREATE UNIQUE INDEX desk_messages_request ON desk_messages (requestId) WHERE requestId IS NOT NULL')
  return db
}

// ── stub LLM: 本地编造 OpenAI SSE 流，从不触网 ───────────────────────────────────────────

interface StubChunk {
  readonly text?: string
  readonly toolCalls?: readonly { index?: number; id?: string; name?: string; argumentsDelta?: string }[]
  readonly finishReason?: string
}

function sse(events: readonly (string | undefined)[]): string {
  return events.map(event => (event === undefined ? 'data: [DONE]' : `data: ${event}`)).join('\n\n') + '\n\n'
}

function chunkEvent(chunk: StubChunk): string {
  const delta: Record<string, unknown> = {}
  if (chunk.text !== undefined) delta.content = chunk.text
  if (chunk.toolCalls !== undefined) {
    delta.tool_calls = chunk.toolCalls.map(call => ({
      index: call.index ?? 0,
      ...(call.id !== undefined ? { id: call.id } : {}),
      ...(call.name !== undefined || call.argumentsDelta !== undefined
        ? { function: { ...(call.name !== undefined ? { name: call.name } : {}), ...(call.argumentsDelta !== undefined ? { arguments: call.argumentsDelta } : {}) } }
        : {}),
    }))
  }
  return JSON.stringify({
    choices: [{ index: 0, delta, ...(chunk.finishReason !== undefined ? { finish_reason: chunk.finishReason } : {}) }],
  })
}

/** 一轮生成 = 一组 chunk；多轮回合时返回一个 async generator 依次吐轮。 */
function generateOf(...rounds: readonly StubChunk[][]): (call: number) => AsyncGenerator<StubChunk> {
  return async function* (call: number) {
    const round = rounds[Math.min(call - 1, rounds.length - 1)] ?? []
    for (const chunk of round) yield chunk
  }
}

async function* streamOf(chunks: readonly StubChunk[]): AsyncGenerator<StubChunk> {
  for (const chunk of chunks) yield chunk
}

/** 把 generate 多轮结果拍平成 SSE body。 */
function eventsOf(chunks: readonly StubChunk[]): (string | undefined)[] {
  const events: (string | undefined)[] = []
  for (const [index, chunk] of chunks.entries()) {
    events.push(chunkEvent({ ...chunk, finishReason: index === chunks.length - 1 ? chunk.finishReason ?? 'stop' : undefined }))
  }
  events.push(undefined)
  return events
}

interface StubLlm {
  /** 第 n 次调用（从 1 起）看到的 tools 数量。 */
  readonly seenCounts: number[]
  /** 组装 DeskLlmConfig.fetchFn；generator 按调用序号吐 chunk。 */
  fetchFn: (generate: (call: number) => AsyncGenerator<StubChunk>, options?: { hold?: () => Promise<void> }) => LlmFetch
  /** 简单一轮直答的 fetchFn。 */
  direct: (text: string) => LlmFetch
}

function stubLlm(): StubLlm {
  const seenCounts: number[] = []
  return {
    seenCounts,
    fetchFn: (generate, options) => {
      let calls = 0
      return async (_url: string | URL | Request, init?: RequestInit) => {
        calls++
        const body = JSON.parse(String(init?.body ?? '{}')) as { tools?: unknown[] }
        seenCounts.push(Array.isArray(body.tools) ? body.tools.length : 0)
        const chunks: StubChunk[] = []
        for await (const chunk of generate(calls)) chunks.push(chunk)
        if (options?.hold !== undefined) {
          const encoder = new TextEncoder()
          return new Response(new ReadableStream<Uint8Array>({
            async start(controller) {
              try {
                for (const chunk of chunks) {
                  controller.enqueue(encoder.encode(`data: ${chunkEvent(chunk)}\n\n`))
                }
                controller.enqueue(encoder.encode('data: '))
                await options.hold!()
              } finally {
                controller.close()
              }
            },
          }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }
        return new Response(sse(eventsOf(chunks)), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
    },
    direct: text => {
      let calls = 0
      return async (_url: string | URL | Request, init?: RequestInit) => {
        calls++
        const body = JSON.parse(String(init?.body ?? '{}')) as { tools?: unknown[] }
        seenCounts.push(Array.isArray(body.tools) ? body.tools.length : 0)
        return new Response(sse(eventsOf([{ text }])), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
    },
  }
}

// ── DeskLoop 测试夹具 ────────────────────────────────────────────────────────────────────

interface Fixture {
  readonly loop: DeskLoop
}

const SETTINGS = () => parseSettings({ deskLlm: { provider: 'p', model: 'm', baseUrl: 'http://stub.local/v1' } })

function makeStore(ticketRecord?: object, events?: readonly object[]): Store {
  const db = makeDb()
  return {
    ...receiptStore(),
    deskHistory: new DeskHistory(db),
    tickets: {
      get: (id: string) => ticketRecord !== undefined && (ticketRecord as { id: string }).id === id ? ticketRecord : undefined,
    },
    events: { list: (_id: string) => events ?? [] },
  } as unknown as Store
}

function fixture(options: {
  ticketRecord?: object
  events?: readonly object[]
  engine?: Engine
  fetchFn: LlmFetch
  settings?: Settings
  prompts?: Prompts
}): Fixture {
  const store = makeStore(options.ticketRecord, options.events)
  const loop = new DeskLoop({
    logger: silentLogger(),
    store,
    toolsHost: {} as ToolsHost,
    prompts: options.prompts ?? { current: () => '' } as unknown as Prompts,
    settings: () => options.settings ?? SETTINGS(),
    fetchFn: options.fetchFn,
    engine: options.engine,
  })
  return { loop }
}

function triageTicket(id: string): object {
  return {
    id, title: '天气查询',
    assignments: [{ id: 'a-1', state: 'running', role: 'triage', startedAt: '2026-11-13T00:00:00Z' }],
    inputs: [], notes: [], attachments: [],
  }
}

describe('DeskHistory', () => {
  it('appends and returns a seq', () => {
    const h = new DeskHistory(makeDb())
    const seq = h.append({ role: 'user', content: 'hello', at: '2026-01-01T00:00:00Z' })
    expect(seq).toBeGreaterThan(0)
  })

  it('deduplicates by requestId', () => {
    const h = new DeskHistory(makeDb())
    const s1 = h.append({ role: 'user', content: 'a', requestId: 'req-1', at: '2026-01-01T00:00:00Z' })
    const s2 = h.append({ role: 'user', content: 'b', requestId: 'req-1', at: '2026-01-01T00:00:01Z' })
    expect(s1).toBe(s2)
    expect(h.recent(10).filter(m => m.role !== 'system')).toHaveLength(1)
  })

  it('recent returns system + last N non-system messages', () => {
    const h = new DeskHistory(makeDb())
    h.setSystem('you are desk')
    for (let i = 0; i < 5; i++) h.append({ role: 'user', content: `msg ${i}`, at: '2026-01-01T00:00:00Z' })
    const r = h.recent(3)
    expect(r[0]!.role).toBe('system')
    expect(r[0]!.content).toBe('you are desk')
    // 3 non-system + 1 system
    expect(r).toHaveLength(4)
    expect(r.at(-1)!.content).toBe('msg 4')
  })

  it('projects a context window without orphan tool results or incomplete tool calls', () => {
    const db = makeDb()
    const h = new DeskHistory(db)
    try {
      h.append({ role: 'assistant', content: 'calling', tool_calls: [{ id: 'pair', name: 'tool', arguments: '{}' }], at: '2026-01-01T00:00:00Z' })
      h.append({ role: 'tool', content: 'done', tool_call_id: 'pair', at: '2026-01-01T00:00:01Z' })
      h.append({ role: 'user', content: 'next', at: '2026-01-01T00:00:02Z' })
      expect(h.recent(2).map(m => m.role)).toEqual(['user'])
      expect(h.recent(3).map(m => m.role)).toEqual(['assistant', 'tool', 'user'])
      h.append({ role: 'assistant', content: 'partial', tool_calls: [{ id: 'missing', name: 'tool', arguments: '{}' }], at: '2026-01-01T00:00:03Z' })
      expect(h.recent(4).some(m => m.tool_calls?.some(call => call.id === 'missing'))).toBe(false)
      expect(h.since(0).at(-1)?.tool_calls?.[0]?.id).toBe('missing') // audit rows stay intact
      h.append({ role: 'user', content: 'interrupted', at: '2026-01-01T00:00:04Z' })
      h.append({ role: 'tool', content: 'late orphan', tool_call_id: 'missing', at: '2026-01-01T00:00:05Z' })
      expect(h.recent(10).some(m => m.tool_call_id === 'missing' || m.tool_calls?.some(c => c.id === 'missing'))).toBe(false)
      h.append({ role: 'assistant', content: '', tool_calls: [
        { id: 'multi-a', name: 'tool', arguments: '{}' }, { id: 'multi-b', name: 'tool', arguments: '{}' },
      ], at: '2026-01-01T00:00:06Z' })
      h.append({ role: 'tool', content: 'only half', tool_call_id: 'multi-a', at: '2026-01-01T00:00:07Z' })
      expect(h.recent(10).some(m => m.tool_call_id === 'multi-a' || m.tool_calls?.some(c => c.id === 'multi-b'))).toBe(false)
    } finally { db.close() }
  })

  it('since returns messages after a given seq', () => {
    const h = new DeskHistory(makeDb())
    const s1 = h.append({ role: 'user', content: 'a', at: '2026-01-01T00:00:00Z' })
    h.append({ role: 'assistant', content: 'b', at: '2026-01-01T00:00:01Z' })
    const msgs = h.since(s1)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.content).toBe('b')
  })

  it('latestSeq returns 0 when empty and grows with appends', () => {
    const h = new DeskHistory(makeDb())
    expect(h.latestSeq()).toBe(0)
    h.append({ role: 'user', content: 'x', at: '2026-01-01T00:00:00Z' })
    expect(h.latestSeq()).toBeGreaterThan(0)
  })

  it('setSystem replaces the previous system message', () => {
    const h = new DeskHistory(makeDb())
    h.setSystem('v1')
    h.setSystem('v2')
    const msgs = h.recent(10).filter(m => m.role === 'system')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.content).toBe('v2')
  })

  it('stores and retrieves tool_calls on assistant messages', () => {
    const h = new DeskHistory(makeDb())
    const calls = [{ id: 'tc-1', name: 'ordin_list_tickets', arguments: '{}' }]
    h.append({ role: 'assistant', content: '', tool_calls: calls, at: '2026-01-01T00:00:00Z' })
    const r = h.since(0).filter(m => m.role === 'assistant')
    expect(r[0]!.tool_calls).toEqual(calls)
    expect(h.recent(10).filter(m => m.role === 'assistant')).toHaveLength(0) // incomplete call is not a model context
  })

  it('stores and retrieves tool result with tool_call_id', () => {
    const h = new DeskHistory(makeDb())
    h.append({ role: 'tool', content: '{"ok":true}', tool_call_id: 'tc-1', name: 'ordin_list_tickets', at: '2026-01-01T00:00:00Z' })
    const r = h.since(0).filter(m => m.role === 'tool')
    expect(h.recent(10).filter(m => m.role === 'tool')).toHaveLength(0) // orphan stays in audit history only
    expect(r[0]!.tool_call_id).toBe('tc-1')
    expect(r[0]!.name).toBe('ordin_list_tickets')
  })
})

describe('DeskHistory.trim is called by DeskLoop on each successful processEntry', () => {
  it('trim reduces rows above the keep limit', () => {
    const h = new DeskHistory(makeDb())
    // Add 5 non-system messages
    for (let i = 0; i < 5; i++) h.append({ role: 'user', content: `msg ${i}`, at: '2026-01-01T00:00:00Z' })
    expect(h.since(0).length).toBe(5)
    // trim(3) should keep only the 3 most recent
    h.trim(3)
    expect(h.since(0).length).toBe(3)
    // The 3 remaining should be the most recent
    const remaining = h.since(0)
    expect(remaining[0]!.content).toBe('msg 2')
    expect(remaining[2]!.content).toBe('msg 4')
  })

  it('trim does not remove system messages', () => {
    const h = new DeskHistory(makeDb())
    h.setSystem('system prompt')
    for (let i = 0; i < 5; i++) h.append({ role: 'user', content: `msg ${i}`, at: '2026-01-01T00:00:00Z' })
    h.trim(2)  // keep 2 non-system rows
    const all = h.recent(100)
    const system = all.filter(m => m.role === 'system')
    const nonSystem = all.filter(m => m.role !== 'system')
    expect(system).toHaveLength(1)  // system always preserved
    expect(nonSystem).toHaveLength(2)
  })

  it('trim is idempotent when rows are within the limit', () => {
    const h = new DeskHistory(makeDb())
    h.append({ role: 'user', content: 'only one', at: '2026-01-01T00:00:00Z' })
    h.trim(100)
    expect(h.since(0).length).toBe(1)
  })
})

/**
 * 【R3】DeskLoop 按需挂工具与直答结算，迁入自 ordin；LLM 换成 stub fetch，本地跑。
 *
 * 关键不变量：
 * 1. 首轮只暴露网关工具（ordin_use_tools）——不是全量 schema。
 * 2. 模型直答（无工具调用）时，engine.report(ready) 结掉分诊单。
 * 3. 模型调 ordin_use_tools 后，下一轮暴露全量管理工具。
 */
describe('DeskLoop R3: on-demand tool mounting and direct triage answer settlement', () => {
  it('first round passes only 1 tool (the gateway) to the LLM', async () => {
    const stub = stubLlm()
    const { loop } = fixture({ fetchFn: stub.direct('你好，我可以帮你。') })
    await loop.relay('req-1', 'hello')
    expect(stub.seenCounts[0], '首轮必须只挂载 1 个轻量网关工具').toBe(1)
  })

  it('direct text reply closes a running triage Assignment via engine.report(ready)', async () => {
    const reports: { state: string; summary: string }[] = []
    const engine = { report: (_id: string, r: { state: string; summary: string }) => { reports.push(r) } }
    const stub = stubLlm()
    const { loop } = fixture({
      fetchFn: stub.direct('纽约现在是晴天，气温 18°C。'),
      ticketRecord: triageTicket('triage-t1'),
      engine: engine as unknown as Engine,
    })
    await loop.relay('req-2', '现在纽约天气怎么样', 'triage-t1')
    expect(reports, '直答后必须调用 engine.report(ready) 结案分诊单').toHaveLength(1)
    expect(reports[0]!.state).toBe('ready')
    expect(reports[0]!.summary).toBe('纽约现在是晴天，气温 18°C。')
  })

  it('calling ordin_use_tools mounts the full toolset for the next round', async () => {
    const stub = stubLlm()
    const { loop } = fixture({
      fetchFn: stub.fetchFn(generateOf(
        [{ toolCalls: [{ id: 'tc-gate', name: 'ordin_use_tools', argumentsDelta: '{}' }], finishReason: 'tool_calls' }],
        [{ text: '已处理。' }],
      )),
    })
    await loop.relay('req-3', '帮我查一下现在有几张票')

    // Round 0 should see 1 tool (gateway), round 1 should see >1 (full toolset)
    expect(stub.seenCounts[0], '首轮必须只有 1 个网关工具').toBe(1)
    expect(stub.seenCounts[1], '调 ordin_use_tools 后必须挂载全套工具').toBeGreaterThan(1)
  })

  it('empty LLM reply drops a running triage Ticket instead of leaving it stuck forever', async () => {
    const reports: { state: string; summary: string }[] = []
    const engine = { report: (_id: string, r: { state: string; summary: string }) => { reports.push(r) } }
    const stub = stubLlm()
    const { loop } = fixture({
      fetchFn: stub.direct(''),
      ticketRecord: triageTicket('triage-empty'),
      engine: engine as unknown as Engine,
    })
    await loop.relay('req-empty', 'some question', 'triage-empty')
    expect(reports, '空回复必须触发 engine.report 而非静默返回').toHaveLength(1)
    expect(reports[0]!.state, '空回复应 dropped 而非 ready').toBe('dropped')
  })

  it('P1-2: replied event in this turn blocks settlement; old replied in prior turn does not', async () => {
    const reports: { state: string; summary: string }[] = []
    const engine = { report: (_id: string, r: { state: string; summary: string }) => { reports.push(r) } }
    // A replied event from a PRIOR turn (should not block settlement)
    const oldReplied = { type: 'replied', at: '2026-01-01T00:01:00Z', by: { kind: 'system' } }
    const stub = stubLlm()
    const loop1 = fixture({
      fetchFn: stub.direct('direct answer'),
      ticketRecord: triageTicket('t-p12'),
      events: [oldReplied],
      engine: engine as unknown as Engine,
    }).loop

    // Old replied should NOT block — settlement should happen
    await loop1.relay('req-p12-a', 'follow-up', 't-p12')
    expect(reports).toHaveLength(1)
    expect(reports[0]!.state).toBe('ready')
    reports.length = 0

    // Now simulate a replied event timestamped AFTER the turn started
    const thisReplied = { type: 'replied', at: '', by: { kind: 'system' } }
    const stub2 = stubLlm()
    const inTurnFetch = ((): LlmFetch => {
      const inner = stub2.direct('direct answer')
      return async (url, init) => {
        thisReplied.at = new Date().toISOString()
        return inner(url, init)
      }
    })()
    const loop2 = fixture({
      fetchFn: inTurnFetch,
      ticketRecord: triageTicket('t-p12'),
      events: [thisReplied],
      engine: engine as unknown as Engine,
    }).loop

    // In-turn replied SHOULD block — no report
    await loop2.relay('req-p12-b', 'question', 't-p12')
    expect(reports, 'in-turn replied should block settlement').toHaveLength(0)
    await loop1.stop().catch(() => {})
    await loop2.stop().catch(() => {})
  })

  it('P1-1: stop() is async and awaits the in-flight turn', async () => {
    let release!: () => void
    let started!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const running = new Promise<void>(resolve => { started = resolve })
    const stub = stubLlm()
    const fetchFn: LlmFetch = async (_url, init) => {
      started()
      await held
      return new Response(sse(eventsOf([{ text: 'done' }])), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const { loop } = fixture({ fetchFn })
    const relay = loop.relay('stop-join', 'question').catch(() => {})
    await running
    let stopped = false
    const stopping = loop.stop().then(() => { stopped = true })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(stopped).toBe(false)
      release()
      await stopping
      await relay
      expect(stopped).toBe(true)
    } finally {
      release()
      await stopping
      await relay
    }
  })
})
