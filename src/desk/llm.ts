/**
 * Ordin 自带 LLM client（OpenAI 兼容 streaming chat）。
 *
 * 取代 ordin desk-llm.ts 的 ctx.llm.stream() 依赖：DeskLoop 迁入 Ordin 后
 * 不再经过 DSH provider 层，直接以 OpenAI chat/completions SSE 协议对话。
 * 零依赖（Node >= 24 全局 fetch），凭据由 Ordin 设置注入，本文件不读盘、不读 env。
 *
 * 输入输出（与 ordin desk-llm.ts 对齐，便于 DeskLoop 迁入）：
 *   输入：config(baseUrl/apiKey/model/…) + DeskMessage[](system→history→新消息) + 工具 schema + AbortSignal
 *   输出：DeskLlmResponse { text, toolCalls, finishReason } —— 仅在一次完整生成结束时返回
 *
 * finishReason 词表（OpenAI 原生，原样透传）：'stop' | 'length' | 'tool_calls' | 'content_filter'；
 * 流被截断（连接结束但未收到 finish_reason/[DONE]）时为 'incomplete' —— 绝不把截断说成 'stop'（A6/A7）。
 *
 * 错误纪律：HTTP 401/429/5xx、超时、取消、网络、协议错误一律 throw DeskLlmError（带 kind 分类），
 * 绝不把 HTTP 错误当作成功响应返回（任务红线）。
 *
 * 状态：〔离线验证〕本文件只有本地 HTTP server / stub fetch 测试；真实 provider 实测属后续卡。
 * DeskLoop 本体迁入是另一张卡，本文件只冻结 client 侧的接口与错误语义。
 */
import type { DeskMessage, DeskToolCall } from '../app/desk-history.ts'

// ── types ──────────────────────────────────────────────────────────────────────────

/** 单次生成调用的配置。对应 settings.deskLlm + 凭据；baseUrl 不带 /chat/completions 后缀。 */
export interface DeskLlmConfig {
  /** OpenAI 兼容服务根，例如 https://api.openai.com/v1 或 http://127.0.0.1:8080/v1。 */
  baseUrl: string
  /** Bearer key；本地免鉴权网关可传空串，此时不发 Authorization 头。 */
  apiKey?: string
  model: string
  temperature?: number
  maxTokens?: number
  /** 整次调用（含流式读取）的总超时，默认 DEFAULT_LLM_TIMEOUT_MS。0 表示不设超时。 */
  timeoutMs?: number
  /** 测试注入点；默认全局 fetch。 */
  fetchFn?: typeof fetch
}

/** 工具 schema，结构与 ordin desk-tools.ts 的 ToolSchema 对齐（name/description/parameters）。 */
export interface LlmToolSchema {
  name: string
  description: string
  /** JSON Schema object，原样放进 function.parameters。 */
  parameters: Record<string, unknown>
}

/** 一次完成的 assistant turn：文本、工具调用或两者兼有。 */
export interface DeskLlmResponse {
  /** 拼好并 trim 的文本（与 ordin assembleResponse 行为一致）。 */
  text: string
  toolCalls: readonly DeskToolCall[]
  /** OpenAI finish_reason 原样透传；截断流为 'incomplete'。 */
  finishReason: string
}

export type DeskLlmErrorKind =
  /** 配置缺失/非法，重试无意义。 */
  | 'config'
  /** 401/403：鉴权失败，重试无意义，先修 key。 */
  | 'auth'
  /** 429：限流，可重试（retryAfterMs 尽量透出）。 */
  | 'rate_limit'
  /** 5xx：服务端故障，可重试。 */
  | 'server'
  /** 其他非 2xx（如 400/404/422）：请求本身有问题，重试无意义。 */
  | 'http'
  /** 本 client 自己的超时（与调用方取消区分）。 */
  | 'timeout'
  /** 调用方 AbortSignal 触发。 */
  | 'aborted'
  /** fetch 层网络错误（DNS/连接拒绝/TLS 等），可重试。 */
  | 'network'
  /** 响应体不是合法 SSE / JSON：协议不符，结果不可信。 */
  | 'protocol'

export class DeskLlmError extends Error {
  override readonly name = 'DeskLlmError'
  /** rate_limit / server / network 为 true，其余为 false；可显式覆盖。 */
  readonly retryable: boolean
  /** HTTP 状态码（仅 auth/rate_limit/server/http 时有）。 */
  readonly status?: number
  /** Retry-After 头换算的毫秒数（仅服务端带该头时有）。 */
  readonly retryAfterMs?: number

  constructor(
    readonly kind: DeskLlmErrorKind,
    message: string,
    options: { status?: number; retryAfterMs?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.retryable = options.retryable ?? (kind === 'rate_limit' || kind === 'server' || kind === 'network')
    this.status = options.status
    this.retryAfterMs = options.retryAfterMs
  }
}

/** 与 ordin DeskLoop 的 LLM_CALL_TIMEOUT_MS 对齐。 */
export const DEFAULT_LLM_TIMEOUT_MS = 5 * 60_000

// ── call ───────────────────────────────────────────────────────────────────────────

/**
 * 发一次 streaming chat 请求并收完整个 assistant turn。
 * 成功返回 DeskLlmResponse；任何失败（含 HTTP 非 2xx）都 throw DeskLlmError。
 */
export async function deskLlmGenerate(
  config: DeskLlmConfig,
  history: readonly DeskMessage[],
  tools: readonly LlmToolSchema[],
  signal?: AbortSignal,
): Promise<DeskLlmResponse> {
  if (!config.baseUrl.trim()) throw new DeskLlmError('config', 'Desk LLM baseUrl is empty.')
  if (!config.model.trim()) throw new DeskLlmError('config', 'Desk LLM model is empty.')
  if (signal?.aborted) throw new DeskLlmError('aborted', 'Desk LLM call aborted before start.')

  const fetchFn = config.fetchFn ?? fetch
  const timeoutMs = config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS
  const timeoutController = new AbortController()
  const timer = timeoutMs > 0 ? setTimeout(() => { timeoutController.abort() }, timeoutMs) : undefined
  const effectiveSignal = signal !== undefined
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal

  try {
    const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    }
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`

    let response: Response
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildRequest(config, history, tools)),
        signal: effectiveSignal,
      })
    } catch (error) {
      throw translateFetchError(error, signal, timeoutController.signal)
    }

    // HTTP 错误只按状态分类；上游错误体可能回显请求和凭据，不进入诊断。
    if (!response.ok) {
      // Release the response without reading or retaining its untrusted body.
      void response.body?.cancel().catch(() => {})
      throw classifyHttpError(response)
    }
    if (response.body === null) {
      throw new DeskLlmError('protocol', `LLM response HTTP ${response.status} has no body.`)
    }

    try {
      return await consumeEventStream(response.body)
    } catch (error) {
      if (error instanceof DeskLlmError) throw error
      // 流读取中途的取消/超时：reader.read() 会以 AbortError 拒绝。
      if (signal?.aborted) throw new DeskLlmError('aborted', 'Desk LLM call aborted by caller.', { cause: error })
      if (timeoutController.signal.aborted) {
        throw new DeskLlmError('timeout', `Desk LLM call timed out after ${timeoutMs} ms.`, { cause: error })
      }
      throw new DeskLlmError('network', `Desk LLM stream read failed: ${errorMessage(error)}`, { cause: error })
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ── private: request ───────────────────────────────────────────────────────────────

interface ChatRequest {
  model: string
  messages: readonly Record<string, unknown>[]
  tools?: readonly Record<string, unknown>[]
  temperature?: number
  max_tokens?: number
  stream: true
}

function buildRequest(config: DeskLlmConfig, history: readonly DeskMessage[], tools: readonly LlmToolSchema[]): ChatRequest {
  const request: ChatRequest = {
    model: config.model,
    messages: history.map(toChatMessage),
    stream: true,
  }
  if (tools.length > 0) {
    request.tools = tools.map(tool => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
  }
  if (config.temperature !== undefined) request.temperature = config.temperature
  if (config.maxTokens !== undefined) request.max_tokens = config.maxTokens
  return request
}

/** DeskMessage 行 → OpenAI chat message（对应 ordin toRequestMessage 的四种 role）。 */
function toChatMessage(msg: DeskMessage): Record<string, unknown> {
  switch (msg.role) {
    case 'system':
    case 'user':
      return { role: msg.role, content: msg.content }
    case 'assistant': {
      const out: Record<string, unknown> = { role: 'assistant', content: msg.content }
      if (msg.tool_calls !== undefined && msg.tool_calls.length > 0) {
        out.tool_calls = msg.tool_calls.map(call => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }))
      }
      return out
    }
    case 'tool':
      // OpenAI tool 消息只认 role/content/tool_call_id；name 字段不合法，不带。
      return { role: 'tool', content: msg.content, tool_call_id: msg.tool_call_id ?? '' }
  }
}

// ── private: SSE ───────────────────────────────────────────────────────────────────

interface ToolCallAccumulator {
  index: number
  id: string
  name: string
  arguments: string
}

/** 消费整个 SSE body，返回完整 assistant turn。 */
async function consumeEventStream(body: ReadableStream<Uint8Array>): Promise<DeskLlmResponse> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines: string[] = []
  let text = ''
  const calls = new Map<number, ToolCallAccumulator>()
  let finishReason: string | undefined
  let sawDone = false

  const handleEvent = (): void => {
    const payload = dataLines.join('\n')
    dataLines = []
    if (payload === '') return
    if (payload === '[DONE]') { sawDone = true; return }
    let chunk: unknown
    try {
      chunk = JSON.parse(payload)
    } catch (error) {
      throw new DeskLlmError('protocol', `LLM stream sent invalid JSON: ${payload.slice(0, 200)}`, { cause: error })
    }
    handleChunk(chunk, {
      appendText: delta => { text += delta },
      pushToolCall: delta => {
        const acc = calls.get(delta.index) ?? { index: delta.index, id: '', name: '', arguments: '' }
        if (delta.id !== undefined) acc.id = delta.id
        if (delta.name !== undefined) acc.name = delta.name
        if (delta.arguments !== undefined) acc.arguments += delta.arguments
        calls.set(delta.index, acc)
      },
      setFinish: reason => { finishReason = reason },
    })
  }

  const handleLine = (rawLine: string): void => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') { handleEvent(); return } // 空行 = 事件边界
    if (line.startsWith(':')) return            // SSE 注释 / keep-alive
    if (line.startsWith('data:')) {
      dataLines.push(line.startsWith('data: ') ? line.slice(6) : line.slice(5))
    }
    // event:/id:/retry:/未知字段按 SSE 规范忽略（宽容解析，纪律 3.3）。
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
      }
    }
    buffer += decoder.decode() // flush
    if (buffer !== '') handleLine(buffer)
    handleEvent()              // 流尾若没有结尾空行，仍派发最后一个事件
  } finally {
    reader.releaseLock()
  }

  const toolCalls: DeskToolCall[] = [...calls.values()]
    .sort((a, b) => a.index - b.index)
    .map(acc => ({ id: acc.id, name: acc.name, arguments: acc.arguments }))

  let finalReason = finishReason
  if (finalReason === undefined) {
    if (!sawDone) finalReason = 'incomplete' // 截断流：不谎称 stop（A7 失败必须可见）
    else finalReason = toolCalls.length > 0 ? 'tool_calls' : 'stop'
  }
  return { text: text.trim(), toolCalls, finishReason: finalReason }
}

interface ChunkSink {
  appendText: (delta: string) => void
  pushToolCall: (delta: { index: number; id?: string; name?: string; arguments?: string }) => void
  setFinish: (reason: string) => void
}

/** 解析一个 OpenAI chunk；不认识的结构跳过，不把垃圾当内容。 */
function handleChunk(chunk: unknown, sink: ChunkSink): void {
  if (typeof chunk !== 'object' || chunk === null) return
  const choices = (chunk as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return // usage-only / 心跳 chunk
  for (const choice of choices) {
    if (typeof choice !== 'object' || choice === null) continue
    const { delta, finish_reason: finishReason } = choice as {
      delta?: unknown
      finish_reason?: unknown
    }
    if (typeof finishReason === 'string' && finishReason !== '') sink.setFinish(finishReason)
    if (typeof delta !== 'object' || delta === null) continue
    const { content, tool_calls: toolCalls } = delta as { content?: unknown; tool_calls?: unknown }
    if (typeof content === 'string') sink.appendText(content)
    if (!Array.isArray(toolCalls)) continue
    for (const call of toolCalls) {
      if (typeof call !== 'object' || call === null) continue
      const { index, id, function: fn } = call as { index?: unknown; id?: unknown; function?: unknown }
      const idx = typeof index === 'number' && Number.isInteger(index) ? index : 0
      const fnObj = (typeof fn === 'object' && fn !== null ? fn : {}) as { name?: unknown; arguments?: unknown }
      sink.pushToolCall({
        index: idx,
        ...(typeof id === 'string' ? { id } : {}),
        ...(typeof fnObj.name === 'string' ? { name: fnObj.name } : {}),
        ...(typeof fnObj.arguments === 'string' ? { arguments: fnObj.arguments } : {}),
      })
    }
  }
}

// ── private: errors ────────────────────────────────────────────────────────────────

function translateFetchError(error: unknown, caller: AbortSignal | undefined, timeout: AbortSignal): DeskLlmError {
  if (caller?.aborted) return new DeskLlmError('aborted', 'Desk LLM call aborted by caller.', { cause: error })
  if (timeout.aborted) return new DeskLlmError('timeout', 'Desk LLM call timed out.', { cause: error })
  return new DeskLlmError('network', `Desk LLM request failed: ${errorMessage(error)}`, { cause: error })
}

/** 非 2xx → 分类错误。穷举段 + 兜底大声，不静默归类（A4）。 */
function classifyHttpError(response: Response): DeskLlmError {
  const status = response.status
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
  const base = { status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }
  if (status === 401 || status === 403) {
    return new DeskLlmError('auth', `LLM authentication failed (HTTP ${status})`, base)
  }
  if (status === 429) {
    return new DeskLlmError('rate_limit', `LLM rate limited (HTTP 429)`, base)
  }
  if (status >= 500 && status <= 599) {
    return new DeskLlmError('server', `LLM server error (HTTP ${status})`, base)
  }
  return new DeskLlmError('http', `LLM request rejected (HTTP ${status})`, base)
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined
  const seconds = Number(header)
  if (!Number.isFinite(seconds) || seconds < 0) return undefined // HTTP-date 形式暂不解析
  return Math.round(seconds * 1000)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
