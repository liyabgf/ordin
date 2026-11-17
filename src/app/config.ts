/**
 * Ordin 独立宿主的部署配置：路径与端口来自哪里、如何解析，只有一个答案。
 *
 * 来源优先级：显式参数 > 环境变量（ORDIN_STATE_DIR / ORDIN_WORK_ROOT / ORDIN_INBOX_DIR / ORDIN_PORT）> 默认值。
 * 默认值落在 `~/.ordin` 下——/tmp 只属于测试与隔离快照，绝不是生产默认（重启即失）。
 * 所有路径在这里统一解析成绝对路径：`~` 展开、相对路径以 cwd 为基、空值按未设置处理。
 */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** 解析完成的宿主配置：四个成员都是可直接使用的绝对值。 */
export interface OrdinConfig {
  /** 绝对路径。SQLite、stateDir 锁、uploads、设置与提示词覆写都在这里；一个 stateDir 一个写者。 */
  readonly stateDir: string
  /** 绝对路径。worker 工作目录的根（执行器接入后使用，现在只解析与携带）。 */
  readonly workRoot: string
  /** 绝对路径。inbox Source 的扫描目录（Source 尚未接入，现在只解析与携带）。 */
  readonly inboxDir: string
  /** HTTP 端口。server 尚未接入（P2-T2）；0 表示由操作系统分配，用于隔离测试。 */
  readonly port: number
}

/** 显式参数与环境变量的共同来源；测试注入 env/home/cwd，进程用真实值。 */
export interface ConfigSource {
  readonly env?: NodeJS.ProcessEnv
  readonly home?: string
  readonly cwd?: string
}

export interface ConfigOverrides {
  readonly stateDir?: string
  readonly workRoot?: string
  readonly inboxDir?: string
  readonly port?: number
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export const ENV_KEYS = {
  stateDir: 'ORDIN_STATE_DIR',
  workRoot: 'ORDIN_WORK_ROOT',
  inboxDir: 'ORDIN_INBOX_DIR',
  port: 'ORDIN_PORT',
} as const

/** 默认端口。避开 DSH 面板（3080）与常见开发端口；ORDIN_PORT 覆盖。 */
export const DEFAULT_PORT = 7471

/** 一条路径值的解析：去空白 → `~` 展开 → 相对路径以 cwd 为基 → 规范化。 */
export function resolvePath(value: string, source: { home: string; cwd: string }): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new ConfigError('路径不能为空字符串（留空等于未设置）')
  if (trimmed.includes('\u0000')) throw new ConfigError('路径不能包含 NUL 字节')
  let expanded = trimmed
  if (expanded === '~') expanded = source.home
  else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) expanded = join(source.home, expanded.slice(2))
  else if (expanded.startsWith('~')) throw new ConfigError(`不支持 ~user 形式的路径：${value}`)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(source.cwd, expanded)
}

/** 端口：十进制整数字符串或数字，0–65535。其余一律 ConfigError，绝不猜。 */
export function parsePort(value: string | number): number {
  const text = String(value).trim()
  if (!/^\d{1,5}$/.test(text)) throw new ConfigError(`端口必须是 0–65535 的整数，得到：${value}`)
  const port = Number(text)
  if (port > 65535) throw new ConfigError(`端口超出范围（0–65535）：${value}`)
  return port
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]
  // 空串与纯空白按未设置处理：shell 里 `ORDIN_STATE_DIR= ordin` 不是一次有效配置。
  return value === undefined || value.trim() === '' ? undefined : value
}

/** 解析配置。来源优先级：显式参数 > env > 默认值；每个成员独立解析，坏值大声失败（A4/A7）。 */
export function resolveConfig(overrides: ConfigOverrides & ConfigSource = {}): OrdinConfig {
  const env = overrides.env ?? process.env
  const home = overrides.home ?? homedir()
  const cwd = overrides.cwd ?? process.cwd()
  const source = { home, cwd }

  const stateDirRaw = overrides.stateDir ?? envValue(env, ENV_KEYS.stateDir) ?? join(home, '.ordin', 'state')
  const workRootRaw = overrides.workRoot ?? envValue(env, ENV_KEYS.workRoot) ?? join(home, '.ordin', 'work')
  const inboxDirRaw = overrides.inboxDir ?? envValue(env, ENV_KEYS.inboxDir) ?? join(home, '.ordin', 'inbox')
  const portRaw = overrides.port ?? (envValue(env, ENV_KEYS.port) !== undefined ? parsePort(envValue(env, ENV_KEYS.port)!) : DEFAULT_PORT)
  if (typeof portRaw !== 'number' || !Number.isInteger(portRaw) || portRaw < 0 || portRaw > 65535) {
    throw new ConfigError(`端口必须是 0–65535 的整数，得到：${String(portRaw)}`)
  }

  return {
    stateDir: resolvePath(stateDirRaw, source),
    workRoot: resolvePath(workRootRaw, source),
    inboxDir: resolvePath(inboxDirRaw, source),
    port: portRaw,
  }
}
