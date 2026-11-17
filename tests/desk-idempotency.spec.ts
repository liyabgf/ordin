/**
 * Desk 幂等：requestId 成功回执（跨重启、跨 trim）、在途去重、失败不盖章。
 * 迁入自 ordin tests/desk-idempotency.spec.ts：LLM 从 Cordis ctx.llm 换成
 * 本地 stub fetch（deskLlmGenerate 的 fetchFn 注入点），绝不触真实 API。
 *
 * 失败性 finishReason 对齐 OpenAI 原生词表：ordin 的 'error'/'aborted' 在 Ordin
 * 是 DeskLlmError 抛错，'max-tokens' 是 'length'；provider 直接抛错另有专门用例。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { DeskLoop, type LlmFetch } from '../src/app/desk-loop.ts'
import { createLogger, silentLogger } from '../src/app/logger.ts'
import * as deskTools from '../src/app/desk-tools.ts'
import type { ToolsHost } from '../src/app/tools.ts'
import type { Prompts } from '../src/app/prompts.ts'
import type { Engine } from '../src/core/engine.ts'
import { parseSettings } from '../src/core/policy.ts'

const cfg = parseSettings({ deskLlm: { provider: 'p', model: 'm', baseUrl: 'http://stub.local/v1' } })
const dirs: string[] = []
const stores = new Set<Store>()
afterEach(() => { vi.restoreAllMocks(); for (const store of stores) store.close(); stores.clear(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function open(path?: string) {
  if (!path) { const dir = mkdtempSync('/tmp/ordin-desk-db-'); dirs.push(dir); path = join(dir, 'state.sqlite') }
  const store = new Store(path); stores.add(store); return { store, path }
}
function close(store: Store) { store.close(); stores.delete(store) }

// ── stub LLM: 本地编造 OpenAI SSE 流 ─────────────────────────────────────────────────────

interface StubChunk {
  readonly text?: string
  readonly toolCalls?: readonly { id: string; name: string; argumentsDelta?: string }[]
  readonly finishReason?: string
}

function sseOf(chunks: readonly StubChunk[]): string {
  const events: string[] = []
  for (const [index, chunk] of chunks.entries()) {
    const delta: Record<string, unknown> = {}
    if (chunk.text !== undefined) delta.content = chunk.text
    if (chunk.toolCalls !== undefined) {
      delta.tool_calls = chunk.toolCalls.map(call => ({
        index: 0, id: call.id,
        function: { name: call.name, arguments: call.argumentsDelta ?? '{}' },
      }))
    }
    events.push(`data: ${JSON.stringify({
      choices: [{ index: 0, delta, ...(index === chunks.length - 1 ? { finish_reason: chunk.finishReason ?? 'stop' } : {}) }],
    })}`)
  }
  events.push('data: [DONE]')
  return events.join('\n\n') + '\n\n'
}

/** 第 n 次调用吐 generate(n) 给出的 chunk；generate 不返回时默认一轮直答 'done'。 */
function stubFetch(generate?: (n: number) => AsyncGenerator<StubChunk>): { fetchFn: LlmFetch; calls: () => number } {
  let calls = 0
  const fetchFn: LlmFetch = async (_url, _init) => {
    calls++
    const chunks: StubChunk[] = []
    if (generate) for await (const chunk of generate(calls)) chunks.push(chunk)
    else chunks.push({ text: 'done' })
    return new Response(sseOf(chunks), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  return { fetchFn, calls: () => calls }
}

function fixture(store: Store, generate?: (n: number) => AsyncGenerator<StubChunk>, engine?: Engine) {
  const stub = stubFetch(generate)
  const loop = new DeskLoop({
    logger: silentLogger(), store,
    toolsHost: {} as ToolsHost,
    prompts: { current: () => '' } as unknown as Prompts,
    settings: () => cfg,
    fetchFn: stub.fetchFn,
    engine,
  })
  return { loop, calls: stub.calls }
}
const receiptKeys = (store: Store) => store.keys('desk:request:success:')

describe('Desk durable successful request receipts', () => {
  it.each([401, 429, 500])('HTTP %s upstream echo never reaches errors, health, history, or logs', async status => {
    const { store } = open()
    const marker = 'SYNTHETIC_BODY_ECHO_83a9'
    const logs: string[] = []
    const loop = new DeskLoop({
      logger: createLogger({ sink: line => logs.push(line) }), store,
      toolsHost: {} as ToolsHost, prompts: { current: () => '' } as unknown as Prompts,
      settings: () => cfg,
      fetchFn: async () => new Response(marker, { status, headers: { 'retry-after': '2' } }),
    })
    const error = await loop.relay('echo-' + status, 'hello').catch(e => e)
    expect(error).toMatchObject({ status, retryable: status !== 401, retryAfterMs: 2000 })
    expect(String(error)).toContain('HTTP ' + status)
    expect(String(error)).not.toContain(marker)
    expect(loop.getStatus().recentErrors.join(' ')).toContain('HTTP ' + status)
    expect(loop.getStatus().recentErrors.join(' ')).not.toContain(marker)
    expect(JSON.stringify(store.deskHistory.since(0))).not.toContain(marker)
    expect(logs.join(' ')).toContain('HTTP ' + status)
    expect(logs.join(' ')).not.toContain(marker)
    expect(receiptKeys(store)).toHaveLength(0)
  })

  it('shares in-flight work and skips sequential replay without appending', async () => {
    const { store } = open(); const f = fixture(store)
    const first = f.loop.relay('same', 'hello'); const duplicate = f.loop.relay('same', 'hello')
    expect(duplicate).toBe(first); await first
    const before = store.deskHistory.latestSeq(); await f.loop.relay('same', 'hello')
    expect(f.calls()).toBe(1); expect(store.deskHistory.latestSeq()).toBe(before)
    const receipt = store.get<Record<string, unknown>>(receiptKeys(store)[0]!)
    expect(receipt!.version).toBe(1); expect(receipt!.fingerprint).toMatch(/^[a-f0-9]{64}$/); expect(Number.isNaN(Date.parse(String(receipt!.completedAt)))).toBe(false)
  })

  it('survives real Store close/reopen and history trim for relay and notify', async () => {
    const { store, path } = open(); const f = fixture(store)
    await f.loop.relay('restart', 'hello'); await f.loop.notify('notice', 'news')
    store.deskHistory.append({ role: 'user', content: 'later', at: new Date().toISOString() }); store.deskHistory.trim(1)
    expect(store.deskHistory.since(0).some(m => m.requestId === 'restart')).toBe(false)
    close(store); const reopened = open(path).store; const next = fixture(reopened)
    const seq = reopened.deskHistory.latestSeq(); await next.loop.relay('restart', 'hello'); await next.loop.notify('notice', 'news')
    expect(next.calls()).toBe(0); expect(reopened.deskHistory.latestSeq()).toBe(seq); expect(receiptKeys(reopened)).toHaveLength(2)
  })

  it('rejects concurrent and durable conflicts in text, kind, and ticket identity', async () => {
    const { store } = open(); const f = fixture(store)
    const first = f.loop.relay('conflict', 'a')
    await expect(f.loop.relay('conflict', 'b')).rejects.toThrow(/conflict/i); await first
    await expect(f.loop.notify('conflict', 'a')).rejects.toThrow(/conflict/i)
    await expect(f.loop.relay('conflict', 'a', 'other-ticket')).rejects.toThrow(/conflict/i)
    expect(f.calls()).toBe(1)
  })

  it('registers the Map before synchronous schedule reentry', async () => {
    const { store } = open(); const f = fixture(store)
    const internal = f.loop as unknown as { scheduleRun: () => void }
    const schedule = internal.scheduleRun.bind(f.loop)
    let nested: Promise<void> | undefined; let entered = false
    internal.scheduleRun = () => { if (!entered) { entered = true; nested = f.loop.relay('reentry', 'hello') }; schedule() }
    const first = f.loop.relay('reentry', 'hello'); expect(nested).toBe(first); await first; expect(f.calls()).toBe(1)
  })

  it('atomically rolls notify history back when receipt persistence fails, then retries', async () => {
    const { store } = open(); const f = fixture(store); const original = store.set.bind(store)
    const fail = vi.spyOn(store, 'set').mockImplementation((key: string, value: unknown) => { original(key, value); throw new Error('receipt disk failure') })
    await expect(f.loop.notify('atomic-notice', 'news')).rejects.toThrow('receipt disk failure')
    expect(store.deskHistory.since(0)).toHaveLength(0); expect(receiptKeys(store)).toHaveLength(0)
    fail.mockRestore(); await f.loop.notify('atomic-notice', 'news'); await f.loop.notify('atomic-notice', 'news')
    expect(store.deskHistory.since(0)).toHaveLength(1); expect(receiptKeys(store)).toHaveLength(1)
  })

  it.each(['length', 'content_filter', 'incomplete'])('does not stamp a %s finish, treats it as failure, and retries', async reason => {
    const { store } = open(); const f = fixture(store, async function* (n) {
      yield { text: 'answer', finishReason: n === 1 ? reason : 'stop' }
    })
    // 失败性 finish 必须判 failure：健康板可见（不静默通过），也不盖成功回执。
    await f.loop.relay('failed-finish', 'hello')
    expect(receiptKeys(store), `${reason} finish 不得盖成功回执`).toHaveLength(0)
    expect(f.loop.getStatus().recentErrors.some(m => m.includes(reason)), `${reason} finish 必须进健康板`).toBe(true)
    await f.loop.relay('failed-finish', 'hello'); await f.loop.relay('failed-finish', 'hello'); expect(f.calls()).toBe(2)
  })

  it('does not receipt successful-resolution non-stop finishes', async () => {
    const { store } = open(); const f = fixture(store, async function* (n) {
      // finish_reason='tool_calls' 却没有任何 tool_calls delta：Ordinal client 原样透传，
      // 循环按"非 stop 直答"判失败，不盖成功回执（与 ordin 语义一致）。
      yield { text: 'partial', finishReason: n === 1 ? 'tool_calls' : 'stop' }
    })
    await f.loop.relay('non-stop', 'hello'); expect(receiptKeys(store)).toHaveLength(0)
    await f.loop.relay('non-stop', 'hello'); await f.loop.relay('non-stop', 'hello'); expect(f.calls()).toBe(2)
  })

  it('retries provider throw and receipt write failure without pretending exactly-once', async () => {
    const { store } = open(); const f = fixture(store, async function* (n) {
      if (n === 1) throw new Error('provider failure')
      yield { text: 'done' }
    })
    await expect(f.loop.relay('retry', 'hello')).rejects.toThrow('provider failure'); expect(receiptKeys(store)).toHaveLength(0)
    const fail = vi.spyOn(store, 'set').mockImplementation(() => { throw new Error('disk failure') })
    await expect(f.loop.relay('retry', 'hello')).rejects.toThrow('disk failure'); expect(receiptKeys(store)).toHaveLength(0)
    fail.mockRestore(); await f.loop.relay('retry', 'hello'); await f.loop.relay('retry', 'hello'); expect(f.calls()).toBe(3)
  })

  it('allows a confirmed retry of the same failed tool action', async () => {
    const { store } = open(); let attempts = 0
    vi.spyOn(deskTools, 'executeDeskToolCalls').mockImplementation(async calls => {
      const call = calls[0]!; attempts++
      return [{ toolCallId: call.id, name: call.name, content: attempts === 1 ? 'temporary failure' : 'done', isError: attempts === 1 }]
    })
    const f = fixture(store, async function* (n) {
      if (n <= 2) yield { toolCalls: [{ id: `call-${n}`, name: 'ordin_close_ticket', argumentsDelta: '{"ticketId":"a"}' }], finishReason: 'tool_calls' }
      else yield { text: 'done' }
    })
    await f.loop.relay('repair', 'hello'); await f.loop.relay('repair', 'hello')
    expect(attempts).toBe(2); expect(f.calls()).toBe(3); expect(receiptKeys(store)).toHaveLength(1)
  })

  it('documents the tool-effect-before-receipt crash window by retrying unconfirmed work', async () => {
    const { store } = open(); let sideEffects = 0
    vi.spyOn(deskTools, 'executeDeskToolCalls').mockImplementation(async calls => {
      sideEffects++; const call = calls[0]!
      return [{ toolCallId: call.id, name: call.name, content: 'effect completed', isError: false }]
    })
    const f = fixture(store, async function* (n) {
      if (n % 2 === 1) yield { toolCalls: [{ id: `call-${n}`, name: 'ordin_close_ticket', argumentsDelta: '{"ticketId":"a"}' }], finishReason: 'tool_calls' }
      else yield { text: 'done' }
    })
    const fail = vi.spyOn(store, 'set').mockImplementation(() => { throw new Error('crash before receipt commit') })
    await expect(f.loop.relay('window', 'hello')).rejects.toThrow('crash before receipt commit')
    expect(sideEffects).toBe(1); expect(receiptKeys(store)).toHaveLength(0)
    fail.mockRestore(); await f.loop.relay('window', 'hello'); await f.loop.relay('window', 'hello')
    expect(sideEffects).toBe(2); expect(f.calls()).toBe(4)
  })

  it('does not stamp tool round exhaustion and permits retry', async () => {
    const { store } = open(); let exhaust = true
    const f = fixture(store, async function* () {
      if (exhaust) yield { toolCalls: [{ id: 'gate', name: 'ordin_use_tools', argumentsDelta: '{}' }], finishReason: 'tool_calls' }
      else yield { text: 'done' }
    })
    await f.loop.relay('rounds', 'hello'); expect(f.calls()).toBe(10); expect(receiptKeys(store)).toHaveLength(0)
    exhaust = false; await f.loop.relay('rounds', 'hello'); await f.loop.relay('rounds', 'hello'); expect(f.calls()).toBe(11)
  })

  it('does not stamp a final answer after an unresolved tool failure', async () => {
    const { store } = open(); const f = fixture(store, async function* (n) {
      if (n === 1) yield { toolCalls: [{ id: 'bad', name: 'unknown_action', argumentsDelta: '{}' }], finishReason: 'tool_calls' }
      else yield { text: 'done' }
    })
    await f.loop.relay('tool-error', 'hello'); expect(receiptKeys(store)).toHaveLength(0)
    await f.loop.relay('tool-error', 'hello'); await f.loop.relay('tool-error', 'hello'); expect(f.calls()).toBe(3)
  })

  it('failure finish alongside tool calls executes no tool and reports the triage failed (P1-3)', async () => {
    const { store } = open()
    let sideEffects = 0
    vi.spyOn(deskTools, 'executeDeskToolCalls').mockImplementation(async calls => {
      sideEffects++; const call = calls[0]!
      return [{ toolCallId: call.id, name: call.name, content: 'should never run', isError: false }]
    })
    const reports: { state: string; summary: string }[] = []
    const engine = { report: (_id: string, r: { state: string; summary: string }) => { reports.push(r) } }
    const f = fixture(store, async function* () {
      yield { toolCalls: [{ id: 'c', name: 'ordin_close_ticket', argumentsDelta: '{}' }], finishReason: 'length' }
    }, engine as unknown as Engine)
    const ticket = { id: 'triage-len', assignments: [{ id: 'a', role: 'triage', state: 'running' }] }
    vi.spyOn(store.tickets, 'get').mockReturnValue(ticket as never)
    await f.loop.relay('fail-tools', 'hello', 'triage-len')
    expect(sideEffects, '失败性 finish 不得执行任何工具（P1-3：失败生成不得产生副作用）').toBe(0)
    expect(reports[0]?.state, '分诊单必须报 failed').toBe('failed')
    expect(receiptKeys(store)).toHaveLength(0)
  })

  it('unconfigured desk: rejects the relay, runs no LLM call, and the failure is visible in health', async () => {
    const { store } = open()
    const unconfigured = parseSettings({ deskLlm: { provider: '只作显示名', model: '', baseUrl: '' } })
    const stub = stubFetch()
    const loop = new DeskLoop({
      logger: silentLogger(), store, toolsHost: {} as ToolsHost,
      prompts: { current: () => '' } as unknown as Prompts,
      settings: () => unconfigured, fetchFn: stub.fetchFn,
    })
    expect(loop.getStatus().configured, '未配置时 configured 必须为 false（写死 false 的变异必须红）').toBe(false)
    await expect(loop.relay('nc-1', 'hello')).rejects.toThrow(/not configured/i)
    expect(stub.calls()).toBe(0)                       // 不跑队列：没有 LLM 调用
    expect(loop.getStatus().configured).toBe(false)    // 健康板可见：未配置
    expect(loop.getStatus().recentErrors.some(m => m.includes('not configured'))).toBe(true)
  })

  it('apiKeyEnv named but env var missing: loud config error and no network call, key never printed', async () => {
    const { store } = open()
    const settings = parseSettings({ deskLlm: { provider: 'p', model: 'm', baseUrl: 'http://stub.local/v1', apiKeyEnv: 'ORDIN_DESK_KEY_MUTATION_TEST' } })
    delete process.env.ORDIN_DESK_KEY_MUTATION_TEST
    const stub = stubFetch()
    const loop = new DeskLoop({
      logger: silentLogger(), store, toolsHost: {} as ToolsHost,
      prompts: { current: () => '' } as unknown as Prompts,
      settings: () => settings, fetchFn: stub.fetchFn,
    })
    await expect(loop.relay('nc-key', 'hello')).rejects.toThrow(/ORDIN_DESK_KEY_MUTATION_TEST/)
    expect(stub.calls()).toBe(0)
  })

  it('does not stamp failed or empty direct triage settlement; never reopens ended tickets', async () => {
    const { store } = open(); const ticket = { id: 'triage', assignments: [{ id: 'a', role: 'triage', state: 'running' }] }
    vi.spyOn(store.tickets, 'get').mockReturnValue(ticket as never)
    const report = vi.fn<(id: string, report: unknown) => void>(() => { throw new Error('settlement failure') })
    const f = fixture(store, undefined, { report } as unknown as Engine)
    await f.loop.relay('settle', 'hello', 'triage'); expect(receiptKeys(store)).toHaveLength(0)
    report.mockImplementation(() => {}); await f.loop.relay('settle', 'hello', 'triage'); expect(receiptKeys(store)).toHaveLength(1)
    const empty = fixture(store, async function* () { yield { text: '' } }, { report } as unknown as Engine)
    await empty.loop.relay('empty', 'hello', 'triage'); expect(receiptKeys(store)).toHaveLength(1)
    expect(report).toHaveBeenLastCalledWith('triage', expect.objectContaining({ state: 'dropped' }))
    vi.mocked(store.tickets.get).mockReturnValue({ ...ticket, ended: { outcome: 'failed' } } as never)
    const before = f.calls(); await f.loop.relay('terminal', 'hello', 'triage'); expect(f.calls()).toBe(before)
    expect(receiptKeys(store)).toHaveLength(1)
  })
})
