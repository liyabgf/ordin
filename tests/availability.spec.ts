import { describe, expect, it } from 'vitest'
import { AvailableDriver } from '../src/drivers/availability.ts'
import { HealthEntry } from '../src/app/health.ts'
import type { DriverHealth, WorkerDriver, WorkerSpec } from '../src/drivers/types.ts'

const spec: WorkerSpec = { ticketId: 't', assignmentId: 'a', cwd: '/tmp', prompt: 'hello', access: 'edit' }
describe('execution availability', () => {
  it('shows non-blocking capability warnings in health detail', async () => {
    const health = new HealthEntry()
    const inner = { backend: 'dsh', probe: async () => ({ backend: 'dsh', ok: true, auth: 'unknown', checkedAt: '', problems: [], warnings: ['degraded_capability: backend permissions'] }) } as unknown as WorkerDriver
    expect((await new AvailableDriver(inner, health).probe()).ok).toBe(true)
    expect(health.snapshot().detail).toContain('degraded_capability')
  })
  it('keeps missing tools visible, rejects execution, and permits recovery on retry', async () => {
    let ok = false
    let prepared = 0
    const inner: WorkerDriver = {
      backend: 'dsh',
      probe: async (): Promise<DriverHealth> => ({ backend: 'dsh', ok, auth: 'unknown', checkedAt: '', problems: ok ? [] : ['not installed'] }),
      prepare: async s => { prepared++; return { ...s, preparedAt: '' } },
      launch: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') },
    }
    const health = new HealthEntry()
    const driver = new AvailableDriver(inner, health)
    await expect(driver.prepare(spec)).rejects.toThrow('not installed')
    expect(prepared).toBe(0)
    expect(health.snapshot().ok).toBe(false)
    ok = true
    expect(await driver.prepare(spec)).toMatchObject(spec)
    expect(prepared).toBe(1)
    expect(health.snapshot().ok).toBe(true)
  })
  it('contains probe exceptions as unavailable health', async () => {
    const inner = { backend: 'dsh', probe: async () => { throw new Error('probe crashed') } } as unknown as WorkerDriver
    const health = new HealthEntry()
    expect(await new AvailableDriver(inner, health).probe()).toMatchObject({ ok: false, problems: ['probe crashed'] })
    expect(health.snapshot().detail).toContain('probe crashed')
  })
})
