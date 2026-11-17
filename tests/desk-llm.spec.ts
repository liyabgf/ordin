/**
 * tests/desk-llm.spec.ts — Ordin 自带 LLM client 的离线测试。
 *
 * 只用 127.0.0.1 本地 HTTP server 与 stub fetch，禁止任何真实外部 API 调用。
 * 覆盖：文本回复、工具调用、请求形状、401/403、429、5xx、其他 4xx、
 *       超时、调用方取消、网络错误、SSE 分片/CRLF/注释/[DONE]、截断流、坏 JSON。
 */
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { DeskMessage } from '../src/app/desk-history.ts'
import {
  deskLlmGenerate,
  DeskLlmError,
  type DeskLlmConfig,
  type LlmToolSchema,
} from '../src/desk/llm.ts'

// ── 本地 SSE server 设施 ─────────────────────────────────────────────────────

interface CapturedRequest {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}

interface TestServer {
  baseUrl: string
  requests: CapturedRequest[]
  close: () => Promise<void>
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void

const running: TestServer[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map(server => server.close()))
})

async function startServer(handler: Handler): Promise<TestServer> {
  const requests: CapturedRequest[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { body += chunk })
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      handler(req, res, body)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
  running.push(testServer)
  return testServer
}

// ── SSE 构造助手 ─────────────────────────────────────────────────────────────

function sseHead(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
}

function send(res: ServerResponse, payload: string): void {
  res.write(`data: ${payload}\n\n`)
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })
}

function done(res: ServerResponse): void {
  res.write('data: [DONE]\n\n')
  res.end()
}

// ── 公共夹具 ─────────────────────────────────────────────────────────────────

const tools: readonly LlmToolSchema[] = [
  {
    name: 'ordin_list_tickets',
    description: '列出工单',
    parameters: { type: 'object', properties: { state: { type: 'string' } }, additionalProperties: false },
  },
]

const history: readonly DeskMessage[] = [
  { seq: 1, role: 'system', content: '你是总管。', at: '2026-11-15T00:00:00Z' },
  { seq: 2, role: 'user', content: '有哪些工单？', at: '2026-11-15T00:00:01Z' },
  {
    seq: 3,
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_1', name: 'ordin_list_tickets', arguments: '{}' }],
    at: '2026-11-15T00:00:02Z',
  },
  { seq: 4, role: 'tool', content: '{"tickets":[]}', tool_call_id: 'call_1', name: 'ordin_list_tickets', at: '2026-11-15T00:00:03Z' },
  { seq: 5, role: 'user', content: '好的', at: '2026-11-15T00:00:04Z' },
]

function cfg(server: TestServer, extra: Partial<DeskLlmConfig> = {}): DeskLlmConfig {
  return {
    baseUrl: server.baseUrl,
    apiKey: 'sk-test',
    model: 'test-model',
    temperature: 0.2,
    maxTokens: 1024,
    timeoutMs: 3000,
    ...extra,
  }
}

async function captureError(promise: Promise<unknown>): Promise<DeskLlmError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof DeskLlmError) return error
    throw new Error(`expected DeskLlmError, got: ${String(error)}`)
  }
  throw new Error('expected deskLlmGenerate to reject, but it resolved')
}

// ── 正常路径 ─────────────────────────────────────────────────────────────────

describe('正常生成', () => {
  it('文本回复：SSE delta 拼装，finishReason=stop，无工具调用', async () => {
    const server = await startServer((_req, res) => {
      sseHead(res)
      send(res, chunk({ role: 'assistant', content: '没有' }))
      send(res, chunk({ content: '进行中的' }))
      send(res, chunk({ content: '工单。' }))
      send(res, chunk({}, 'stop'))
      done(res)
    })

    const result = await deskLlmGenerate(cfg(server), history, tools)
    expect(result.text).toBe('没有进行中的工单。')
    expect(result.finishReason).toBe('stop')
    expect(result.toolCalls).toEqual([])
  })

  it('工具调用：arguments 分片拼接、多 index 并行调用，finishReason=tool_calls', async () => {
    const server = await startServer((_req, res) => {
      sseHead(res)
      // 第一个调用：id/name 只在首片，arguments 跨两片
      send(res, chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'ordin_create_ticket', arguments: '{"title":"修' } }] }))
      send(res, chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'ordin_reply', arguments: '{"text":"好' } }] }))
      send(res, chunk({ tool_calls: [{ index: 0, function: { arguments: '灯","severity":"high"}' } }] }))
      send(res, chunk({ tool_calls: [{ index: 1, function: { arguments: '的"}' } }] }))
      send(res, chunk({}, 'tool_calls'))
      done(res)
    })

    const result = await deskLlmGenerate(cfg(server), history, tools)
    expect(result.text).toBe('')
    expect(result.finishReason).toBe('tool_calls')
    expect(result.toolCalls).toEqual([
      { id: 'call_a', name: 'ordin_create_ticket', arguments: '{"title":"修灯","severity":"high"}' },
      { id: 'call_b', name: 'ordin_reply', arguments: '{"text":"好的"}' },
    ])
  })

  it('请求形状：POST /chat/completions、鉴权头、消息映射与工具包装', async () => {
    const server = await startServer((_req, res) => {
      sseHead(res)
      send(res, chunk({ content: 'ok' }, 'stop'))
      done(res)
    })

    await deskLlmGenerate(cfg(server), history, tools)

    expect(server.requests).toHaveLength(1)
    const captured = server.requests[0]!
    expect(captured.method).toBe('POST')
    expect(captured.url).toBe('/v1/chat/completions')
    expect(captured.headers.authorization).toBe('Bearer sk-test')
    expect(captured.headers.accept).toBe('text/event-stream')

    const body = JSON.parse(captured.body) as Record<string, unknown>
    expect(body).toMatchObject({ model: 'test-model', temperature: 0.2, max_tokens: 1024, stream: true })
    expect(body.messages).toEqual([
      { role: 'system', content: '你是总管。' },
      { role: 'user', content: '有哪些工单？' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ordin_list_tickets', arguments: '{}' } }],
      },
      // OpenAI tool 消息不带 name 字段
      { role: 'tool', content: '{"tickets":[]}', tool_call_id: 'call_1' },
      { role: 'user', content: '好的' },
    ])
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'ordin_list_tickets',
          description: '列出工单',
          parameters: { type: 'object', properties: { state: { type: 'string' } }, additionalProperties: false },
        },
      },
    ])
  })

  it('apiKey 为空时不发 Authorization 头（本地免鉴权网关）', async () => {
    const server = await startServer((_req, res) => {
      sseHead(res)
      send(res, chunk({ content: 'ok' }, 'stop'))
      done(res)
    })

    await deskLlmGenerate(cfg(server, { apiKey: '' }), history, [])
    const captured = server.requests[0]!
    expect(captured.headers.authorization).toBeUndefined()
    expect(JSON.parse(captured.body)).not.toHaveProperty('tools')
  })
})

// ── SSE 协议健壮性 ───────────────────────────────────────────────────────────

describe('SSE 解析', () => {
  it('容忍 TCP 分片、CRLF、注释行、event 行与空 choices chunk', async () => {
    const payload1 = chunk({ content: '第一' })
    const payload2 = chunk({ content: '第二' })
    const server = await startServer((_req, res) => {
      sseHead(res)
      res.write(': keep-alive\r\n\r\n')          // SSE 注释
      res.write('event: message\r\n')              // event 行后跟 data
      res.write(`data: ${payload1.slice(0, 20)}`) // JSON 从中间断开
      res.write(`${payload1.slice(20)}\r\n\r\n`)
      res.write(JSON.stringify({ choices: [] }) + '\n') // 非法行：无 data: 前缀，忽略
      send(res, JSON.stringify({ id: 'x', choices: [] })) // 空 choices，跳过
      send(res, payload2)
      send(res, chunk({}, 'stop'))
      done(res)
    })

    const result = await deskLlmGenerate(cfg(server), history, tools)
    expect(result.text).toBe('第一第二')
    expect(result.finishReason).toBe('stop')
  })

  it('截断流（连接结束但无 finish_reason/[DONE]）→ finishReason=incomplete，不谎称 stop', async () => {
    const server = await startServer((_req, res) => {
      sseHead(res)
      send(res, chunk({ content: '半句话' }))
      res.end() // 对端直接断流
    })

    const result = await deskLlmGenerate(cfg(server), history, tools)
    expect(result.text).toBe('半句话')
    expect(result.finishReason).toBe('incomplete')
  })

  it('data 载荷是坏 JSON → protocol 错误，不静默跳过', async () => {
    const server = await startServer((_req, res) => {
      sseHead(res)
      send(res, '{not valid json')
      done(res)
    })

    const error = await captureError(deskLlmGenerate(cfg(server), history, tools))
    expect(error.kind).toBe('protocol')
    expect(error.retryable).toBe(false)
  })
})

// ── HTTP 错误分类：绝不当成功 ────────────────────────────────────────────────

describe('HTTP 错误分类', () => {
  function errorServer(status: number, body: string, headers: Record<string, string> = {}): Promise<TestServer> {
    return startServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(body)
    })
  }

  it('401 → auth，不可重试，status 透出', async () => {
    const server = await errorServer(401, '{"error":{"message":"invalid api key"}}')
    const error = await captureError(deskLlmGenerate(cfg(server), history, tools))
    expect(error.kind).toBe('auth')
    expect(error.status).toBe(401)
    expect(error.retryable).toBe(false)
    expect(error.message).toContain('HTTP 401')
    expect(error.message).not.toContain('invalid api key')
  })

  it('403 → auth', async () => {
    const server = await errorServer(403, 'forbidden')
    const error = await captureError(deskLlmGenerate(cfg(server), history, tools))
    expect(error.kind).toBe('auth')
    expect(error.status).toBe(403)
  })

  it('429 → rate_limit，可重试，Retry-After 换算成毫秒', async () => {
    const server = await errorServer(429, 'slow down', { 'retry-after': '2' })
    const error = await captureError(deskLlmGenerate(cfg(server), history, tools))
    expect(error.kind).toBe('rate_limit')
    expect(error.retryable).toBe(true)
    expect(error.retryAfterMs).toBe(2000)
  })

  it('500 → server，可重试，仅状态进 message，绝不解析成响应', async () => {
    // 即使 body 长得像 SSE，也绝不能被当成功
    const server = await errorServer(500, 'data: {"choices":[{"delta":{"content":"fake"}}]}\n\n')
    const error = await captureError(deskLlmGenerate(cfg(server), history, tools))
    expect(error.kind).toBe('server')
    expect(error.status).toBe(500)
    expect(error.retryable).toBe(true)
    expect(error.message).toContain('HTTP 500')
  })

  it('503 → server；无 Retry-After 时 retryAfterMs 为 undefined', async () => {
    const server = await errorServer(503, 'upstream unavailable')
    const error = await captureError(deskLlmGenerate(cfg(server), history, tools))
    expect(error.kind).toBe('server')
    expect(error.retryAfterMs).toBeUndefined()
  })

  it('400 → http，不可重试（请求本身有问题）', async () => {
    const server = await errorServer(400, '{"error":{"message":"max_tokens too large"}}')
    const error = await captureError(deskLlmGenerate(cfg(server), history, tools))
    expect(error.kind).toBe('http')
    expect(error.status).toBe(400)
    expect(error.retryable).toBe(false)
    expect(error.message).toContain('HTTP 400')
    expect(error.message).not.toContain('max_tokens too large')
  })
})

// ── 超时、取消、网络 ─────────────────────────────────────────────────────────

describe('超时与取消', () => {
  it('服务端不应答 → timeout 分类，及时拒绝', async () => {
    const server = await startServer(() => {
      // 永不应答：不写头也不结束
    })
    const started = Date.now()
    const error = await captureError(deskLlmGenerate(cfg(server, { timeoutMs: 50 }), history, tools))
    expect(error.kind).toBe('timeout')
    expect(error.retryable).toBe(false)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('流式中途调用方取消 → aborted，与 timeout 区分', async () => {
    const server = await startServer((_req, res) => {
      sseHead(res)
      send(res, chunk({ content: '开始' }))
      // 之后挂起，不再写
    })
    const controller = new AbortController()
    const started = Date.now()
    const promise = deskLlmGenerate(cfg(server, { timeoutMs: 5000 }), history, tools, controller.signal)
    setTimeout(() => { controller.abort() }, 30)
    const error = await captureError(promise)
    expect(error.kind).toBe('aborted')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('响应头到达前调用方取消 → aborted（不得归类为可重试的 network）', async () => {
    // 变异检验发现：此路径走 translateFetchError 的 caller.aborted 分支，
    // 与流式中途取消（走 reader.read() 拒绝）是两条不同代码路径，必须各自覆盖。
    const server = await startServer(() => {
      // 收到请求但永不应答（连头也不写）
    })
    const controller = new AbortController()
    const started = Date.now()
    const promise = deskLlmGenerate(cfg(server, { timeoutMs: 5000 }), history, tools, controller.signal)
    setTimeout(() => { controller.abort() }, 30)
    const error = await captureError(promise)
    expect(error.kind).toBe('aborted')
    expect(error.retryable).toBe(false)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('预取消的 signal：立即拒绝，根本不发请求', async () => {
    const server = await startServer((_req, res) => {
      sseHead(res)
      send(res, chunk({ content: 'ok' }, 'stop'))
      done(res)
    })
    const controller = new AbortController()
    controller.abort()
    const error = await captureError(deskLlmGenerate(cfg(server), history, tools, controller.signal))
    expect(error.kind).toBe('aborted')
    expect(server.requests).toHaveLength(0)
  })

  it('连接层失败（stub fetch 拒绝）→ network，可重试', async () => {
    const failingFetch: typeof fetch = (() => {
      throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:1')
    }) as unknown as typeof fetch
    const config: DeskLlmConfig = {
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      fetchFn: failingFetch,
    }
    const error = await captureError(deskLlmGenerate(config, history, tools))
    expect(error.kind).toBe('network')
    expect(error.retryable).toBe(true)
  })
})

// ── 配置校验 ─────────────────────────────────────────────────────────────────

describe('配置校验', () => {
  it('baseUrl 或 model 为空 → config 错误，不发请求', async () => {
    const server = await startServer((_req, res) => { res.end() })
    const noUrl = await captureError(deskLlmGenerate(cfg(server, { baseUrl: '' }), history, tools))
    expect(noUrl.kind).toBe('config')
    const noModel = await captureError(deskLlmGenerate(cfg(server, { model: '  ' }), history, tools))
    expect(noModel.kind).toBe('config')
    expect(server.requests).toHaveLength(0)
  })
})
