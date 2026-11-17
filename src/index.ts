/**
 * Ordin 独立进程入口。
 *
 * 先启动自己的 SQLite、任务管理、HTTP 面板，再后台检查可选执行工具。
 * 不要求安装 DSH/Codex/Claude，也不要求配置模型凭据才能打开面板。
 */
import { readFileSync } from 'node:fs'
import { storageMaintenance } from './app/storage-maintenance.ts'
import { fileURLToPath } from 'node:url'
import { boot, installSignalHandlers, LockHeld, type Boot } from './app/boot.ts'
import { ConfigError, resolveConfig, type OrdinConfig } from './app/config.ts'
import { createLogger } from './app/logger.ts'
import { ProcessRegistry } from './app/process.ts'
import { createRuntime, type Runtime } from './app/runtime.ts'
import { ClaudeDriver } from './drivers/claude.ts'
import { CodexDriver } from './drivers/codex.ts'
import { DshDriver } from './drivers/dsh.ts'
import { DshServiceDriver } from './drivers/dsh-service.ts'
import { DriverRouter } from './drivers/router.ts'
import { AvailableDriver } from './drivers/availability.ts'

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }

/** 静态状态：默认配置与接入事实。不抛错——配置坏了也是状态的一部分。 */
export function status(): string {
  let configLine: string
  try {
    const config = resolveConfig({ env: process.env })
    configLine = `stateDir=${config.stateDir} workRoot=${config.workRoot} inboxDir=${config.inboxDir} port=${config.port}`
  } catch (error) {
    configLine = `配置无效：${error instanceof Error ? error.message : String(error)}`
  }
  return [
    `ordin ${pkg.version}`,
    `状态：组合根已接入（boot / HTTP 面板 / Sources / Executor / Delivery / DeskLoop）；${configLine}`,
    `说明：Ordin 独立启动；执行工具未安装或未登录时，面板仍可使用，任务执行会显示具体原因。`,
  ].join('\n')
}

/** 真实入口：解析配置 → boot → 装信号 → start → 如实打印本实例状态，然后待着直到信号。 */
export async function main(): Promise<number> {
  if (process.argv[2] === 'storage') return storageMaintenance(process.argv.slice(3))
  const logger = createLogger()
  let config: OrdinConfig
  try {
    config = resolveConfig({ env: process.env })
  } catch (error) {
    if (error instanceof ConfigError) { logger.error('配置无效，拒绝启动', error.message); return 2 }
    throw error
  }

  let app: Boot
  try {
    app = boot({ config, logger })
  } catch (error) {
    if (error instanceof LockHeld) {
      logger.error(`stateDir 已被另一个进程持有（${error.holder.host}:${error.holder.pid}，自 ${error.holder.at}）；一个目录一个写者`)
      return 1
    }
    logger.error('ordin 启动失败', error)
    return 1
  }

  const proc = new ProcessRegistry()
  const backendHealth = app.health.entry('execution-backend')
  backendHealth.problem('正在检查执行工具；Ordin 可独立使用。')
  const driver = new DriverRouter({
    dsh: new AvailableDriver(process.env.ORDIN_DSH_URL
      ? new DshServiceDriver({ baseUrl: process.env.ORDIN_DSH_URL, token: process.env.ORDIN_DSH_SERVICE_TOKEN ?? '' })
      : new DshDriver(proc), app.health.entry('backend:dsh')),
    codex: new AvailableDriver(new CodexDriver(proc), app.health.entry('backend:codex')),
    claude: new AvailableDriver(new ClaudeDriver(proc), app.health.entry('backend:claude')),
  }, () => app.store.settings().executor.backend)
  const runtime: Runtime = createRuntime(app, { logger, driver, proc })
  const keepAlive = setInterval(() => {}, 1 << 30)
  const stop = async (): Promise<void> => {
    await proc.stopAll(250)
    await runtime.stop()
  }
  installSignalHandlers({ stop }, { onStopped: () => { clearInterval(keepAlive) } })
  try {
    await runtime.start()
  } catch (error) {
    logger.error('ordin 组合根启动失败', error)
    clearInterval(keepAlive)
    await stop()
    return 1
  }
  void runtime.checkExecution().catch(error => { logger.warn('执行工具检查已结束', error) })
  const state = runtime.status()
  console.log(`ordin ${pkg.version} started：stateDir=${state.stateDir} panel=${state.panel} ready=${state.ready}`)
  console.log('按 SIGINT/SIGTERM 停止。')
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then(
    code => { if (code !== 0) process.exitCode = code },
    error => { console.error(error); process.exitCode = 1 },
  )
}
