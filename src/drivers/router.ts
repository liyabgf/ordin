import type { BackendKind, BackendSession, DriverHealth, LaunchSpec, RunningTurn, WorkerDriver, WorkerSpec } from './types.ts'

/** New work follows settings; prepared work and persisted sessions retain their backend. */
export class DriverRouter implements WorkerDriver {
  private readonly prepared = new WeakMap<LaunchSpec, WorkerDriver>()
  constructor(private readonly drivers: Readonly<Record<BackendKind, WorkerDriver>>, private readonly selected: () => BackendKind) {}
  get backend(): BackendKind { return this.selected() }
  probe(backend = this.selected()): Promise<DriverHealth> { return this.drivers[backend].probe() }
  async prepare(spec: WorkerSpec, session?: BackendSession): Promise<LaunchSpec> {
    if (spec.mcpReport !== undefined) throw new Error("Tool registration is not supported by Ordin’s worker router")
    const driver = this.drivers[session?.backend ?? spec.backend ?? this.selected()]
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
    if (driver !== this.drivers[session.backend]) throw new Error('Session backend does not match its prepared spec')
    this.prepared.delete(spec)
    return await driver.resume(session, spec)
  }
}
