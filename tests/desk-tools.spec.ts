/**
 * desk-tools: LlmToolSchema 投影 + 工具调用执行。
 * 迁入自 ordin tests/desk-tools.spec.ts：Cordis 仅类型断言换成 ordin 本地类型，
 * ToolsHost 桩换成 tests/tools.spec.ts 同款（真 Engine + 真 Store，IO 桩化），绝不触网。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DESK_GATE_TOOL_NAME, deskGateToolSchema, deskToolSchemas, executeDeskToolCalls } from '../src/app/desk-tools.ts'
import type { LlmToolSchema } from '../src/desk/llm.ts'
import { Store } from '../src/app/store.ts'
import { mainTools, type Tool, type ToolsHost } from '../src/app/tools.ts'
import {
  Engine, parseSettings, settingsPolicy, type Assignment, type Mandate, type Settings, type Ticket,
} from '../src/core/index.ts'
import { tempDir } from './helpers/temp.ts'

interface Harness {
  readonly store: Store
  readonly engine: Engine
  readonly toolsHost: ToolsHost
  readonly settings: () => Settings
}

/** 与 tests/tools.spec.ts 同款最小夹具：真 Engine 鉴权，IO 全桩。 */
function harness(): Harness {
  const directory = tempDir('ordin-desk-tools-')
  const store = new Store(join(directory, 'tools.sqlite3'))
  const current = parseSettings({ acceptMode: 'auto', allowedSenders: ['operator'] })
  const engine = new Engine({
    repos: store, tx: store, policy: () => settingsPolicy(current),
    executor: {
      prepare: (ticket: Ticket, _mandate: Mandate) => ticket,
      start: (ticket: Ticket, assignment: Assignment) => { engine.assignmentStarted(ticket.id, assignment.id) },
      deliver: () => {},
      stop: () => {},
    },
    delivery: { report: () => {} },
    now: () => '2026-11-03T02:00:00.000Z',
  })
  const unexpectedIO = (): never => { throw new Error('this test does not exercise host IO') }
  const toolsHost: ToolsHost = {
    engine, store, acceptMode: () => current.acceptMode,
    attempt: ticketId => store.tickets.get(ticketId)?.assignments.find(item => item.state === 'running')?.id,
    askDesk: unexpectedIO,
    readArtifact: unexpectedIO,
    raiseDecision: unexpectedIO,
    returnAddressOf: unexpectedIO,
    replyToRequester: unexpectedIO,
    promoteSkill: unexpectedIO,
  }
  return { store, engine, toolsHost, settings: () => current }
}

describe('desk-tools', () => {
  it('produces an LlmToolSchema for every registered main tool', () => {
    const schemas: readonly LlmToolSchema[] = deskToolSchemas(harness().toolsHost)
    expect(schemas.length).toBeGreaterThan(5)
    for (const s of schemas) {
      expect(typeof s.name).toBe('string')
      expect(typeof s.description).toBe('string')
      expect(s.parameters).toBeTypeOf('object')
      expect(s.parameters.type).toBe('object')
    }
  })

  it('every schema parameters is lossless JSON (no undefined values)', () => {
    const schemas = deskToolSchemas(harness().toolsHost)
    for (const s of schemas) {
      const round = JSON.parse(JSON.stringify(s.parameters))
      expect(round).toEqual(s.parameters)
    }
  })

  it('executes ordin_list_tickets against a real Engine and Store with schema defaults', async () => {
    const { store, engine, toolsHost } = harness()
    const created = engine.createTicket({ title: 'Desk bridge success', text: 'List this real ticket' })
    expect(created.disposition.state).toBe('accepted')
    expect(created.ticketId).toBeTruthy()

    const results = await executeDeskToolCalls(
      [{ id: 'tc-list', name: 'ordin_list_tickets', arguments: '{}' }],
      toolsHost,
      new AbortController().signal,
    )

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      toolCallId: 'tc-list', name: 'ordin_list_tickets', isError: false,
    })
    expect(JSON.parse(results[0]!.content)).toMatchObject({
      count: 1, state: 'open',
      tickets: [{ id: created.ticketId, title: 'Desk bridge success' }],
    })
  })

  it('executes an unknown tool call without throwing', async () => {
    const results = await executeDeskToolCalls(
      [{ id: 'tc-1', name: 'nonexistent_tool', arguments: '{}' }],
      harness().toolsHost,
      new AbortController().signal,
    )
    expect(results[0]!.isError).toBe(true)
    expect(results[0]!.content).toContain('Unknown tool')
  })

  it('executes a tool call with bad JSON arguments without throwing', async () => {
    const results = await executeDeskToolCalls(
      [{ id: 'tc-1', name: 'ordin_list_tickets', arguments: 'not-json' }],
      harness().toolsHost,
      new AbortController().signal,
    )
    expect(results[0]!.isError).toBe(true)
  })
})

/**
 * 【R3】Gateway tool schema: the lightweight zero-parameter tool that mounts the full toolset on demand.
 */
describe('deskGateToolSchema (R3)', () => {
  it('has the correct name and empty parameters', () => {
    const gate = deskGateToolSchema()
    expect(gate.name).toBe(DESK_GATE_TOOL_NAME)
    expect(gate.name).toBe('ordin_use_tools')
    expect(JSON.parse(JSON.stringify(gate.parameters))).toEqual({
      type: 'object', properties: {}, additionalProperties: false,
    })
  })

  it('is not in the full deskToolSchemas — it is the gateway, not a desk tool', () => {
    const names = deskToolSchemas(harness().toolsHost).map(s => s.name)
    expect(names).not.toContain(DESK_GATE_TOOL_NAME)
    // 真工具确实在里面（网关描述的名单不是空头支票）。
    expect(names).toContain('ordin_list_tickets')
  })
})
