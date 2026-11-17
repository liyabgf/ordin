/**
 * CodexDriver: codex exec / exec resume as an external WorkerDriver.
 * 事件事实：thread.started → turn.started → item.* → turn.completed/turn.failed。
 * 只有 turn.completed 才算完成；error 事件可能是可恢复重连，不能提前判死。
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

export interface CodexDriverOptions {
  readonly binary?: string
  readonly codexHome?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

const SANDBOX: Record<AccessMode, string> = {
  read: 'read-only', edit: 'workspace-write', full: 'danger-full-access',
}

export class CodexDriver implements WorkerDriver {
  readonly backend = 'codex' as const
  private sequence = 0

  constructor(private readonly proc: ProcessRegistry, private readonly options: CodexDriverOptions = {}) {}

  async probe(): Promise<DriverHealth> {
    const checkedAt = new Date().toISOString()
    const binary = this.options.binary ?? process.env.ORDIN_CODEX_BIN ?? 'codex'
    const versionRun = this.proc.spawn({ owner: 'driver-probe:codex', argv: [binary, '--version'], timeoutMs: 15_000, stdoutLimit: 4096, stderrLimit: 4096, env: this.options.env })
    const versionOutcome = await this.proc.wait(versionRun.id)
    if (versionOutcome.exitCode !== 0 || versionRun.stdout.trim() === '') {
      return { backend: this.backend, ok: false, checkedAt, binary, auth: 'unknown', problems: [`codex --version failed: exit=${String(versionOutcome.exitCode)} ${versionRun.stderr.trim() || versionRun.error || ''}`] }
    }
    const version = versionRun.stdout.trim()
    const loginRun = this.proc.spawn({ owner: 'driver-probe:codex', argv: [binary, 'login', 'status'], timeoutMs: 20_000, stdoutLimit: 4096, stderrLimit: 4096, env: { ...this.options.env, ...(this.options.codexHome === undefined ? {} : { CODEX_HOME: this.options.codexHome }) } })
    const loginOutcome = await this.proc.wait(loginRun.id)
    const auth = loginOutcome.exitCode === 0 ? 'ok' : 'unknown'
    const problems = auth === 'ok' ? [] : [`codex login status failed: ${loginRun.stderr.trim() || loginRun.stdout.trim() || 'unknown auth state'}`]
    return { backend: this.backend, ok: problems.length === 0, checkedAt, binary, version, auth, problems }
  }

  async prepare(spec: WorkerSpec): Promise<LaunchSpec> {
    if (spec.cwd.trim() === '') throw new Error('Codex worker cwd is empty')
    if (spec.prompt.trim() === '') throw new Error('Codex worker prompt is empty')
    if (!existsSync(spec.cwd)) throw new Error(`Codex worker cwd does not exist: ${spec.cwd}`)
    return { ...spec, preparedAt: new Date().toISOString() }
  }

  async launch(spec: LaunchSpec): Promise<RunningTurn> {
    return await this.start(spec)
  }

  async resume(session: BackendSession, spec: LaunchSpec): Promise<RunningTurn> {
    if (session.backend !== 'codex') throw new Error(`Cannot resume a ${session.backend} session with CodexDriver`)
    return await this.start(spec, session)
  }

  private async start(spec: LaunchSpec, resume?: BackendSession): Promise<RunningTurn> {
    const id = `codex-turn-${++this.sequence}`
    const channel = new TurnChannel()
    const binary = this.options.binary ?? process.env.ORDIN_CODEX_BIN ?? 'codex'
    const argv = [binary, 'exec']
    if (resume !== undefined) argv.push('resume')
    argv.push('--json', '--skip-git-repo-check')
    if (spec.model !== undefined && spec.model.trim() !== '') argv.push('-m', spec.model)
    if (spec.effort !== undefined && spec.effort.trim() !== '') argv.push('-c', `model_reasoning_effort="${spec.effort}"`)
    argv.push('-c', `sandbox_mode="${SANDBOX[spec.access]}"`, '-c', 'approval_policy="never"')
    if (resume !== undefined) argv.push(resume.id)
    argv.push(spec.prompt)

    let session: BackendSession | undefined = resume
    let finalText = ''
    let usage: Usage | undefined
    let completed = false
    let failed: { code: 'backend_error' | 'auth_expired' | 'missing_credential'; message: string } | undefined
    let stdoutBuffer = ''

    const parseLine = (line: string): void => {
      if (line.trim() === '') return
      let event: any
      try { event = JSON.parse(line) } catch { return }
      if (!event || typeof event !== 'object') return
      const at = new Date().toISOString()
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        session = { backend: 'codex', id: event.thread_id, cwd: spec.cwd, savedAt: at }
      } else if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        finalText = event.item.text
      } else if (event.type === 'turn.completed') {
        completed = true
        failed = undefined // reconnect/error followed by completion is not the final outcome
        const reported = event.usage ?? {}
        usage = {
          input: (reported.input_tokens ?? 0) + (reported.cached_input_tokens ?? 0),
          output: reported.output_tokens ?? 0,
          cached: reported.cached_input_tokens ?? 0,
        }
        channel.push({ kind: 'usage', at, usage })
      } else if (event.type === 'turn.failed') {
        const message = event.error?.message || 'Codex did not complete this turn'
        failed = { code: mapAuthError(message), message }
      } else if (event.type === 'error' && typeof event.message === 'string') {
        failed = { code: mapAuthError(event.message), message: event.message }
      }
    }

    const rec = this.proc.spawn({
      owner: spec.ticketId,
      groupId: spec.assignmentId,
      argv,
      cwd: spec.cwd,
      env: { ...this.options.env, ...spec.env, ...(this.options.codexHome === undefined ? {} : { CODEX_HOME: this.options.codexHome }) },
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
        result = failedResult('cancelled', 'Codex turn was cancelled', false, session)
      } else if (outcome.status === 'timedout') {
        result = failedResult('timeout', 'Codex turn exceeded its time limit', true, session)
      } else if (!completed) {
        const code = failed?.code ?? 'protocol_error'
        const message = failed?.message ?? `Codex exited without turn.completed (exit=${String(outcome.exitCode)}): ${(rec.stderr || rec.stdout).trim().slice(-500)}`
        result = failedResult(code, message, false, session)
      } else if (outcome.exitCode !== 0 || finalText.trim() === '') {
        result = failedResult('protocol_error', 'Codex completed without a non-empty final agent message or with a non-zero exit', false, session)
      } else {
        const parsed = parseWorkerReport(finalText, new Date().toISOString())
        if (parsed.kind === 'invalid') {
          result = failedResult('protocol_error', `worker report block invalid: ${parsed.error}`, false, session)
        } else {
          if (parsed.kind === 'valid') channel.push({ kind: 'report', at: parsed.report.at, report: parsed.report })
          channel.push({ kind: 'text', at: new Date().toISOString(), text: finalText })
          result = { status: 'completed', text: finalText, ...(session === undefined ? {} : { session }), ...(usage === undefined ? {} : { usage }) }
        }
      }
      channel.push({ kind: 'final', at: new Date().toISOString(), result })
      channel.close()
      return result
    })()

    return {
      id, backend: this.backend, events: channel.iterable, done,
      feed: async () => ({ status: 'queued-for-next-turn', reason: 'Codex exec cannot accept mid-turn input; the input will be sent on resume' }),
      cancel: async () => { await this.proc.cancelGroup(spec.assignmentId) },
    }
  }
}

function mapAuthError(message: string): 'backend_error' | 'auth_expired' | 'missing_credential' {
  const value = message.toLowerCase()
  if (value.includes('token_expired') || value.includes('refresh token') || value.includes('could not be refreshed') || value.includes('401') || value.includes('unauthorized')) return 'auth_expired'
  if (value.includes('not logged in') || value.includes('missing_credential')) return 'missing_credential'
  return 'backend_error'
}
