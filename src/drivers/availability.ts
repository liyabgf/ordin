/** Backend availability belongs to execution, never to the Ordin server lifecycle. */
import type { HealthEntry } from '../app/health.ts'
import type { BackendSession, DriverHealth, LaunchSpec, RunningTurn, WorkerDriver, WorkerSpec } from './types.ts'

export class AvailableDriver implements WorkerDriver {
  readonly backend: WorkerDriver['backend']
  private checking?: Promise<DriverHealth>
  constructor(private readonly driver: WorkerDriver, private readonly health: HealthEntry) {
    this.backend = driver.backend
  }

  probe(): Promise<DriverHealth> {
    if (this.checking !== undefined) return this.checking
    const check = Promise.resolve().then(() => this.driver.probe()).catch((error: unknown): DriverHealth => ({
      backend: this.backend, ok: false, checkedAt: new Date().toISOString(), auth: 'unknown',
      problems: [error instanceof Error ? error.message : String(error)],
    })).then(result => {
      if (result.ok) this.health.record(`执行工具 ${this.backend} 协议检查通过；真实任务结果以执行回执为准` + (result.warnings?.length ? `；能力告警：${result.warnings.join("; ")}` : ""))
      else this.health.problem(`执行工具 ${this.backend} 暂不可用：${result.problems.join('; ') || '检查未通过'}。Ordin 面板仍可使用，配置后重试任务。`)
      return result
    }).finally(() => { this.checking = undefined })
    this.checking = check
    return check
  }

  private async requireAvailable(): Promise<void> {
    const result = await this.probe()
    if (!result.ok) throw new Error(`执行工具 ${this.backend} 暂不可用：${result.problems.join('; ')}。请先配置执行工具，再重试任务。`)
  }

  async prepare(spec: WorkerSpec, session?: BackendSession): Promise<LaunchSpec> {
    await this.requireAvailable()
    return await this.driver.prepare(spec, session)
  }
  async launch(spec: LaunchSpec): Promise<RunningTurn> {
    await this.requireAvailable()
    return await this.driver.launch(spec)
  }
  async resume(session: BackendSession, spec: LaunchSpec): Promise<RunningTurn> {
    await this.requireAvailable()
    return await this.driver.resume(session, spec)
  }
}
