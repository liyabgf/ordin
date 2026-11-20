import { describe, expect, it } from 'vitest'
import { bindToolPath, toolRisk } from '../src/app/tool-registry.ts'
import { COORDINATOR_TOOLS } from '../src/app/coordinator.ts'

describe('tool path registry', () => {
  it('rejects missing, duplicate and foreign bindings without silently dropping them', () => {
    expect(bindToolPath('coordinator', COORDINATOR_TOOLS)).toEqual(COORDINATOR_TOOLS)
    expect(() => bindToolPath('coordinator', COORDINATOR_TOOLS.slice(1))).toThrow('Missing tool binding')
    expect(() => bindToolPath('coordinator', [...COORDINATOR_TOOLS, COORDINATOR_TOOLS[0]!])).toThrow('Invalid tool binding')
    expect(() => bindToolPath('coordinator', [...COORDINATOR_TOOLS, { name: 'ordin_report' }])).toThrow('Invalid tool binding')
    expect(() => bindToolPath('worker', COORDINATOR_TOOLS)).toThrow('Invalid tool binding')
  })
  it('retains explicit read/write/control boundaries across paths', () => {
    expect(toolRisk('coordinator', 'asset_read_sample')).toBe('read')
    expect(toolRisk('coordinator', 'recipe_list')).toBe('read')
    expect(toolRisk('coordinator', 'recipe_get')).toBe('read')
    expect(toolRisk('coordinator', 'attach_asset_to_task')).toBe('write')
    expect(toolRisk('coordinator', 'cancel_or_pause_task')).toBe('control')
    expect(toolRisk('desk', 'ordin_retry_ticket')).toBe('control')
    expect(toolRisk('worker', 'ordin_read_artifact')).toBe('read')
    for (const name of ['asset_read_sample', 'attach_asset_to_task', 'create_task', 'inspect_runtime']) expect(toolRisk('worker', name)).toBeUndefined()
    expect(toolRisk('desk', 'skill_get')).toBeUndefined()
    expect(toolRisk('desk', 'recipe_get')).toBeUndefined()
    expect(toolRisk('worker', 'recipe_list')).toBeUndefined()
    expect(toolRisk('coordinator', 'ordin_retry_ticket')).toBeUndefined()
    expect(toolRisk('coordinator', 'constructor')).toBeUndefined()
  })
})
