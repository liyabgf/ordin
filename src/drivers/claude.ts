/**
 * ClaudeDriver: claude -p --output-format stream-json as an external WorkerDriver.
 * P0 实测警示：result.subtype="success" 也可能 is_error=true；成功必须同时看
 * !is_error、subtype=success、非空 result 文本与进程正常退出。
 */
import { existsSync } from 'node:fs'
import { ProcessRegistry } from '../app/process.ts'
import { TurnChannel } from './channel.ts'
import { parseWorkerReport } from './report.ts'
import {
  failedResult,
  type AccessMode,
  type BackendSession,
  type DriverHealth,
  type LaunchSpec,
  type RunningTurn,
  type TurnResult,
  type Usage,
  type WorkerDriver,
  type WorkerSpec,
} from './types.ts'

export interface ClaudeDriverOptions {
  readonly binary?: string
  readonly configDir?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

const PERMISSION: Record<AccessMode, string> = {
  read: 'plan', edit: 'acceptEdits', full: 'bypassPermissions',
}

export class ClaudeDriver implements WorkerDriver {
  readonly backend = 'claude' as const
  private sequence = 0

  constructor(private readonly proc: ProcessRegistry, private readonly options: ClaudeDriverOptions = {}) {}

  async probe(): Promise<DriverHealth> {
    const checkedAt = new Date().toISOString()
    const binary = this.options.binary ?? process.env.ORDIN_CLAUDE_BIN ?? 'claude'
    const env = { ...this.options.env, ...(this.options.configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: this.options.configDir }) }
    const versionRun = this.proc.spawn({ owner: 'driver-probe:claude', argv: [binary, '--version'], timeoutMs: 15_000, stdoutLimit: 4096, stderrLimit: 4096, env })
    const versionOutcome = await this.proc.wait(versionRun.id)
    if (versionOutcome.exitCode !== 0 || versionRun.stdout.trim() === '') {
      return { backend: this.backend, ok: false, checkedAt, binary, auth: 'unknown', problems: [`claude --version failed: exit=${String(versionOutcome.exitCode)} ${versionRun.stderr.trim() || versionRun.error || ''}`] }
    }
    const version = versionRun.stdout.trim()
    const authRun = this.proc.spawn({ owner: 'driver-probe:claude', argv: [binary, 'auth', 'status'], timeoutMs: 20_000, stdoutLimit: 8192, stderrLimit: 4096, env })
    const authOutcome = await this.proc.wait(authRun.id)
    let loggedIn = false
    try { loggedIn = JSON.parse(authRun.stdout).loggedIn === true } catch { loggedIn = false }
    const auth = authOutcome.exitCode === 0 && loggedIn ? 'ok' : 'unknown'
    const problems = auth === 'ok' ? [] : [`claude auth status not logged in: ${authRun.stderr.trim() || authRun.stdout.trim() || 'unknown auth state'}`]
    return { backend: this.backend, ok: problems.length === 0, checkedAt, binary, version, auth, problems }
  }

  async prepare(spec: WorkerSpec): Promise<LaunchSpec> {
    if (spec.cwd.trim() === '') throw new Error('Claude worker cwd is empty')
    if (spec.prompt.trim() === '') throw new Error('Claude worker prompt is empty')
    if (!existsSync(spec.cwd)) throw new Error(`Claude worker cwd does not exist: ${spec.cwd}`)
    return { ...spec, preparedAt: new Date().toISOString() }
  }

  async launch(spec: LaunchSpec): Promise<RunningTurn> {
    return await this.start(spec)
  }

  async resume(session: BackendSession, spec: LaunchSpec): Promise<RunningTurn> {
    if (session.backend !== 'claude') throw new Error(`Cannot resume a ${session.backend} session with ClaudeDriver`)
    return await this.start(spec, session)
  }

  private async start(spec: LaunchSpec, resume?: BackendSession): Promise<RunningTurn> {
    const id = `claude-turn-${++this.sequence}`
    const channel = new TurnChannel()
    const binary = this.options.binary ?? process.env.ORDIN_CLAUDE_BIN ?? 'claude'
    const argv = [binary, '-p', spec.prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', PERMISSION[spec.access], '--add-dir', spec.cwd, '--disallowedTools=EnterWorktree,ExitWorktree']
    if (spec.model !== undefined && spec.model.trim() !== '') argv.push('--model', spec.model)
    if (spec.effort !== undefined && spec.effort.trim() !== '') argv.push('--effort', spec.effort)
    if (resume !== undefined) argv.push('--resume', resume.id)

    let session: BackendSession | undefined = resume
    let resultEvent: any
    let stdoutBuffer = ''

    const parseLine = (line: string): void => {
      if (line.trim() === '') return
      let event: any
      try { event = JSON.parse(line) } catch { return }
      if (!event || typeof event !== 'object') return
      if (typeof event.session_id === 'string') {
        session = { backend: 'claude', id: event.session_id, cwd: spec.cwd, savedAt: new Date().toISOString() }
      }
      if (event.type === 'result') resultEvent = event
    }

    const rec = this.proc.spawn({
      owner: spec.ticketId,
      groupId: spec.assignmentId,
      argv,
      cwd: spec.cwd,
      env: { ...this.options.env, ...spec.env, ...(this.options.configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: this.options.configDir }) },
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
        result = failedResult('cancelled', 'Claude turn was cancelled', false, session)
      } else if (outcome.status === 'timedout') {
        result = failedResult('timeout', 'Claude turn exceeded its time limit', true, session)
      } else if (resultEvent === undefined) {
        result = failedResult('protocol_error', `Claude exited without a result event (exit=${String(outcome.exitCode)}): ${(rec.stderr || rec.stdout).trim().slice(-500)}`, false, session)
      } else {
        const text = typeof resultEvent.result === 'string' ? resultEvent.result : ''
        const success = resultEvent.subtype === 'success' && resultEvent.is_error !== true && outcome.exitCode === 0 && outcome.status === 'exited' && text.trim() !== ''
        if (!success) {
          if (resultEvent.subtype === 'success' && resultEvent.is_error !== true && outcome.exitCode === 0 && outcome.status === 'exited') {
            result = failedResult('protocol_error', 'Claude completed without a non-empty result text', false, session)
          } else {
            const message = (typeof text === 'string' && text.trim() !== '' ? text.split('\n')[0] : undefined)
              || resultEvent.errors?.[0] || resultEvent.terminal_reason || resultEvent.subtype || 'Claude did not complete this turn'
            const code = mapClaudeError(message)
            result = failedResult(code, message, false, session)
          }
        } else {
          const usage = claudeUsage(resultEvent)
          if (usage !== undefined) channel.push({ kind: 'usage', at: new Date().toISOString(), usage })
          const parsed = parseWorkerReport(text, new Date().toISOString())
          if (parsed.kind === 'invalid') {
            result = failedResult('protocol_error', `worker report block invalid: ${parsed.error}`, false, session)
          } else {
            if (parsed.kind === 'valid') channel.push({ kind: 'report', at: parsed.report.at, report: parsed.report })
            channel.push({ kind: 'text', at: new Date().toISOString(), text })
            result = { status: 'completed', text, ...(session === undefined ? {} : { session }), ...(usage === undefined ? {} : { usage }) }
          }
        }
      }
      channel.push({ kind: 'final', at: new Date().toISOString(), result })
      channel.close()
      return result
    })()

    return {
      id, backend: this.backend, events: channel.iterable, done,
      feed: async () => ({ status: 'queued-for-next-turn', reason: 'Claude -p in this driver uses one process per turn; the input will be sent on resume' }),
      cancel: async () => { await this.proc.cancelGroup(spec.assignmentId) },
    }
  }
}

function claudeUsage(event: any): Usage | undefined {
  if (!event.usage && event.total_cost_usd === undefined) return undefined
  const usage = event.usage ?? {}
  return {
    input: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    output: usage.output_tokens ?? 0,
    cached: usage.cache_read_input_tokens ?? 0,
    ...(typeof event.total_cost_usd === 'number' ? { costUsd: event.total_cost_usd } : {}),
  }
}

function mapClaudeError(message: string): 'auth_expired' | 'missing_credential' | 'backend_error' {
  const value = message.toLowerCase()
  if (value.includes('not logged in') || value.includes('missing_credential')) return 'missing_credential'
  if (value.includes('token_expired') || value.includes('401') || value.includes('authentication')) return 'auth_expired'
  return 'backend_error'
}
