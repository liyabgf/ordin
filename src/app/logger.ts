import { format } from 'node:util'
/**
 * 独立宿主自己的 logger：插件时代 `context.logger` 的形状，去掉插件。
 *
 * 启动行写明 stateDir 与端口（迁移分析 §5 对齐 runtime.ts:1384–1398）；失败必须可见（A7），
 * 所以这里没有任何"记录后继续装没事"的通道——warn 与 error 就是给操作者看的行。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** 一行日志的去处；返回值无意义，抛错由调用方决定如何暴露。 */
export type LogSink = (line: string) => void

export interface Logger {
  debug(message: string, ...details: unknown[]): void
  info(message: string, ...details: unknown[]): void
  warn(message: string, ...details: unknown[]): void
  error(message: string, ...details: unknown[]): void
}

export interface LoggerOptions {
  readonly level?: LogLevel
  readonly sink?: LogSink
  readonly now?: () => string
}

const REDACTED = '[REDACTED]'
const SECRET_FIELD = /^(?:authorization|proxy-authorization|(?:x[-_]?)?api[-_]?key|(?:access[-_]?|refresh[-_]?|auth[-_]?|bearer[-_]?)?token|password|passwd)$/i

/** Narrow diagnostic scrub: labeled credentials, not arbitrary message content. */
function scrub(text: string): string {
  return text
    .replace(/\bBearer\s+[^\s,;"'\}\]]+/gi, 'Bearer ' + REDACTED)
    .replace(/(?<![\w-])((?:["']?)(?:authorization|proxy-authorization|(?:x[-_]?)?api[-_]?key|(?:access[-_]?|refresh[-_]?|auth[-_]?|bearer[-_]?)?token|password|passwd)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;\}\]]+)/gi,
      (_match, label: string, value: string) => label + (value.startsWith('"') ? '"' + REDACTED + '"' : value.startsWith("'") ? "'" + REDACTED + "'" : REDACTED))
}

function safeDetail(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Error) {
    const error = new Error(scrub(value.message))
    error.name = scrub(value.name)
    return error
  }
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map(item => safeDetail(item, seen))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, SECRET_FIELD.test(key) ? REDACTED : safeDetail(item, seen),
    ]))
  } finally { seen.delete(value) }
}

/** 把 details 变成一行里可读的尾部：Error 带 name，对象走 JSON，其余 String。 */
export function formatDetails(details: unknown): string {
  if (details === undefined) return ''
  if (details instanceof Error) return scrub(`${details.name}: ${details.message}`)
  if (typeof details === 'string') return scrub(details)
  if (typeof details === 'number' || typeof details === 'boolean' || details === null) return String(details)
  try { return scrub(JSON.stringify(safeDetail(details)) ?? String(details)) } catch { return '[Unformattable detail]' }
}

/** 默认去处：stderr 的 `ISO [level] message details` 行。日志不与面板输出（stdout）混流。 */
export function stderrSink(): LogSink {
  return line => { process.stderr.write(`${line}\n`) }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = ORDER[options.level ?? 'info']
  const sink = options.sink ?? stderrSink()
  const now = options.now ?? ((): string => new Date().toISOString())
  const write = (level: LogLevel, message: string, ...details: unknown[]): void => {
    if (ORDER[level] < threshold) return
    let line = message
    if (details.length > 0 && /%[sdifjoOc%]/.test(message)) {
      line = format(message, ...details.map(detail => safeDetail(detail)))
    } else if (details.length === 1) {
      const tail = formatDetails(details[0])
      if (tail !== '') line += ` ${tail}`
    } else if (details.length > 1) {
      // The ported runtime uses printf-style placeholders; format them rather than dropping the values.
      line = format(message, ...details.map(detail => safeDetail(detail)))
    }
    sink(`${now()} [${level}] ${scrub(line)}`)
  }
  return {
    debug: (message, ...details) => write('debug', message, ...details),
    info: (message, ...details) => write('info', message, ...details),
    warn: (message, ...details) => write('warn', message, ...details),
    error: (message, ...details) => write('error', message, ...details),
  }
}

/** 测试与静默场景的 logger：一行都不写。 */
export function silentLogger(): Logger {
  const noop = (): void => {}
  return { debug: noop, info: noop, warn: noop, error: noop }
}
