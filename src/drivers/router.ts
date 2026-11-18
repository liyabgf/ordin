import type { BackendKind, BackendSession, DriverHealth, LaunchSpec, RunningTurn, WorkerDriver, WorkerSpec } from './types.ts'

/** New work follows settings; prepared work and persisted sessions retain their backend. */
export class DriverRouter implements WorkerDriver {
  private readonly prepared = new WeakMap<LaunchSpec, WorkerDriver>()
  constructor(private readonly drivers: Readonly<Record<BackendKind, WorkerDriver>> | ((backend: BackendKind) => WorkerDriver), private readonly selected: () => BackendKind) {}
  private driver(backend: BackendKind) { return typeof this.drivers === "function" ? this.drivers(backend) : this.drivers[backend] }
  get backend(): BackendKind { return this.selected() }
  preparedConnectionId(spec: LaunchSpec): string | undefined { return this.prepared.get(spec)?.connectionId }
  probe(backend = this.selected()): Promise<DriverHealth> { return this.driver(backend).probe() }
  async prepare(spec: WorkerSpec, session?: BackendSession): Promise<LaunchSpec> {
    if (spec.mcpReport !== undefined) throw new Error("Tool registration is not supported by Ordin’s worker router")
    const driver = this.driver(session?.backend ?? spec.backend ?? this.selected())
    const prepared = await driver.prepare(spec, session)
    this.prepared.set(prepared, driver)
    return prepared
  }
  async launch(spec: LaunchSpec): Promise<RunningTurn> {
    const driver = this.prepared.get(spec)
    if (driver === undefined) throw new Error('Worker launch must use a spec prepared by this router')
    this.prepared.delete(spec)
    return await driver.launch(spec)
  }
  async resume(session: BackendSession, spec: LaunchSpec): Promise<RunningTurn> {
    const driver = this.prepared.get(spec)
    if (!driver || driver.backend !== session.backend) throw new Error('Session backend does not match its prepared spec')
    this.prepared.delete(spec)
    return await driver.resume(session, spec)
  }
}
