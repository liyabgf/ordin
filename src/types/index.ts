/**
 * Ordin v8 数据模型与协调工具类型契约。
 * 依据：docs/contracts/wp-0.1~0.4。冻结后变更须登记账本并同步受影响 WP。
 */
import type { BackendKind } from '../drivers/types.ts'

// ── Conversation（WP-0.2）──────────────────────────────────────────────

export interface ConversationChannel {
  readonly kind: string
  readonly externalId?: string
}

export interface Conversation {
  readonly id: string
  readonly profileId: string
  readonly channels: readonly ConversationChannel[]
  readonly createdAt: string
  readonly lastMessageAt: string
  readonly title?: string
}

export interface ConversationAction {
  readonly tool: string
  readonly args: unknown
  readonly result?: string
}

export interface ConversationMessage {
  readonly id: string
  readonly conversationId: string
  readonly role: 'user' | 'ordin' | 'system'
  readonly content: string
  readonly at: string
  readonly sourceChannel: ConversationChannel
  readonly actions?: readonly ConversationAction[]
}

// ── Asset（WP-0.2 / WP-7）────────────────────────────────────────────────

export type AssetKind = 'document' | 'dataset' | 'report' | 'code' | 'reference'
export type AssetAccessLevel = 'private' | 'project' | 'shared'

export interface Asset {
  readonly id: string
  readonly kind: AssetKind
  readonly name: string
  readonly description: string
  readonly source: { readonly ticketId?: string; readonly path: string; readonly externalUrl?: string; readonly acceptance?: TicketAcceptance }
  readonly createdAt: string
  readonly updatedAt: string
  readonly tags: readonly string[]
  readonly license?: string
  readonly accessLevel: AssetAccessLevel
  readonly contentHash?: string
  /** Content version within full Ticket + canonical path identity; absent on legacy assets. */
  readonly revision?: number
  readonly status?: 'active' | 'candidate'
  readonly usageCount: number
  readonly archived: boolean
}

// ── MemoryEntry（WP-0.2 / WP-9）─────────────────────────────────────────

export type MemoryKind = 'preference' | 'project-fact' | 'task-lesson'
export type MemoryConfidence = 'confirmed' | 'inferred' | 'deprecated'

export interface MemoryEntry {
  readonly id: string
  readonly kind: MemoryKind
  readonly content: string
  readonly scope: string
  readonly sourceTicketId?: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly confidence: MemoryConfidence
  readonly expiresAt?: string
  readonly useCount: number
}

// ── Ticket 扩展（WP-0.2 / WP-6）───────────────────────────────────────

export type AcceptanceStatus = 'pending' | 'accepted' | 'rework' | 'unverified'

export interface AcceptanceCheckResult {
  readonly name: string
  readonly passed: boolean
  readonly detail?: string
}

export interface TicketAcceptance {
  readonly status: AcceptanceStatus
  readonly checks?: readonly AcceptanceCheckResult[]
  readonly checkedAt?: string
  readonly reworkReason?: string
}

// ── Coordinator 工具合同（WP-0.3）────────────────────────────────────

export type CoordinatorToolName =
  | 'reply' | 'search_assets' | 'get_task_status' | 'list_my_tasks'
  | 'create_task' | 'add_task_input' | 'cancel_or_pause_task'
  | 'propose_memory' | 'clarify'

export interface CoordinatorToolCall {
  readonly tool: CoordinatorToolName
  readonly args: Record<string, unknown>
}

export interface CoordinatorToolResult {
  readonly tool: CoordinatorToolName
  readonly ok: boolean
  readonly data?: Record<string, unknown>
  readonly error?: string
}

// ── 验收检查器接口（WP-0.4 / WP-6.2）────────────────────────────────

export interface CheckResult {
  readonly passed: boolean
  readonly detail?: string
}

export interface AcceptanceCheck {
  readonly name: string
  run(directory: string, ticket: { readonly id: string; readonly execution?: { readonly directory?: string } }): Promise<CheckResult>
}
