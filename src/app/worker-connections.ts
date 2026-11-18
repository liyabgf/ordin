import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, open, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { BackendKind, WorkerDriver } from '../drivers/types.ts'

const local = z.string().refine(value => {
  try {
    const u = new URL(value)
    return u.origin === value && ['http:', 'https:'].includes(u.protocol) && ['127.0.0.1','[::1]','localhost'].includes(u.hostname)
  } catch { return false }
})
const secret = z.string().min(1).max(2048).refine(v => !/[\s\x00-\x1f\x7f]/.test(v))
const binary = z.string().max(1024).refine(v => v === '' || (isAbsolute(v) && !/[\x00-\x1f\x7f]/.test(v)))
const stored = z.object({
  dsh: z.object({ address: local, token: secret }).strict().optional(),
  codex: binary.optional(), claude: binary.optional(),
  connectionIds: z.object({ dsh: z.uuid().optional(), codex: z.uuid().optional(), claude: z.uuid().optional() }).strict().optional(),
  // Written only after a failed load; missing entries must not fall back after repair.
  requireExplicitConnections: z.literal(true).optional(),
}).strict()
type Saved = z.infer<typeof stored>
type Builder = (backend: BackendKind, saved: Saved) => WorkerDriver
const request = z.object({value:z.string().max(4096),allowDshPermissions:z.literal(true).optional()}).strict()

function blockedDriver(backend: BackendKind): WorkerDriver {
  const problem = '执行端未重新连接；请在设置中重新连接此执行端后再重试任务。'
  const reject = async (): Promise<never> => { throw Error(problem) }
  return {
    backend,
    probe: async () => ({backend, ok:false, checkedAt:new Date().toISOString(), auth:'unknown', problems:[problem]}),
    prepare:reject, launch:reject, resume:reject,
  }
}

export class WorkerConnections {
  private saved: Saved = {}
  private readonly drivers = new Map<BackendKind, WorkerDriver>()
  private busy = false
  private readonly file: string
  constructor(stateDir: string, private readonly build: Builder) { this.file = join(stateDir,'worker-connections.json') }

  async load() {
    try {
      this.saved = await this.readSaved()
    } catch (error) {
      this.saved = {requireExplicitConnections:true}
      throw error
    } finally { this.drivers.clear() }
  }

  private async readSaved(): Promise<Saved> {
    let h
    try { h = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw Error('无法读取执行端连接设置') }
    try {
      try {
        const info = await h.stat()
        if (!info.isFile() || (info.mode & 0o077) || info.size > 16384) throw Error('invalid connection file')
        return stored.parse(JSON.parse(await h.readFile('utf8')))
      } finally { await h.close() }
    } catch { throw Error('执行端连接设置无效或权限不安全') }
  }

  connectionId(backend: BackendKind): string | undefined {
    return this.saved[backend] === undefined ? undefined : this.saved.connectionIds?.[backend]
  }

  driver(backend: BackendKind): WorkerDriver {
    let driver = this.drivers.get(backend)
    if (!driver) {
      driver = this.saved.requireExplicitConnections && this.saved[backend] === undefined
        ? blockedDriver(backend) : this.build(backend, this.saved)
      driver = this.withIdentity(driver, this.connectionId(backend))
      this.drivers.set(backend, driver)
    }
    return driver
  }

  private withIdentity(driver: WorkerDriver, connectionId?: string): WorkerDriver {
    if (!connectionId) return driver
    return {
      backend: driver.backend, connectionId,
      probe: backend => driver.probe(backend),
      prepare: (spec, session) => driver.prepare(spec, session),
      launch: spec => driver.launch(spec),
      resume: (session, spec) => driver.resume(session, spec),
    }
  }

  view() {
    const {dsh,codex,claude} = this.saved
    const identity = (backend: BackendKind) => {
      const connectionId = this.connectionId(backend)
      return connectionId === undefined ? {} : { connectionId }
    }
    return {
      dsh: dsh ? {configured:true,address:dsh.address,...identity('dsh')} : {configured:false},
      codex: codex === undefined ? {configured:false} : {configured:true,binary:codex || 'codex',...identity('codex')},
      claude: claude === undefined ? {configured:false} : {configured:true,binary:claude || 'claude',...identity('claude')},
    }
  }

  async testAndSave(backend: BackendKind, input: unknown) {
    if (this.busy) throw Error('正在测试另一个连接，请稍后再试。')
    const parsed = request.safeParse(input)
    if (!parsed.success) throw Error('连接信息格式不正确。')
    this.busy = true
    try {
      const value = parsed.data.value.trim()
      const next = {...this.saved}
      if (backend === 'dsh') {
        if (!parsed.data.allowDshPermissions) throw Error('请先确认 DSH 使用自己的文件权限。')
        try {
          const u = new URL(value)
          if (u.username || u.password || u.hash || (u.pathname !== '/' && u.pathname !== '/connect') || u.searchParams.getAll('token').length !== 1) throw Error('invalid link')
          next.dsh = { address:local.parse(u.origin), token:secret.parse(u.searchParams.get('token')) }
        } catch { throw Error('请粘贴 DSH 启动时显示的完整本机连接链接（包含 token）。') }
      } else {
        if (!binary.safeParse(value).success) throw Error('请留空自动查找，或填写本机程序的完整路径，不要填写命令参数。')
        if (value) try { await access(value,constants.X_OK) } catch { throw Error('找不到可执行程序，请核对路径。') }
        next[backend] = value
      }
      const candidate = this.build(backend,next)
      const ready = await candidate.probe().then(result => result.ok, () => false)
      if (!ready) throw Error(backend === 'dsh' ? '连不上 DSH。请确认 DSH 正在运行，并从终端重新复制连接链接。旧设置未更改。' : '检查未通过。请先安装并登录该工具，再检查程序路径。旧设置未更改。')
      const connectionId = randomUUID()
      next.connectionIds = { ...next.connectionIds, [backend]: connectionId }
      const tmp = this.file + '.' + randomUUID()
      try {
        const h = await open(tmp,'wx',0o600)
        try { await h.writeFile(JSON.stringify(next)); await h.sync() } finally { await h.close() }
        await rename(tmp,this.file)
      } catch {
        await unlink(tmp).catch(() => {})
        throw Error('无法保存连接。旧设置未更改。')
      }
      this.saved = next
      this.drivers.set(backend, this.withIdentity(candidate, connectionId))
      return this.view()
    } finally { this.busy = false }
  }
}
