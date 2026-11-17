import { randomUUID } from 'node:crypto'
import type { Store } from './store.ts'
import type { Ticket } from '../core/model.ts'

export interface Conversation extends Record<string, unknown> {
  id: string; profileId: string; title: string; createdAt: string; lastMessageAt: string
  archivedAt?: string; deletedAt?: string; revision: number
}
export class ConversationError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'ConversationError' }
}
export function conversationLimit(value: number | undefined, fallback = 50): number {
  const limit = value ?? fallback
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new ConversationError(400, 'limit must be an integer from 1 to 500')
  return limit
}
/** Re-read on every selection/turn; a reference never grants durable access. */
export function taskSelectionAllowed(store: Store, ticket: Ticket): boolean {
  const owner = (ticket as Ticket & { ownerProfileId?: unknown }).ownerProfileId
  if (ticket.deleted !== undefined || (owner !== undefined && owner !== 'default')) return false
  if (ticket.conversationId === undefined) return true
  return typeof ticket.conversationId === 'string' && store.conversations.get(ticket.conversationId)?.profileId === 'default'
}
export class Conversations {
  constructor(private readonly store: Store) {}
  create(input: { title?: unknown; profileId?: unknown } = {}): Conversation {
    if (input.profileId !== undefined && input.profileId !== 'default') throw new ConversationError(403, 'Conversation access denied by default Profile policy')
    const at = new Date().toISOString()
    const row: Conversation = { id: randomUUID(), profileId: 'default', title: input.title === undefined ? 'New conversation' : this.title(input.title), createdAt: at, lastMessageAt: at, revision: 1 }
    this.store.conversations.save(row)
    return row
  }
  fromTask(input: { ticketId: unknown; title?: unknown }): Conversation {
    if (typeof input.ticketId !== 'string' || input.ticketId.trim() === '') throw new ConversationError(400, 'ticketId must be a non-empty string')
    if (Object.prototype.hasOwnProperty.call(input, 'taskRefs')) throw new ConversationError(400, 'taskRefs is server-controlled')
    const ticketId = input.ticketId
    return this.store.atomic(() => {
      const ticket = this.store.tickets.get(ticketId)
      if (ticket === undefined || ticket.deleted !== undefined) throw new ConversationError(404, 'Task not found')
      if (!taskSelectionAllowed(this.store, ticket)) throw new ConversationError(403, 'Task access denied by default Profile policy')
      const title = input.title === undefined ? (typeof ticket.title === 'string' ? ticket.title.slice(0, 200) : 'Task conversation') : this.title(input.title)
      const at = new Date().toISOString()
      const row: Conversation = { id: randomUUID(), profileId: 'default', title, createdAt: at, lastMessageAt: at, revision: 1, taskRefs: [ticket.id] }
      this.store.conversations.save(row)
      return row
    })
  }
  list(options: { limit?: number; includeArchived?: boolean; profileId?: string } = {}): Conversation[] {
    if (options.profileId !== undefined && options.profileId !== 'default') throw new ConversationError(403, 'Conversation access denied by default Profile policy')
    return this.store.conversations.list({ ...options, profileId: 'default', limit: conversationLimit(options.limit) }) as Conversation[]
  }
  get(id: string): Conversation {
    const row = this.store.conversations.get(id)
    if (row === undefined || row.profileId !== 'default') throw new ConversationError(404, 'Conversation not found under default Profile policy')
    return row as Conversation
  }
  assertWritable(id: string, allowNew = false): void {
    if (allowNew && this.store.conversations.get(id) === undefined) return
    const row = this.get(id)
    if (row.deletedAt !== undefined) throw new ConversationError(410, 'Conversation is deleted')
    if (row.archivedAt !== undefined) throw new ConversationError(409, 'Restore the archived conversation before sending messages')
  }
  rename(id: string, title: unknown, expectedRevision: unknown): Conversation { return this.change(id, expectedRevision, { title: this.title(title) }) }
  archive(id: string, expectedRevision: unknown): Conversation { return this.change(id, expectedRevision, { archivedAt: new Date().toISOString() }) }
  restore(id: string, expectedRevision: unknown): Conversation { return this.change(id, expectedRevision, { archivedAt: undefined }) }
  delete(id: string, expectedRevision: unknown): Conversation { return this.change(id, expectedRevision, { deletedAt: new Date().toISOString() }) }
  messages(id: string, options: { limit?: number; before?: string; since?: string } = {}): { messages: Record<string, unknown>[]; nextCursor?: string } {
    if (this.store.conversations.get(id) === undefined) return { messages: [] }
    this.get(id)
    return this.store.conversationMessages.page(id, { ...options, limit: conversationLimit(options.limit, 100) })
  }
  private title(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) throw new ConversationError(400, 'title must contain 1 to 200 characters')
    return value.trim()
  }
  private change(id: string, expectedRevision: unknown, patch: Partial<Conversation>): Conversation {
    if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1) throw new ConversationError(400, 'expectedRevision must be a positive integer')
    const row = this.get(id)
    if (row.deletedAt !== undefined) throw new ConversationError(410, 'Conversation is deleted')
    if (row.revision !== expectedRevision) throw new ConversationError(409, 'Conversation revision conflict')
    const next = { ...row, ...patch, revision: row.revision + 1 }
    this.store.conversations.save(next)
    return next
  }
}
