/**
 * DshDriver: DSH headless CLI as an external WorkerDriver.
 *
 * 事实来源：P0 docs/p0/dsh.md 与 agent-autoloop plugins/dsh/agent.ts。
 * 终局必须同时满足进程正常退出与 final.reason.kind=completed；缺 final、
 * final error、空文本、取消都不得报完成。解析宽容（未知行跳过），终局严格。
 */
import { existsSync } from 'node:fs'
import { ProcessRegistry } from '../app/process.ts'
import { parseWorkerReport } from './report.ts'
import { TurnChannel } from './channel.ts'
import {
  failedResult,
  type AccessMode,
  type BackendSession,
  type DriverError,
  type DriverHealth,
  type LaunchSpec,
  type RunningTurn,
  type TurnResult,
  type Usage,
  type WorkerDriver,
  type WorkerEvent,
  type WorkerSpec,
} from './types.ts'

export interface DshDriverOptions {
  readonly binary?: string
  readonly dshHome?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

const PRESET: Record<AccessMode, string> = {
  read: 'read-only', edit: 'workspace-write', full: 'danger-full-access',
}

export class DshDriver implements WorkerDriver {
  readonly backend = 'dsh' as const
  private sequence = 0

  constructor(private readonly proc: ProcessRegistry, private readonly options: DshDriverOptions = {}) {}

  async probe(): Promise<DriverHealth> {
    const checkedAt = new Date().toISOString()
    const binary = this.options.binary ?? process.env.ORDIN_DSH_BIN ?? 'dsh'
    const versionRun = this.proc.spawn({ owner: 'driver-probe:dsh', argv: [binary, '--version'], env: this.options.env, timeoutMs: 15_000, stdoutLimit: 4096, stderrLimit: 4096 })
    const versionOutcome = await this.proc.wait(versionRun.id)
    const warnings: string[] = []
    const version = versionRun.stdout.trim()
    if (versionOutcome.status !== 'exited' || versionOutcome.exitCode !== 0 || version === '') {
      warnings.push(`dsh --version unavailable (diagnostic only): exit=${String(versionOutcome.exitCode)} ${versionRun.stderr.trim() || versionRun.error || ''}`)
    }
    const capabilities = await this.headlessCapabilities(binary)
    warnings.push(...capabilities.warnings)
    const auth = (this.options.env?.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY) ? 'ok' : 'unknown'
    if (auth === 'unknown') warnings.push('DEEPSEEK_API_KEY not visible to probe; headless auth is only proven by a real run')
    return { backend: this.backend, ok: capabilities.problems.length === 0, checkedAt, binary, ...(version === '' ? {} : { version }), auth, problems: capabilities.problems, warnings }
  }

  private async headlessCapabilities(binary: string, env?: Readonly<Record<string, string>>, cwd?: string) {
    const helpRun = this.proc.spawn({
      owner: 'driver-probe:dsh', argv: [binary, 'headless', '--help'], cwd,
      env: { ...this.options.env, ...env, ...(this.options.dshHome === undefined ? {} : { DSH_HOME: this.options.dshHome }) },
      timeoutMs: 15_000, stdoutLimit: 16_384, stderrLimit: 16_384,
    })
    const outcome = await this.proc.wait(helpRun.id)
    const help = `${helpRun.stdout}\n${helpRun.stderr}`
    const flags = new Set(help.match(/--[a-z][a-z0-9-]*/g) ?? [])
    const problems: string[] = []
    const warnings: string[] = []
    if (outcome.status !== 'exited' || outcome.exitCode !== 0 || helpRun.error !== null) {
      problems.push(`dsh headless --help failed: exit=${String(outcome.exitCode)} ${helpRun.error || helpRun.stderr.trim()}`)
    }
    if (!flags.has('--json') || !flags.has('--session-id')) {
      problems.push('dsh headless protocol not recognized: require --json and --session-id')
    }
    if (!flags.has('--permission-mode')) warnings.push('degraded_capability: missing --permission-mode; read/edit sandbox cannot be enforced, full uses backend configuration')
    if (!flags.has('--approval-policy')) warnings.push('degraded_capability: missing --approval-policy; approval behavior uses backend configuration')
    if (!flags.has('--model')) warnings.push('degraded_capability: missing --model; explicit model selection unavailable')
    return { flags, problems, warnings }
  }

  async prepare(spec: WorkerSpec): Promise<LaunchSpec> {
    if (spec.cwd.trim() === '') throw new Error('DSH worker cwd is empty')
    if (spec.prompt.trim() === '') throw new Error('DSH worker prompt is empty')
    if (!existsSync(spec.cwd)) throw new Error(`DSH worker cwd does not exist: ${spec.cwd}`)
    return { ...spec, preparedAt: new Date().toISOString() }
  }

  async launch(spec: LaunchSpec): Promise<RunningTurn> {
    return await this.start(spec)
  }

  async resume(session: BackendSession, spec: LaunchSpec): Promise<RunningTurn> {
    if (session.backend !== 'dsh') throw new Error(`Cannot resume a ${session.backend} session with DshDriver`)
    return await this.start(spec, session)
  }

  private async start(spec: LaunchSpec, resume?: BackendSession): Promise<RunningTurn> {
    const id = `dsh-turn-${++this.sequence}`
    const channel = new TurnChannel()
    const binary = this.options.binary ?? process.env.ORDIN_DSH_BIN ?? 'dsh'
    const capabilities = await this.headlessCapabilities(binary, spec.env, spec.cwd)
    if (capabilities.problems.length > 0) throw new Error(capabilities.problems.join('; '))
    if (!capabilities.flags.has('--permission-mode') && spec.access !== 'full') {
      throw new Error(`degraded_capability: cannot enforce DSH ${spec.access} access without --permission-mode`)
    }
    const argv = [binary, 'headless', '--json']
    if (capabilities.flags.has('--permission-mode')) argv.push('--permission-mode', PRESET[spec.access])
    if (capabilities.flags.has('--approval-policy')) argv.push('--approval-policy', 'never')
    if (spec.model !== undefined && spec.model.trim() !== '') {
      if (!capabilities.flags.has('--model')) throw new Error('degraded_capability: DSH does not support --model')
      argv.push('--model', spec.model)
    }
    if (resume !== undefined) argv.push('--session-id', resume.id)
    argv.push(spec.prompt)

    let session: BackendSession | undefined = resume
    let finalEvent: { text?: unknown; reason?: { kind?: string; error?: { code?: string; message?: string } } | null } | undefined
    let turnEndReason: { kind?: string; error?: { code?: string; message?: string } } | null | undefined
    let usage: Usage | undefined
    let parseError: DriverError | undefined
    let stdoutBuffer = ''

    const parseLine = (line: string): void => {
      if (line.trim() === '') return
      let event: any
      try { event = JSON.parse(line) } catch { return } // login-shell noise and non-JSON output are tolerated
      if (!event || typeof event !== 'object') return
      const at = new Date().toISOString()
      if (event.type === 'session' && typeof event.sessionId === 'string') {
        session = { backend: 'dsh', id: event.sessionId, cwd: typeof event.cwd === 'string' ? event.cwd : spec.cwd, savedAt: at }
      } else if (event.type === 'status' && event.phase === 'turn_end') {
        turnEndReason = event.reason
      } else if (event.type === 'status' && event.phase === 'step_end') {
        usage = addUsage(usage, stepUsage(event.usage))
        if (usage !== undefined) channel.push({ kind: 'usage', at, usage })
      } else if (event.type === 'error') {
        const message = typeof event.message === 'string' ? event.message : 'DSH reported an error'
        channel.push({ kind: 'error', at, error: { code: mapErrorCode(message, event.code), message, retryable: false } })
      } else if (event.type === 'final') {
        finalEvent = event
      }
    }

    const rec = this.proc.spawn({
      owner: spec.ticketId,
      groupId: spec.assignmentId,
      argv,
      cwd: spec.cwd,
      env: {
        ...this.options.env,
        ...spec.env,
        ...(this.options.dshHome === undefined ? {} : { DSH_HOME: this.options.dshHome }),
      },
      timeoutMs: this.options.timeoutMs,
      onStdout: text => {
        stdoutBuffer += text
        let newline: number
        while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
          parseLine(stdoutBuffer.slice(0, newline))
          stdoutBuffer = stdoutBuffer.slice(newline + 1)
        }
      },
    })
    channel.push({ kind: 'started', at: new Date().toISOString(), pid: rec.pid ?? undefined, session })

    const done = (async (): Promise<TurnResult> => {
      const outcome = await this.proc.wait(rec.id)
      if (stdoutBuffer !== '') parseLine(stdoutBuffer)
      let result: TurnResult
      if (outcome.status === 'canceled' || outcome.status === 'stopped') {
        result = failedResult('cancelled', 'DSH turn was cancelled', false, session)
      } else if (outcome.status === 'timedout') {
        result = failedResult('timeout', 'DSH turn exceeded its time limit', true, session)
      } else if (finalEvent === undefined) {
        result = failedResult('protocol_error', `DSH exited without a final event (exit=${String(outcome.exitCode)}): ${tail(rec.stderr || rec.stdout)}`, false, session)
      } else {
        const reason = finalEvent.reason ?? turnEndReason
        const kind = reason?.kind
        if (kind === 'completed' && outcome.exitCode === 0 && outcome.status === 'exited') {
          const text = typeof finalEvent.text === 'string' ? finalEvent.text : ''
          if (text.trim() === '') {
            result = failedResult('protocol_error', 'DSH completed without a non-empty final text', false, session)
          } else {
            const report = parseWorkerReport(text, new Date().toISOString())
            if (report.kind === 'invalid') {
              result = failedResult('protocol_error', `worker report block invalid: ${report.error}`, false, session)
            } else {
              if (report.kind === 'valid') channel.push({ kind: 'report', at: report.report.at, report: report.report })
              channel.push({ kind: 'text', at: new Date().toISOString(), text })
              result = { status: 'completed', text, ...(session === undefined ? {} : { session }), ...(usage === undefined ? {} : { usage }) }
            }
          }
        } else {
          const message = reason?.error?.message || (kind === undefined ? 'DSH did not complete this turn' : `DSH turn ended with reason ${kind}`)
          const code = mapErrorCode(message, reason?.error?.code)
          result = failedResult(code, message, false, session)
        }
      }
      if (rec.error !== null && result.status === 'completed') {
        result = failedResult('protocol_error', `DSH output listener failed: ${rec.error}`, false, session)
      }
      channel.push({ kind: 'final', at: new Date().toISOString(), result })
      channel.close()
      return result
    })()

    return {
      id, backend: this.backend, events: channel.iterable, done,
      feed: async () => ({ status: 'queued-for-next-turn', reason: 'DSH headless runs one process per turn; the input will be sent on resume' }),
      cancel: async (reason: string) => { await this.proc.cancelGroup(spec.assignmentId) },
    }
  }
}

function stepUsage(reported: any): Usage | undefined {
  if (!reported || typeof reported !== 'object') return undefined
  const count = (value: unknown): number => typeof value === 'number' ? value : 0
  const step: { input?: number; output?: number; cached?: number } = {}
  if (typeof reported.inputTokens === 'number') step.input = reported.inputTokens + count(reported.cacheReadTokens) + count(reported.cacheWriteTokens)
  if (typeof reported.outputTokens === 'number') step.output = reported.outputTokens
  if (typeof reported.cacheReadTokens === 'number') step.cached = reported.cacheReadTokens
  return Object.keys(step).length > 0 ? step : undefined
}

function addUsage(left: Usage | undefined, right: Usage | undefined): Usage | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return {
    input: (left.input ?? 0) + (right.input ?? 0),
    output: (left.output ?? 0) + (right.output ?? 0),
    cached: (left.cached ?? 0) + (right.cached ?? 0),
    ...(left.costUsd !== undefined || right.costUsd !== undefined ? { costUsd: (left.costUsd ?? 0) + (right.costUsd ?? 0) } : {}),
  }
}

function mapErrorCode(message: string, code?: string): DriverError['code'] {
  const value = `${code ?? ''} ${message}`.toLowerCase()
  if (value.includes('missing_credential') || value.includes('not logged in')) return 'missing_credential'
  if (value.includes('token_expired') || value.includes('unauthorized') || value.includes('401')) return 'auth_expired'
  if (value.includes('timed out') || value.includes('timeout')) return 'timeout'
  return 'backend_error'
}

function tail(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= 500 ? trimmed : trimmed.slice(-500)
}
