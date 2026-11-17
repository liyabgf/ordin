/**
 * WorkerDriver SPI — P2-T4 冻结契约。
 *
 * 执行后端是外部进程，不是 Ordin 内部的 Session。域层只认识这里的类型，
 * 不认识 codex/claude/dsh 各自的 JSON、命令行或会话文件。
 */
import type { Report } from '../core/model.ts'

export type BackendKind = 'dsh' | 'codex' | 'claude'
export type AccessMode = 'read' | 'edit' | 'full'

export interface BackendSession {
  readonly backend: BackendKind
  readonly id: string
  readonly cwd: string
  readonly savedAt: string
}

export interface DriverHealth {
  readonly backend: BackendKind
  readonly ok: boolean
  readonly checkedAt: string
  readonly version?: string
  readonly binary?: string
  readonly auth: 'ok' | 'missing' | 'expired' | 'unknown'
  readonly problems: readonly string[]
  readonly warnings?: readonly string[]
}

export interface WorkerSpec {
  readonly ticketId: string
  readonly assignmentId: string
  /** Backend fixed for this Ticket before launch; a saved session still owns resumes. */
  readonly backend?: BackendKind
  readonly cwd: string
  readonly prompt: string
  readonly model?: string
  readonly effort?: string
  readonly access: AccessMode
  readonly env?: Readonly<Record<string, string>>
  readonly skills?: readonly string[]
  /** Per-ticket MCP config, when L2 is enabled. */
  readonly mcpReport?: Readonly<Record<string, unknown>>
}

export interface LaunchSpec extends WorkerSpec {
  readonly preparedAt: string
}

export type DriverErrorCode =
  | 'missing_credential' | 'auth_expired' | 'version_mismatch' | 'spawn_failed'
  | 'timeout' | 'cancelled' | 'protocol_error' | 'backend_error' | 'budget_exceeded'

export interface DriverError {
  readonly code: DriverErrorCode
  readonly message: string
  readonly retryable: boolean
  readonly cause?: unknown
}

/** Cumulative snapshot for one turn; consumers should retain per-metric high-water values. */
export interface Usage {
  readonly input?: number
  readonly output?: number
  readonly cached?: number
  readonly costUsd?: number
}

export type WorkerEvent =
  | { readonly kind: 'started'; readonly at: string; readonly session?: BackendSession; readonly pid?: number }
  | { readonly kind: 'text'; readonly at: string; readonly text: string }
  | { readonly kind: 'tool'; readonly at: string; readonly name: string; readonly detail?: unknown }
  | { readonly kind: 'usage'; readonly at: string; readonly usage: Usage }
  | { readonly kind: 'report'; readonly at: string; readonly report: Report }
  | { readonly kind: 'final'; readonly at: string; readonly result: TurnResult }
  | { readonly kind: 'error'; readonly at: string; readonly error: DriverError }

export interface TurnResult {
  readonly status: 'completed' | 'failed' | 'cancelled'
  readonly text: string
  readonly session?: BackendSession
  readonly usage?: Usage
  readonly error?: DriverError
}

export type FeedResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'queued-for-next-turn'; readonly reason: string }
  | { readonly status: 'closed'; readonly reason: string }

export interface RunningTurn {
  readonly id: string
  readonly backend: BackendKind
  readonly events: AsyncIterable<WorkerEvent>
  readonly done: Promise<TurnResult>
  feed(input: string): Promise<FeedResult>
  cancel(reason: string): Promise<void>
}

export interface WorkerDriver {
  readonly backend: BackendKind
  probe(backend?: BackendKind): Promise<DriverHealth>
  /** On resume, preparation must use the session owner rather than the current default backend. */
  prepare(spec: WorkerSpec, session?: BackendSession): Promise<LaunchSpec>
  launch(spec: LaunchSpec): Promise<RunningTurn>
  resume(session: BackendSession, spec: LaunchSpec): Promise<RunningTurn>
}

/** 统一失败结果，防止驱动把“进程结束”误报为“任务完成”。 */
export function failedResult(code: DriverErrorCode, message: string, retryable = false, session?: BackendSession): TurnResult {
  return { status: code === 'cancelled' ? 'cancelled' : 'failed', text: '', ...(session === undefined ? {} : { session }), error: { code, message, retryable } }
}
