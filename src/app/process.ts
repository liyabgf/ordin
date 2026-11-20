/**
 * The process registry: every external process Ordin starts is booked here —
 * who started it (owner), its OS pid, when it started, how it ended, and the
 * bounded output it produced. Nothing Ordin runs is an anonymous nohup: each
 * child gets an id, the numeric exit code is captured whenever the OS reports
 * one, and killing always targets the child's whole process group (SIGTERM,
 * a grace window, then SIGKILL) so grandchildren cannot be orphaned.
 *
 * Failures are made visible on the record instead of thrown: a binary that
 * does not spawn is status 'failed' with the error text, a canceled run is
 * 'canceled', a run killed past its timeoutMs is 'timedout', stopAll marks
 * 'stopped'. wait() never rejects — the outcome is read from the record.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export type ProcessStatus = 'running' | 'exited' | 'failed' | 'canceled' | 'timedout' | 'stopped'

export interface SpawnSpec {
  /** Who this process belongs to — a Ticket id, a driver name. list() filters by it. */
  readonly owner: string
  /** argv[0] is the executable; the rest are its arguments. Never shell-joined. */
  readonly argv: readonly string[]
  readonly cwd?: string
  /** Merged over the inherited environment; an undefined value deletes that variable. */
  readonly env?: Record<string, string | undefined>
  /** Written to the child's stdin, which is then closed. */
  readonly stdin?: string
  /** When this fires, the run is killed exactly like cancel(). */
  readonly signal?: AbortSignal
  /** Registry-level grouping for cancelGroup(); defaults to the process's own id. */
  readonly groupId?: string
  /** Milliseconds between SIGTERM and SIGKILL when killing. Default 3000. */
  readonly graceMs?: number
  /** When set, a run still alive this long is killed and marked 'timedout'. */
  readonly timeoutMs?: number
  /** Byte cap for captured stdout; beyond it output is discarded, never buffered. Default 1 MiB. */
  readonly stdoutLimit?: number
  /** Byte cap for captured stderr. Default 1 MiB. */
  readonly stderrLimit?: number
  /** Decoded stdout chunks as they arrive; a throwing callback is reported on the record, never thrown. */
  readonly onStdout?: (text: string) => void
  /** Decoded stderr chunks as they arrive; same reporting rule as onStdout. */
  readonly onStderr?: (text: string) => void
}

export interface ProcessRecord {
  readonly id: string
  /** null only when the process never started (aborted before spawn). */
  pid: number | null
  readonly owner: string
  readonly groupId: string
  readonly startedAt: number
  status: ProcessStatus
  /** The numeric exit code whenever the OS reported one; null when a signal ended it or it never ran. */
  exitCode: number | null
  exitSignal: NodeJS.Signals | null
  endedAt: number | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  /** Spawn/kill failure text, when there was one. */
  error: string | null
}

export interface WaitResult {
  readonly id: string
  readonly exitCode: number | null
  readonly exitSignal: NodeJS.Signals | null
  readonly status: ProcessStatus
}

const DEFAULT_GRACE_MS = 3000
const DEFAULT_OUTPUT_LIMIT = 1024 * 1024
const SETTLED_HISTORY_LIMIT = 64
const SETTLED_OUTPUT_LIMIT = 8 * 1024 * 1024

type Outcome = Omit<WaitResult, 'id'>

interface Entry {
  readonly rec: ProcessRecord
  child: ChildProcess | null
  readonly graceMs: number
  readonly stdoutLimit: number
  readonly stderrLimit: number
  readonly stdoutDecoder: StringDecoder
  readonly stderrDecoder: StringDecoder
  /** Capture-only decoders: decode the bounded bytes while the protocol decoders see the full stream (B1). */
  readonly stdoutCapDecoder: StringDecoder
  readonly stderrCapDecoder: StringDecoder
  readonly onStdout?: (text: string) => void
  readonly onStderr?: (text: string) => void
  stdoutBytes: number
  stderrBytes: number
  cancelRequested: boolean
  stopRequested: boolean
  timeoutHit: boolean
  spawnError: string | null
  settled: boolean
  closeOutcome: Outcome | null
  killTimer: NodeJS.Timeout | null
  timeoutTimer: NodeJS.Timeout | null
  dropAbortListener: (() => void) | null
  readonly done: Promise<WaitResult>
  readonly resolve: (r: WaitResult) => void
}

export class ProcessRegistry {
  private seq = 0
  private readonly entries = new Map<string, Entry>()
  private readonly history = new Map<string, { rec: ProcessRecord; outcome: WaitResult; bytes: number }>()
  private historyBytes = 0

  /**
   * Start a process and book it. The record is returned immediately and
   * mutated in place as output arrives and the run ends; wait() resolves
   * once the child's stdio is closed and any pending group escalation is done.
   */
  spawn(spec: SpawnSpec): ProcessRecord {
    const id = `proc-${++this.seq}`
    const rec: ProcessRecord = {
      id,
      pid: null,
      owner: spec.owner,
      groupId: spec.groupId ?? id,
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
      exitSignal: null,
      endedAt: null,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      error: null,
    }
    let resolve!: (r: WaitResult) => void
    const done = new Promise<WaitResult>((r) => {
      resolve = r
    })
    const entry: Entry = {
      rec,
      child: null,
      graceMs: spec.graceMs ?? DEFAULT_GRACE_MS,
      stdoutLimit: spec.stdoutLimit ?? DEFAULT_OUTPUT_LIMIT,
      stderrLimit: spec.stderrLimit ?? DEFAULT_OUTPUT_LIMIT,
      stdoutDecoder: new StringDecoder('utf8'),
      stderrDecoder: new StringDecoder('utf8'),
      stdoutCapDecoder: new StringDecoder('utf8'),
      stderrCapDecoder: new StringDecoder('utf8'),
      onStdout: spec.onStdout,
      onStderr: spec.onStderr,
      stdoutBytes: 0,
      stderrBytes: 0,
      cancelRequested: false,
      stopRequested: false,
      timeoutHit: false,
      spawnError: null,
      settled: false,
      closeOutcome: null,
      killTimer: null,
      timeoutTimer: null,
      dropAbortListener: null,
      done,
      resolve,
    }
    this.entries.set(id, entry)

    const fail = (message: string): ProcessRecord => {
      entry.spawnError = message
      queueMicrotask(() => this.settle(entry, { status: 'failed', exitCode: null, exitSignal: null }))
      return rec
    }

    const [cmd, ...args] = spec.argv
    if (!cmd) return fail('spawn spec argv must not be empty')

    if (spec.signal?.aborted) {
      entry.cancelRequested = true
      queueMicrotask(() => this.settle(entry, { status: 'canceled', exitCode: null, exitSignal: null }))
      return rec
    }

    let child: ChildProcess
    try {
      child = nodeSpawn(cmd, args, {
        cwd: spec.cwd,
        env: buildEnv(spec.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group so kills can reach every descendant at once.
        detached: process.platform !== 'win32',
      })
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
    entry.child = child
    rec.pid = child.pid ?? null

    child.stdout?.on('data', (chunk: Buffer) => this.append(entry, 'stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => this.append(entry, 'stderr', chunk))
    // Stream errors (and an EPIPE stdin when the child exits first) are
    // surfaced through the exit outcome, never thrown past this registry.
    child.stdout?.on('error', () => {})
    child.stderr?.on('error', () => {})
    child.stdin?.on('error', () => {})
    try {
      if (spec.stdin !== undefined) child.stdin?.write(spec.stdin)
      child.stdin?.end()
    } catch {
      // A stdin that cannot be written shows up in the exit outcome.
    }

    child.on('error', (err: Error) => {
      entry.spawnError = err.message
      // A process we failed to signal may still be alive: make sure it is not.
      this.signalGroup(entry, 'SIGKILL')
      this.settle(entry, { status: 'failed', exitCode: null, exitSignal: null })
    })
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (entry.settled) return
      this.finishOutput(entry)
      const status: ProcessStatus =
        entry.spawnError !== null
          ? 'failed'
          : entry.timeoutHit
            ? 'timedout'
            : entry.stopRequested
              ? 'stopped'
              : entry.cancelRequested
                ? 'canceled'
                : 'exited'
      const outcome = { status, exitCode: code, exitSignal: signal }
      if (entry.killTimer !== null && this.groupMayExist(entry)) {
        // Closing the leader's stdio does not mean the rest of the group is gone.
        entry.closeOutcome = outcome
        this.stopWatching(entry)
      } else {
        this.settle(entry, outcome)
      }
    })

    if (spec.signal) {
      const signal = spec.signal
      const onAbort = (): void => {
        entry.cancelRequested = true
        this.beginKill(entry, entry.graceMs)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      entry.dropAbortListener = () => signal.removeEventListener('abort', onAbort)
    }

    if (spec.timeoutMs !== undefined && Number.isFinite(spec.timeoutMs)) {
      entry.timeoutTimer = setTimeout(() => {
        entry.timeoutTimer = null
        if (!entry.settled && entry.rec.status === 'running') {
          entry.timeoutHit = true
          this.beginKill(entry, entry.graceMs)
        }
      }, Math.max(0, spec.timeoutMs))
      entry.timeoutTimer.unref()
    }

    return rec
  }

  get(id: string): ProcessRecord | undefined {
    return this.entries.get(id)?.rec ?? this.history.get(id)?.rec
  }

  /** Unsettled processes and recent settled history, optionally for one owner. */
  list(owner?: string): ProcessRecord[] {
    const all = [...this.history.values(), ...this.entries.values()].map((e) => e.rec)
    return owner === undefined ? all : all.filter((r) => r.owner === owner)
  }

  /**
   * Resolves with the final outcome — including the numeric exit code when
   * the OS reported one — and never rejects. Unknown or evicted ids resolve 'failed'.
   */
  wait(id: string): Promise<WaitResult> {
    const entry = this.entries.get(id)
    return entry?.done ?? Promise.resolve(this.history.get(id)?.outcome ?? { id, exitCode: null, exitSignal: null, status: 'failed' })
  }

  /** SIGTERM the process group, then SIGKILL after the grace window. Resolves when dead. */
  async cancel(id: string, graceMs?: number): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    if (!entry.settled && entry.rec.status === 'running') {
      entry.cancelRequested = true
      this.beginKill(entry, graceMs ?? entry.graceMs)
    }
    await entry.done
  }

  /** cancel() for every running process booked under one registry group id. */
  async cancelGroup(groupId: string, graceMs?: number): Promise<void> {
    const targets = [...this.entries.values()].filter(
      (e) => e.rec.groupId === groupId && !e.settled && e.rec.status === 'running',
    )
    for (const e of targets) {
      e.cancelRequested = true
      this.beginKill(e, graceMs ?? e.graceMs)
    }
    await Promise.all(targets.map((e) => e.done))
  }

  /** Kill everything still running. Resolves when no child of this registry is alive. */
  async stopAll(graceMs?: number): Promise<void> {
    const running = [...this.entries.values()].filter((e) => !e.settled && e.rec.status === 'running')
    for (const e of running) {
      e.stopRequested = true
      this.beginKill(e, graceMs ?? e.graceMs)
    }
    await Promise.all(running.map((e) => e.done))
  }

  /** SIGTERM the group now, arm a single SIGKILL for after the grace window. */
  private beginKill(entry: Entry, graceMs: number): void {
    if (entry.settled || entry.killTimer !== null) return
    entry.killTimer = setTimeout(() => {
      entry.killTimer = null
      this.signalGroup(entry, 'SIGKILL')
      if (entry.closeOutcome !== null) this.settle(entry, entry.closeOutcome)
    }, Math.max(0, graceMs))
    // Keep the timer referenced: after close it may be the only handle keeping escalation alive.
    this.signalGroup(entry, 'SIGTERM')
  }

  private groupMayExist(entry: Entry): boolean {
    if (process.platform === 'win32' || entry.rec.pid === null) return false
    try {
      process.kill(-entry.rec.pid, 0)
      return true
    } catch (error) {
      // Only ESRCH proves the group is gone; let escalation handle other failures.
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }

  /**
   * Signal the child's whole process group (the child is its leader, thanks
   * to detached spawn). ESRCH — the group already gone — is the expected
   * race and is swallowed; other signal failures are recorded.
   */
  private signalGroup(entry: Entry, signal: NodeJS.Signals): void {
    if (entry.rec.pid === null) return
    try {
      if (process.platform === 'win32') entry.child?.kill(signal)
      else process.kill(-entry.rec.pid, signal)
    } catch (error) {
      // ESRCH — the group is already gone — is the expected race and says nothing about the run (B5).
      // Anything else is a kill that did not happen, and the record must say so rather than claim it did.
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code !== 'ESRCH') {
        const message = error instanceof Error ? error.message : String(error)
        entry.rec.error = entry.rec.error === null ? 'kill failed: ' + message : entry.rec.error + '; kill failed: ' + message
      }
    }
  }

  /**
   * One byte counts twice here on purpose: the *capture* (rec.stdout/stderr) stays bounded, but the *protocol*
   * callback always receives the full decoded stream. A worker that prints more than the capture limit must not
   * lose its final report — the limit is for what we keep, not for what we parse (B1).
   */
  private append(entry: Entry, which: 'stdout' | 'stderr', chunk: Buffer): void {
    const main = which === 'stdout' ? entry.stdoutDecoder : entry.stderrDecoder
    const text = main.write(chunk)
    const limit = which === 'stdout' ? entry.stdoutLimit : entry.stderrLimit
    const used = which === 'stdout' ? entry.stdoutBytes : entry.stderrBytes
    if (used < limit) {
      const room = limit - used
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk
      if (chunk.length > room) {
        if (which === 'stdout') entry.rec.stdoutTruncated = true
        else entry.rec.stderrTruncated = true
      }
      const cap = which === 'stdout' ? entry.stdoutCapDecoder : entry.stderrCapDecoder
      const capText = cap.write(slice)
      if (which === 'stdout') { entry.rec.stdout += capText; entry.stdoutBytes += slice.length }
      else { entry.rec.stderr += capText; entry.stderrBytes += slice.length }
    } else if (which === 'stdout') entry.rec.stdoutTruncated = true
    else entry.rec.stderrTruncated = true
    if (text !== '') {
      const notify = which === 'stdout' ? entry.onStdout : entry.onStderr
      if (notify !== undefined) safeNotify(entry, which, notify, text)
    }
  }

  private finishOutput(entry: Entry): void {
    // The protocol flush is unconditional: finishing the stream means the worker's last line still reaches the driver.
    const stdoutTail = entry.stdoutDecoder.end()
    const stderrTail = entry.stderrDecoder.end()
    if (stdoutTail !== '') {
      entry.rec.stdout += stdoutTail
      if (entry.onStdout !== undefined) safeNotify(entry, 'stdout', entry.onStdout, stdoutTail)
    }
    if (stderrTail !== '') {
      entry.rec.stderr += stderrTail
      if (entry.onStderr !== undefined) safeNotify(entry, 'stderr', entry.onStderr, stderrTail)
    }
  }

  private stopWatching(entry: Entry): void {
    if (entry.timeoutTimer !== null) {
      clearTimeout(entry.timeoutTimer)
      entry.timeoutTimer = null
    }
    entry.dropAbortListener?.()
    entry.dropAbortListener = null
  }

  private settle(entry: Entry, outcome: Outcome): void {
    if (entry.settled) return
    entry.settled = true
    if (entry.killTimer !== null) {
      clearTimeout(entry.killTimer)
      entry.killTimer = null
    }
    this.stopWatching(entry)
    entry.closeOutcome = null
    const rec = entry.rec
    rec.status = outcome.status
    rec.exitCode = outcome.exitCode
    rec.exitSignal = outcome.exitSignal
    rec.error = entry.spawnError ?? rec.error
    rec.endedAt = Date.now()
    entry.child = null
    const result = { id: rec.id, exitCode: rec.exitCode, exitSignal: rec.exitSignal, status: rec.status }
    this.entries.delete(rec.id)
    this.remember(rec, result)
    entry.resolve(result)
  }

  private remember(rec: ProcessRecord, outcome: WaitResult): void {
    const bytes = Buffer.byteLength(rec.stdout) + Buffer.byteLength(rec.stderr) + Buffer.byteLength(rec.error ?? '')
    if (bytes > SETTLED_OUTPUT_LIMIT) return
    this.history.set(rec.id, { rec, outcome, bytes })
    this.historyBytes += bytes
    for (const [id, oldest] of this.history) {
      if (this.history.size <= SETTLED_HISTORY_LIMIT && this.historyBytes <= SETTLED_OUTPUT_LIMIT) break
      this.history.delete(id)
      this.historyBytes -= oldest.bytes
    }
  }
}

/** A listener's bug must not break the child's I/O: it lands on the record, visibly. */
function safeNotify(entry: Entry, which: 'stdout' | 'stderr', notify: (text: string) => void, text: string): void {
  try {
    notify(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    entry.rec.error = entry.rec.error === null ? `output listener (${which}) failed: ${message}` : entry.rec.error
  }
}

function buildEnv(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }
  }
  return env
}
