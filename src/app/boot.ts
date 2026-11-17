/**
 * 独立宿主的 bootstrap：锁、SQLite、提示词、Effects 队列与泵的装配与生命周期。
 *
 * 装配顺序按 docs/p2/runtime-analysis.md §1.2：Uploads → stateDir 锁 → Store → Prompts → Effects → Passes 泵。
 * 锁先于 Store——一个 stateDir 一个写者；Store 构造失败（如 SchemaTooNew）必须把已取得的锁放回去。
 *
 * 执行器、交付、HTTP、Sources、Watchdog 在 P2-T1 尚未接入：这里不为它们造假件、不开假开关（A6），
 * executionReady 恒为 false，未接入清单在 status() 里如实列出。装配了会假装能执行的部件，宁可不装配。
 */
import { join } from 'node:path'
import type { OrdinConfig } from './config.ts'
import { Effects } from './effects.ts'
import type { HealthState } from './health.ts'
import { HealthBoard } from './health.ts'
import { LockHeld, takeLock, writeMarker, type StateLock } from './lock.ts'
import type { Logger } from './logger.ts'
import { Passes } from './passes.ts'
import { Prompts } from './prompts.ts'
import { Store } from './store.ts'
import { Uploads } from './uploads.ts'

/** SQLite 数据库文件名，相对 stateDir。 */
export const DB_FILE = 'ordin.sqlite3'
/** stop 排空的上限；超时抛 StopIncompleteError，锁与数据库保留供重试（对齐 runtime.ts:1538–1551）。 */
export const STOP_TIMEOUT_MS = 15_000
/** Passes 泵的默认间隔。 */
export const PASS_INTERVAL_MS = 2_000

/** P2-T1 尚未接入、装配了就会假装能执行的部件。接入一张删一张（A4：这份清单就是会被忘掉的东西，所以它有测试）。 */
export const UNWIRED = ['engine', 'executor', 'delivery', 'sources', 'watchdog', 'http'] as const

/** stop 的排空没有在预算内完成；锁与数据库保持打开，stop 可以重试。 */
export class StopIncompleteError extends Error {
  constructor(options: { readonly cause?: unknown } = {}) {
    super('ordin 未能在预算内排空（锁与数据库保留，可重试 stop）')
    this.name = 'StopIncompleteError'
    if (options.cause !== undefined) this.cause = options.cause
  }
}

export type BootPhase = 'created' | 'starting' | 'started' | 'stopping' | 'stopped'

/** SIGINT/SIGTERM 的最小接收面；测试注入假件，进程用全局 process。 */
export interface SignalReceiver {
  on(event: string, listener: () => void): unknown
  off(event: string, listener: () => void): unknown
}

export interface BootOptions {
  readonly config: OrdinConfig
  readonly logger: Logger
  /** stop 排空预算，默认 STOP_TIMEOUT_MS；测试用小值。 */
  readonly stopTimeoutMs?: number
  /** Passes 泵间隔，默认 PASS_INTERVAL_MS；测试用小值。 */
  readonly passIntervalMs?: number
}

export interface BootStatus {
  readonly phase: BootPhase
  /** 执行器/交付未接入之前恒为 false；这是合同，不是提示。 */
  readonly executionReady: false
  readonly unwired: readonly string[]
  readonly stateDir: string
  readonly workRoot: string
  readonly inboxDir: string
  readonly port: number
  readonly dbPath: string
  readonly startedAt?: string
  readonly health: Record<string, HealthState>
}

/** boot() 建好的一套组件与生命周期；一次 boot 只服务一轮 start/stop，重启要重新 boot（锁是一次性的）。 */
export interface Boot {
  readonly config: OrdinConfig
  readonly logger: Logger
  readonly uploads: Uploads
  readonly store: Store
  readonly prompts: Prompts
  readonly effects: Effects
  readonly passes: Passes
  readonly health: HealthBoard
  readonly lock: StateLock
  /** 终身信号：stop 时 abort，接进去的每个部件用它结束等待。 */
  readonly lifetime: AbortSignal
  phase(): BootPhase
  start(): Promise<void>
  stop(): Promise<void>
  status(): BootStatus
}

const text = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error))

/** SIGINT/SIGTERM → stop()。第一次信号开始停，排空后以退出码 0/1 结束；停不动时再来一次信号立即退出（130）。 */
export function installSignalHandlers(target: { stop(): Promise<void> }, options: {
  readonly signals?: SignalReceiver
  readonly exit?: (code: number) => void
  /** stop 结束后、exit 之前的回调（入口在这里清掉保活定时器）。 */
  readonly onStopped?: (error?: unknown) => void
} = {}): () => void {
  const signals: SignalReceiver = options.signals ?? process
  const exit = options.exit ?? (code => { process.exit(code) })
  let stopping = false
  const listener = (): void => {
    // 第二次信号：操作者已经明确要走了，不再等一个停不下来的排空。
    if (stopping) { exit(130); return }
    stopping = true
    void target.stop().then(
      () => { options.onStopped?.(); exit(0) },
      error => { options.onStopped?.(error); exit(1) },
    )
  }
  signals.on('SIGINT', listener)
  signals.on('SIGTERM', listener)
  return () => {
    signals.off('SIGINT', listener)
    signals.off('SIGTERM', listener)
  }
}

export function boot(options: BootOptions): Boot {
  const { config, logger } = options
  const stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS

  // 装配顺序 §1.2：Uploads → 锁 → marker → Store → Prompts → Effects → Passes。
  const uploads = new Uploads(config.stateDir)
  const lock = takeLock(config.stateDir)
  try {
    writeMarker(config.stateDir, { app: 'ordin', pid: process.pid, port: config.port, at: new Date().toISOString() })
    const store = new Store(join(config.stateDir, DB_FILE))
    if (store.migrationBackupPath !== undefined) logger.info('ordin migration backup retained', { path: store.migrationBackupPath })
    const health = new HealthBoard()
    const lifetime = new AbortController()

    // Store 的延迟动作失败不能没人看见（store.ts 的约定由 Runtime 接线，这里接）。
    store.onDeferredError = error => {
      health.entry('store').problem(text(error))
      logger.error('store 的 afterCommit 动作失败', error)
    }

    const prompts = new Prompts(store)
    const effects = new Effects(store, {
      health: health.entry('effects'),
      lifetime: lifetime.signal,
      onPermanentFailure: (kind, key, _payload, error) => {
        logger.error('effect 重试耗尽，已放弃', { kind, key, error: text(error) })
      },
    })
    const passes = new Passes({
      effects,
      intervalMs: options.passIntervalMs ?? PASS_INTERVAL_MS,
      health: health.entry('passes'),
      lifetime: lifetime.signal,
    })

    let phase: BootPhase = 'created'
    let startedAt: string | undefined
    let startPromise: Promise<void> | undefined
    let stopPromise: Promise<void> | undefined

    // 无票知识时不能误删：TTL 过期的自由件由 Uploads 自己判，票绑定的只认「开着的票」。
    const uploadActive = (ticketId: string): boolean => {
      const ticket = store.tickets.get(ticketId)
      return ticket !== undefined && ticket.ended === undefined && ticket.deleted === undefined
    }

    const app: Boot = {
      config,
      logger,
      uploads,
      store,
      prompts,
      effects,
      passes,
      health,
      lock,
      lifetime: lifetime.signal,

      phase: () => phase,

      async start(): Promise<void> {
        if (phase === 'stopped') throw new Error('boot 已停止；重启请重新 boot()（stateDir 锁是一次性的）')
        if (phase === 'stopping') throw new Error('boot 正在停止，不能再 start')
        if (startPromise !== undefined) return startPromise
        phase = 'starting'
        startPromise = (async () => {
          try {
            // 启动顺序对齐 runtime.ts:1326–1399 的前段：uploads 清理 → 泵。
            uploads.cleanup(uploadActive)
            passes.start()
            phase = 'started'
            startedAt = new Date().toISOString()
            // Boot only opens persistence and the effect pump; Runtime reports application readiness after assembly.
            logger.info('ordin storage ready', { stateDir: config.stateDir })
          } catch (error) {
            phase = 'created'
            startPromise = undefined
            throw error
          }
        })()
        return startPromise
      },

      async stop(): Promise<void> {
        if (phase === 'stopped') return
        if (stopPromise !== undefined) return stopPromise
        phase = 'stopping'
        stopPromise = (async () => {
          const begin = Date.now()
          const deadline = begin + stopTimeoutMs
          const remaining = (): number => Math.max(0, deadline - Date.now())
          try {
            // §1.4：先停 Admission（abort + 泵定时器 + effects 不再收新行），再排空，再关 Store，最后放锁。
            lifetime.abort()
            const passStopped = passes.stop(remaining()).then(() => undefined, (error: unknown) => error)
            effects.dispose()
            const drained = Promise.allSettled([passStopped, effects.drain()])
            let finished = false
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
              await Promise.race([
                drained.then(() => { finished = true }),
                new Promise<never>((_resolve, reject) => {
                  timer = setTimeout(() => reject(new StopIncompleteError()), remaining())
                }),
              ])
            } finally {
              if (timer !== undefined) clearTimeout(timer)
            }
            // 预算覆盖整个排空：allSettled 不 reject，超时在这里转成显式的未完成。
            if (!finished) throw new StopIncompleteError()
            store.close()
            lock.release()
            phase = 'stopped'
            logger.info('ordin stopped', { stateDir: config.stateDir, inMs: Date.now() - begin })
          } catch (error) {
            // 超时或关闭失败：锁与数据库保留，stop 可重试；成功与否操作者都看得见（A7）。
            stopPromise = undefined
            logger.error('ordin stop 未完成', error)
            throw error
          }
        })()
        return stopPromise
      },

      status(): BootStatus {
        return {
          phase,
          executionReady: false,
          unwired: UNWIRED,
          stateDir: config.stateDir,
          workRoot: config.workRoot,
          inboxDir: config.inboxDir,
          port: config.port,
          dbPath: join(config.stateDir, DB_FILE),
          startedAt,
          health: health.snapshot(),
        }
      },
    }
    return app
  } catch (error) {
    // Store/Prompts/Effects 任一步失败：已取得的锁必须放回去，不能留下一个没人持有的死锁文件。
    lock.release()
    throw error
  }
}

export { LockHeld }
