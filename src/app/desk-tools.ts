/**
 * Desk 工具桥：把 mainTools 的定义投影成 LLM 原生 function-calling 的 schema，
 * 并执行模型返回的工具调用。
 *
 * 迁入来源：ordin/src/app/desk-tools.ts。唯一的语义外变化是类型来源：
 * ToolSchema 从 dsh-llm（已随 Cordis 一并移除）换成 src/desk/llm.ts 的 LlmToolSchema ——
 * 字段形状一致（name/description/parameters），执行路径不变：仍然调用 PTC 时代
 * 同一个 definition.execute，工具本体一行不改。
 *
 * 执行纪律：executeDeskToolCalls 永不 throw —— 工具失败记进结果内容的 isError，
 * 由 DeskLoop 决定这轮算不算成功；未知工具与坏 JSON 参数也都是工具结果，不是异常。
 */
import type { DeskToolCall } from './desk-history.ts'
import type { LlmToolSchema } from '../desk/llm.ts'
import { definitionOf, mainTools, type ToolsHost } from './tools.ts'

// ── types ─────────────────────────────────────────────────────────────────────────────────

export interface ToolCallResult {
  toolCallId: string
  name: string
  /** JSON-serialisable result, or an error message string. */
  content: string
  isError: boolean
}

// ── schema projection ─────────────────────────────────────────────────────────────────────

/**
 * 【R3】轻量网关工具的名字：首轮只挂它，模型需要真工具时调用它，下一轮挂全量。
 * 导出常量而不是字符串字面量，让 desk-loop.ts 拦截它时不用重复拼写。
 */
export const DESK_GATE_TOOL_NAME = 'ordin_use_tools' as const

/**
 * 【R3】首轮用的零参数网关工具。
 *
 * 为什么：每一轮都带全部管理工具的 schema 很贵，而大多数 desk 消息（简单提问、
 * 确认通知）根本不需要工具 —— 模型可以一轮直答。只有模型决定要查票、派活、
 * 反问时才调用网关，DeskLoop 随之为下一轮挂上全量工具（0 ms，纯内存）。
 *
 * 每轮都有两条干净的出口 —— 不留悬空的分诊单，也不发明状态：
 *   1. 不调工具 → 模型直答。DeskLoop 调 settleDirectTriageAnswer() 经 engine.report(ready)
 *      把分诊单结掉并送达答案。
 *   2. 调 ordin_use_tools → 下一轮挂全量工具，模型正常用。
 */
export function deskGateToolSchema(): LlmToolSchema {
  return {
    name: DESK_GATE_TOOL_NAME,
    description:
      'Mount the full ordin desk toolset (ordin_list_tickets, ordin_ticket_status, '
      + 'ordin_recall, ordin_create_ticket, ordin_close_ticket, ordin_reply, '
      + 'ordin_note_ticket, ordin_answer_ticket, ordin_stop_ticket, '
      + 'ordin_retry_ticket, ordin_raise_decision). '
      + 'Call this ONLY when you need to query or modify Tickets, dispatch work, ask a '
      + 'clarifying question while keeping a triage Ticket open, or drop a non-request. '
      + 'If you can answer directly from context — a capability question, a greeting, '
      + 'acknowledging a completion notice — write your reply directly WITHOUT calling '
      + 'any tool. For a pending triage Ticket, your direct reply text is automatically '
      + 'delivered to the requester and closes the triage Ticket as ready.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  }
}

/**
 * 构建传给 deskLlmGenerate 的 schema 数组。
 * 与 DSH 会话路径共用同一个 host，因此鉴权规则完全一致。
 */
export function deskToolSchemas(host: ToolsHost): readonly LlmToolSchema[] {
  return mainTools(host).map(tool => {
    const def = definitionOf(tool)
    return { name: def.name, description: def.description, parameters: def.parameters }
  })
}

// ── execution ─────────────────────────────────────────────────────────────────────────────

/**
 * 执行模型这一轮返回的一批工具调用，按原顺序逐个给出结果。
 * 永不 throw —— 错误进结果的 content 与 isError，让模型看到失败并决定下一步。
 */
export async function executeDeskToolCalls(
  calls: readonly DeskToolCall[],
  host: ToolsHost,
  signal: AbortSignal,
): Promise<readonly ToolCallResult[]> {
  const tools = mainTools(host)
  const byName = new Map(tools.map(t => [t.name, t]))

  const results: ToolCallResult[] = []
  for (const call of calls) {
    const tool = byName.get(call.name)
    if (tool === undefined) {
      results.push({ toolCallId: call.id, name: call.name, content: `Unknown tool: ${call.name}`, isError: true })
      continue
    }
    try {
      let parsed: unknown
      try { parsed = JSON.parse(call.arguments) } catch {
        results.push({ toolCallId: call.id, name: call.name, content: `Could not parse arguments: ${call.arguments}`, isError: true })
        continue
      }
      const def = definitionOf(tool)
      const value = await def.execute(parsed, { signal })
      results.push({ toolCallId: call.id, name: call.name, content: JSON.stringify(value), isError: false })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      results.push({ toolCallId: call.id, name: call.name, content: msg, isError: true })
    }
  }
  return results
}
