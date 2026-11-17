/** Local trusted-operator lifecycle. No authenticated web principal is inferred here. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Store } from './store.ts'

export class MemoryError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message) }
}
const kind = z.enum(['preference', 'project-fact', 'task-lesson'])
const text = z.string().trim().min(1).max(10000)
const scope = z.string().trim().min(1).max(200)
const expiry = z.iso.datetime({ offset: true }).nullable()
const expectedRevision = z.number().int().positive().optional()
const proposal = z.object({ kind, content: text, scope: scope.default('global'), ownerProfileId: z.literal('default').optional(), sourceTicketId: scope.optional(), sourceMessageId: scope.optional(), expiresAt: expiry.optional() }).strict()
const edit = z.object({ content: text.optional(), scope: scope.optional(), expiresAt: expiry.optional(), expectedRevision }).strict().refine(v => v.content !== undefined || v.scope !== undefined || v.expiresAt !== undefined, 'An edit is required')
const confirmation = z.object({ expectedRevision }).strict()
type Entry = Record<string, unknown>

/** C2: legacy ownerless records belong to default, but foreign source/Work evidence never does. */
export function memoryAccessAllowed(store: Store, entry: Entry, conversationId?: string): boolean {
  if ((entry.ownerProfileId ?? 'default') !== 'default') return false
  if (conversationId !== undefined && store.conversations.get(conversationId)?.profileId !== 'default') return false
  const ticketAllowed = (ticket: ReturnType<Store['tickets']['get']>): boolean => ticket !== undefined && ticket.deleted === undefined && (ticket.conversationId === undefined || store.conversations.get(ticket.conversationId)?.profileId === 'default')
  if (entry.sourceTicketId !== undefined) {
    if (typeof entry.sourceTicketId !== 'string') return false
    const ticket = store.tickets.get(entry.sourceTicketId)
    if (!ticketAllowed(ticket) || (entry.scope !== 'global' && ticket?.workId !== entry.scope)) return false
  }
  if (entry.sourceMessageId !== undefined) {
    if (typeof entry.sourceMessageId !== 'string') return false
    if (!store.memory.sourceMessageAllowed(entry.sourceMessageId)) return false
  }
  if (entry.scope === 'global') return true
  if (typeof entry.scope !== 'string' || store.works.get(entry.scope) === undefined) return false
  const tasks = store.tickets.byWork(entry.scope)
  return tasks.length > 0 && tasks.every(ticketAllowed) && (conversationId === undefined || tasks.some(t => t.conversationId === conversationId))
}
export function memoryLive(entry: Entry, at = Date.now()): boolean {
  return entry.confidence === 'confirmed' && entry.deletedAt === undefined && entry.deleted === undefined && entry.deprecated !== true && entry.archived !== true && entry.status !== 'deprecated' && entry.status !== 'deleted' && (entry.expiresAt === undefined || entry.expiresAt === null || (typeof entry.expiresAt === 'string' && Number.isFinite(Date.parse(entry.expiresAt)) && Date.parse(entry.expiresAt) > at))
}
const revision = (row: Entry): number => typeof row.revision === 'number' ? row.revision : 1
const snapshot = (row: Entry): Entry => { const { revisions: _history, ...value } = row; return structuredClone({ ...value, revision: revision(row) }) }
const view = (row: Entry): Entry => ({ ...row, revision: revision(row), ...(row.confidence === 'confirmed' && row.confirmation === undefined ? { legacyConfirmationAudit: true } : {}) })

export class Memories {
  constructor(private readonly store: Store) {}
  list(query: URLSearchParams): Entry[] {
    const filter = z.object({ kind: kind.optional(), scope: scope.optional(), status: z.enum(['inferred', 'confirmed', 'deprecated', 'deleted']).optional(), includeExpired: z.enum(['true', 'false']).optional() }).strict().parse(Object.fromEntries(query))
    return this.store.memory.list({ ...(filter.kind === undefined ? {} : { kind: filter.kind }), ...(filter.scope === undefined ? {} : { scope: filter.scope }), limit: 100000 }).filter(row => memoryAccessAllowed(this.store, row))
      .filter(row => filter.status === 'deleted' ? row.deletedAt !== undefined : row.deletedAt === undefined && row.deleted === undefined)
      .filter(row => filter.status === undefined || filter.status === 'deleted' || (filter.status === 'deprecated' ? row.deprecated === true || row.status === 'deprecated' : row.confidence === filter.status))
      .filter(row => filter.includeExpired === 'true' || row.expiresAt === undefined || row.expiresAt === null || (typeof row.expiresAt === 'string' && Date.parse(row.expiresAt) > Date.now())).map(view)
  }
  propose(input: unknown, actor: 'operator' | 'model' = 'operator', conversationId?: string): Entry {
    const parsed = proposal.parse(input)
    if (!memoryAccessAllowed(this.store, parsed, conversationId)) throw new MemoryError(403, 'Memory scope or source access denied')
    const at = new Date().toISOString()
    const row = { ...parsed, id: 'mem-' + randomUUID(), ownerProfileId: 'default', createdAt: at, updatedAt: at, proposedAt: at, confidence: 'inferred', revision: 1, useCount: 0, revisions: [], audit: [{ action: 'propose', actor, at, revision: 1 }] }
    this.store.memory.save(row)
    return row
  }
  private require(id: string): Entry {
    const row = this.store.memory.get(id)
    if (row === undefined) throw new MemoryError(404, 'Memory unavailable')
    if (!memoryAccessAllowed(this.store, row)) throw new MemoryError(403, 'Memory scope or source access denied')
    return row
  }
  revisions(id: string): Entry[] {
    const row = this.require(id)
    return [...(Array.isArray(row.revisions) ? row.revisions : []), snapshot(view(row))]
  }
  private change(id: string, expected: number | undefined, action: string, mutate: (row: Entry, at: string) => Entry): Entry {
    return this.store.atomic(() => {
      const row = this.require(id)
      if (expected !== undefined && revision(row) !== expected) throw new MemoryError(409, 'Memory revision conflict')
      if (row.deletedAt !== undefined || row.deleted !== undefined) throw new MemoryError(409, 'Memory is deleted')
      const at = new Date().toISOString()
      const next = { ...mutate(row, at), revision: revision(row) + 1, updatedAt: at, revisions: [...(Array.isArray(row.revisions) ? row.revisions : []), snapshot(row)], audit: [...(Array.isArray(row.audit) ? row.audit : []), { action, actor: 'operator', at, revision: revision(row) + 1 }] }
      if (!memoryAccessAllowed(this.store, next)) throw new MemoryError(403, 'Memory scope or source access denied')
      this.store.memory.save(next as Parameters<Store['memory']['save']>[0])
      return view(next)
    })
  }
  confirm(id: string, input: unknown): Entry {
    const parsed = confirmation.parse(input)
    return this.change(id, parsed.expectedRevision, 'confirm', (row, at) => {
      if (row.confidence === 'confirmed') throw new MemoryError(409, 'Memory is already confirmed')
      if (row.deprecated === true || row.archived === true || row.status === 'deprecated' || (typeof row.expiresAt === 'string' && Date.parse(row.expiresAt) <= Date.now())) throw new MemoryError(409, 'Memory is inactive or expired')
      return { ...row, confidence: 'confirmed', confirmation: { actor: 'operator', at } }
    })
  }
  patch(id: string, input: unknown): Entry {
    const { expectedRevision: expected, ...changes } = edit.parse(input)
    return this.change(id, expected, 'edit', row => {
      const next: Entry = { ...row, ...changes }
      // Content correction revokes confirmation; only the explicit confirm endpoint may restore it.
      if (changes.content !== undefined && changes.content !== row.content) { next.confidence = 'inferred'; delete next.confirmation }
      if (Object.entries(changes).every(([key, value]) => row[key] === value)) throw new MemoryError(409, 'Memory edit has no changes')
      return next
    })
  }
  delete(id: string, input: unknown): Entry {
    const parsed = confirmation.parse(input)
    return this.change(id, parsed.expectedRevision, 'delete', (row, at) => ({ ...row, deletedAt: at, deleted: { actor: 'operator', at } }))
  }
}
