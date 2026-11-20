/**
 * P2-T1 bootstrap 的验收：配置默认值与覆盖、锁冲突、三次起停无残留、重复 stop、Effects 排空、信号接线。
 *
 * 全部在 /tmp 独立目录进行（tempDir 注册生死），不启动 HTTP、不触碰任何真实后端。
 * executionReady=false 是这里的合同之一：装配面必须诚实（AGENTS.md A6）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { boot, installSignalHandlers, UNWIRED, type Boot, type SignalReceiver } from '../src/app/boot.ts'
import { ConfigError, DEFAULT_PORT, ENV_KEYS, parsePort, resolveConfig } from '../src/app/config.ts'
import { silentLogger } from '../src/app/logger.ts'
import { LockHeld } from '../src/app/lock.ts'
import { tempDir } from './helpers/temp.ts'

const logger = silentLogger()

/** 空 env 骨架：四个 ORDIN_* 键被显式清空，测试逐个开闸。 */
const fakeEnv = (values: Record<string, string | undefined>): NodeJS.ProcessEnv => ({
  [ENV_KEYS.stateDir]: undefined, [ENV_KEYS.workRoot]: undefined, [ENV_KEYS.inboxDir]: undefined, [ENV_KEYS.port]: undefined,
  ...values,
})

const bootIn = (stateDir: string, overrides: { stopTimeoutMs?: number } = {}): Boot => boot({
  config: resolveConfig({
    env: fakeEnv({
      [ENV_KEYS.stateDir]: stateDir,
      [ENV_KEYS.workRoot]: stateDir,
      [ENV_KEYS.inboxDir]: stateDir,
    }),
    home: '/unused-home',
    cwd: tmpdir(),
  }),
  logger,
  passIntervalMs: 50,
  stopTimeoutMs: overrides.stopTimeoutMs ?? 5_000,
})

/** 可注入的假信号面：只记住 listener，由测试显式 fire。 */
class FakeSignals implements SignalReceiver {
  private readonly listeners = new Map<string, () => void>()
  on(event: string, listener: () => void): void { this.listeners.set(event, listener) }
  off(event: string, listener: () => void): void { if (this.listeners.get(event) === listener) this.listeners.delete(event) }
  fire(event: string): void { this.listeners.get(event)?.() }
  wired(event: string): boolean { return this.listeners.has(event) }
}

describe('配置解析', () => {
  it('默认值落在 ~/.ordin 下，绝不默认 /tmp', () => {
    const config = resolveConfig({ env: {}, home: '/Users/op', cwd: '/Users/op' })
    expect(config.stateDir).toBe('/Users/op/.ordin/state')
    expect(config.workRoot).toBe('/Users/op/.ordin/work')
    expect(config.inboxDir).toBe('/Users/op/.ordin/inbox')
    expect(config.port).toBe(DEFAULT_PORT)
  })

  it('四个环境变量各自覆盖对应成员', () => {
    const config = resolveConfig({
      env: fakeEnv({
        [ENV_KEYS.stateDir]: '/var/ordin/state',
        [ENV_KEYS.workRoot]: '/var/ordin/work',
        [ENV_KEYS.inboxDir]: '/var/ordin/inbox',
        [ENV_KEYS.port]: '8099',
      }),
      home: '/Users/op',
      cwd: '/Users/op',
    })
    expect(config.stateDir).toBe('/var/ordin/state')
    expect(config.workRoot).toBe('/var/ordin/work')
    expect(config.inboxDir).toBe('/var/ordin/inbox')
    expect(config.port).toBe(8099)
  })

  it('显式参数压过环境变量', () => {
    const config = resolveConfig({
      env: fakeEnv({ [ENV_KEYS.stateDir]: '/from-env' }),
      stateDir: '/from-param',
      home: '/Users/op',
      cwd: '/Users/op',
    })
    expect(config.stateDir).toBe('/from-param')
  })

  it('相对路径以 cwd 为基，~ 展开到 home', () => {
    const config = resolveConfig({
      env: fakeEnv({ [ENV_KEYS.stateDir]: 'state/sub', [ENV_KEYS.inboxDir]: '~/inbox' }),
      home: '/Users/op',
      cwd: '/Users/op/work',
    })
    expect(config.stateDir).toBe('/Users/op/work/state/sub')
    expect(config.inboxDir).toBe('/Users/op/inbox')
  })

  it('空串环境变量按未设置处理；坏端口、NUL 路径大声失败', () => {
    const empty = resolveConfig({ env: fakeEnv({ [ENV_KEYS.stateDir]: '  ' }), home: '/h', cwd: '/h' })
    expect(empty.stateDir).toBe('/h/.ordin/state')
    expect(() => resolveConfig({ env: fakeEnv({ [ENV_KEYS.port]: 'nope' }), home: '/h', cwd: '/h' })).toThrow(ConfigError)
    expect(() => resolveConfig({ env: fakeEnv({ [ENV_KEYS.port]: '70000' }), home: '/h', cwd: '/h' })).toThrow(ConfigError)
    expect(() => resolveConfig({ env: fakeEnv({ [ENV_KEYS.stateDir]: 'x\u0000y' }), home: '/h', cwd: '/h' })).toThrow(ConfigError)
    expect(parsePort('0')).toBe(0)
  })
})

describe('bootstrap 生命周期', () => {
  it('锁冲突：同 stateDir 第二个 boot 拿不到锁，并如实报告持有者', async () => {
    const dir = tempDir('ordin-boot-conflict-')
    const first = bootIn(dir)
    await first.start()
    let thrown: unknown
    try { bootIn(dir) } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(LockHeld)
    expect((thrown as LockHeld).holder.pid).toBe(process.pid)
    expect(first.status().phase).toBe('started')
    await first.stop()
    // 放锁之后同目录可以再 boot（锁是目录上唯一的写者凭据）。
    const again = bootIn(dir)
    await again.start()
    await again.stop()
  })

  it('三次起停无残留：锁文件释放、Store 干净关闭、下一轮照常打开', async () => {
    const dir = tempDir('ordin-boot-cycle-')
    const lockPath = join(dir, 'ordin.lock')
    const dbPath = join(dir, 'ordin.sqlite3')
    const exitListeners = process.listenerCount('exit')
    for (let round = 1; round <= 3; round++) {
      const app = bootIn(dir)
      expect(app.status().phase).toBe('created')
      await app.start()
      expect(app.status().phase).toBe('started')
      await app.stop()
      expect(app.status().phase).toBe('stopped')
      expect(existsSync(lockPath), `round ${round}: 锁文件应已释放`).toBe(false)
      expect(process.listenerCount('exit'), `round ${round}: 退出监听器应回到基线`).toBe(exitListeners)
      expect(existsSync(dbPath), `round ${round}: 数据库应保留`).toBe(true)
      expect(existsSync(`${dbPath}-wal`), `round ${round}: WAL 应随干净关闭消失`).toBe(false)
    }
  })

  it('子进程正常退出时清理未显式释放的状态锁', () => {
    const dir = tempDir('ordin-boot-exit-lock-')
    const lockModule = new URL('../src/app/lock.ts', import.meta.url).href
    const child = spawnSync(process.execPath, [
      '--experimental-transform-types', '--input-type=module', '--eval',
      "const { takeLock } = await import(process.argv[1]); takeLock(process.argv[2]); console.log('lock acquired')",
      lockModule, dir,
    ], { encoding: 'utf8', timeout: 5000 })
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout).toContain('lock acquired')
    expect(existsSync(join(dir, 'ordin.lock'))).toBe(false)
  })

  it('重复 stop 幂等；未 start 的 boot 也能 stop 干净', async () => {
    const dir = tempDir('ordin-boot-dstop-')
    const app = bootIn(dir)
    await app.start()
    await app.stop()
    await expect(app.stop()).resolves.toBeUndefined()
    expect(app.status().phase).toBe('stopped')
    expect(existsSync(join(dir, 'ordin.lock'))).toBe(false)

    const never = bootIn(dir)
    await never.stop()
    expect(never.status().phase).toBe('stopped')
    expect(existsSync(join(dir, 'ordin.lock'))).toBe(false)
    await expect(never.start()).rejects.toThrow(/已停止/)
  })

  it('stop 排空在途 effect：handler 完成后 Store 才关闭、锁才释放', async () => {
    const dir = tempDir('ordin-boot-drain-')
    const app = bootIn(dir)
    let release = (): void => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    let handled = false
    app.effects.handle('boot-drain', () => gate.then(() => { handled = true }))
    await app.start()
    app.effects.enqueue('boot-drain', 'one', null)
    const pumping = app.effects.runDue()
    await new Promise(resolve => setTimeout(resolve, 10))
    const stopping = app.stop()
    let stopped = false
    void stopping.then(() => { stopped = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(stopped, 'gate 未开时 stop 不得完成').toBe(false)
    release()
    await pumping
    await stopping
    expect(handled).toBe(true)
    expect(stopped).toBe(true)
    expect(app.status().phase).toBe('stopped')
    // Store 已关：重启目录照常（锁与连接都已让出）。
    const again = bootIn(dir)
    await again.start()
    await again.stop()
  })

  it('stop 排空超时不假装完成：抛 StopIncompleteError，锁与库保留，可重试', async () => {
    const dir = tempDir('ordin-boot-timeout-')
    const app = bootIn(dir, { stopTimeoutMs: 50 })
    let release = (): void => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    app.effects.handle('boot-hang', () => gate)
    await app.start()
    app.effects.enqueue('boot-hang', 'h', null)
    void app.effects.runDue()
    await new Promise(resolve => setTimeout(resolve, 10))
    await expect(app.stop()).rejects.toThrow('未能')
    expect(app.status().phase).toBe('stopping')
    expect(existsSync(join(dir, 'ordin.lock')), '超时后锁保留，供重试').toBe(true)
    release()
    await app.stop()
    expect(app.status().phase).toBe('stopped')
    expect(existsSync(join(dir, 'ordin.lock'))).toBe(false)
  })

  it('SIGINT/SIGTERM 触发 stop；卸载后不再接线；停不动时第二次信号强制退出 130', async () => {
    const dir = tempDir('ordin-boot-signal-')
    const app = bootIn(dir)
    await app.start()
    const exits: number[] = []
    const signals = new FakeSignals()
    const uninstall = installSignalHandlers(app, { signals, exit: code => exits.push(code) })
    expect(signals.wired('SIGINT')).toBe(true)
    expect(signals.wired('SIGTERM')).toBe(true)
    signals.fire('SIGTERM')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(app.status().phase).toBe('stopped')
    expect(exits).toEqual([0])
    uninstall()
    expect(signals.wired('SIGINT')).toBe(false)
    signals.fire('SIGINT')
    expect(exits).toEqual([0])

    // 停不动的进程：第一次信号开始停，第二次立即 130。
    const stuck = bootIn(dir)
    let release = (): void => {}
    stuck.effects.handle('boot-signal-hang', () => new Promise<void>(resolve => { release = resolve }))
    await stuck.start()
    const exits2: number[] = []
    const signals2 = new FakeSignals()
    installSignalHandlers(stuck, { signals: signals2, exit: code => exits2.push(code) })
    stuck.effects.enqueue('boot-signal-hang', 'h', null)
    void stuck.effects.runDue()
    await new Promise(resolve => setTimeout(resolve, 10))
    signals2.fire('SIGINT')
    signals2.fire('SIGINT')
    expect(exits2).toEqual([130])
    release()
    await stuck.stop()
    expect(stuck.status().phase).toBe('stopped')
  })

  it('status() 如实报告未接入清单与 executionReady=false', async () => {
    const dir = tempDir('ordin-boot-status-')
    const app = bootIn(dir)
    await app.start()
    const status = app.status()
    expect(status.executionReady).toBe(false)
    expect([...status.unwired]).toContain('executor')
    expect([...status.unwired]).toContain('delivery')
    expect([...status.unwired]).toContain('http')
    expect(status.unwired).toEqual(UNWIRED)
    expect(status.health).toEqual(expect.objectContaining({}))
    await app.stop()
  })
})
