import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AssetObjects } from './asset-objects.ts'
import { validateAssetRefs, type AssetRef } from '../core/model.ts'
import type { Store } from './store.ts'

type Row = Record<string, unknown>
type SavedAsset = Parameters<Store['assets']['save']>[0]
export class AssetCatalogError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message) }
}
const kind = z.enum(['document', 'dataset', 'report', 'code', 'reference'])
const tags = z.array(z.string().trim().min(1).max(64)).max(20)
const expectedRevision = z.number().int().positive().optional()
const importSchema = z.object({
  text: z.string().min(1).refine(value => Buffer.byteLength(value, 'utf8') <= 1_048_576, 'Content exceeds 1MB'),
  name: z.string().trim().min(1).max(200), description: z.string().max(2000).default(''),
  kind, tags: tags.default([]),
  mimeType: z.enum(['text/plain', 'text/markdown', 'application/json', 'text/csv', 'text/tab-separated-values']).default('text/plain'),
  contentKind: z.enum(['text', 'data']).default('text'), ownerProfileId: z.literal('default').optional(),
}).strict()
const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(), description: z.string().max(2000).optional(),
  tags: tags.optional(), archived: z.boolean().optional(), expectedRevision,
}).strict().refine(value => Object.keys(value).some(key => key !== 'expectedRevision'), 'An edit is required')
const revision = (row: Row): number => typeof row.revision === 'number' ? row.revision : 1
const record = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const history = (row: Row): Row[] => Array.isArray(row.revisions) ? row.revisions.map(record) : []
const snapshot = (row: Row): Row => { const { revisions: _history, ...rest } = row; return structuredClone({ ...rest, revision: revision(row) }) }

/** DB JSON content is authoritative. Filesystem projection and Coordinator reuse are separate contracts. */
export class AssetCatalog {
  constructor(private readonly store: Store, private readonly stateDir: string) {}
  private access(row: Row): boolean {
    if ((row.ownerProfileId ?? 'default') !== 'default') return false
    // Independent managed content has its own explicit owner; source Ticket is provenance only.
    if (row.ownerProfileId === 'default' && row.storageVersion === 1 && record(row.storage).kind === 'managed-object') return true
    const ticketId = record(row.source).ticketId
    if (ticketId === undefined) return true
    if (typeof ticketId !== 'string') return false
    const ticket = this.store.tickets.get(ticketId)
    return ticket !== undefined && ticket.deleted === undefined &&
      (ticket.conversationId === undefined || this.store.conversations.get(ticket.conversationId)?.profileId === 'default')
  }
  private view(row: Row): Row {
    const { content: _content, revisions: _history, importFingerprint: _fingerprint, ...rest } = row
    const source = record(row.source)
    // Expose provenance and acceptance without disclosing raw filesystem paths.
    const { path: _path, ...publicSource } = source
    const ticket = typeof source.ticketId === 'string' ? this.store.tickets.get(source.ticketId) : undefined
    const storage = record(row.storage)
    return { ...rest, revision: revision(row), managed: storage.kind === 'managed-object' || typeof row.content === 'string', size: storage.size ?? (typeof row.content === 'string' ? Buffer.byteLength(row.content) : undefined), mimeType: storage.mimeType ?? row.mimeType, description: row.description || '任务交付物', source: { ...publicSource, ...(typeof source.ticketId === 'string' ? { ticketTitle: ticket?.title, availability: ticket === undefined ? 'missing' : ticket.deleted ? 'deleted' : 'available' } : {}) } }
  }
  private require(id: string): Row {
    const row = this.store.assets.get(id)
    if (row === undefined) throw new AssetCatalogError(404, 'Asset unavailable')
    if (!this.access(row)) throw new AssetCatalogError(403, 'Asset source access denied')
    return row
  }
  list(query: URLSearchParams): Row[] {
    const filter = z.object({ query: z.string().max(200).optional(), kind: kind.optional(), includeArchived: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).strict().parse(Object.fromEntries(query))
    const needle = filter.query?.trim().toLowerCase()
    return this.store.assets.list({ includeArchived: filter.includeArchived === 'true', ...(filter.kind === undefined ? {} : { kind: filter.kind }), limit: 2_147_483_647 })
      .filter(row => this.access(row) && row.deletedAt === undefined && row.deleted === undefined)
      .filter(row => needle === undefined || [row.name, row.description, ...(Array.isArray(row.tags) ? row.tags : [])].some(value => String(value ?? '').toLowerCase().includes(needle)))
      .slice(0, filter.limit).map(row => this.view(row))
  }
  /** Trusted service only: managed DB content, never a filesystem path. Public views omit content. */
  resolve(input: unknown): { ref: AssetRef; content: string } {
    const requested = typeof input === 'string' ? { id: input } : record(input)
    if (Object.keys(requested).some(key => !['id', 'revision', 'contentHash'].includes(key)) || typeof requested.id !== 'string') throw new AssetCatalogError(400, 'Invalid asset reference')
    const row = this.require(requested.id)
    if (row.archived === true || row.deletedAt !== undefined || row.deleted !== undefined || row.status !== 'active') throw new AssetCatalogError(409, 'Asset unavailable: inactive, archived or deleted')
    if (record(row.source).type !== 'operator-import' || record(row.source).actor !== 'operator') throw new AssetCatalogError(403, 'Explicit operator import required')
    const selected = requested.revision === undefined || requested.revision === revision(row) ? row : history(row).find(item => item.revision === requested.revision)
    if (selected === undefined) throw new AssetCatalogError(409, 'Asset revision unavailable')
    const ref = validateAssetRefs([{ id: row.id, revision: revision(selected), contentHash: selected.contentHash }])[0]!
    if (requested.contentHash !== undefined && requested.contentHash !== ref.contentHash) throw new AssetCatalogError(409, 'Asset hash mismatch')
    if (typeof selected.content !== 'string' || createHash('sha256').update(selected.content, 'utf8').digest('hex') !== ref.contentHash) throw new AssetCatalogError(409, 'Asset content hash mismatch')
    return { ref, content: selected.content }
  }
  /** Metadata pinning is synchronous; object bytes must still be checked before dispatch. */
  resolveMetadata(input: unknown): { ref: AssetRef; filename: string } {
    const requested = typeof input === 'string' ? { id: input } : record(input)
    if (Object.keys(requested).some(key => !['id','revision','contentHash'].includes(key)) || typeof requested.id !== 'string') throw new AssetCatalogError(400, 'Invalid asset reference')
    const row = this.require(requested.id)
    if (row.archived === true || row.deletedAt !== undefined || row.deleted !== undefined || row.status !== 'active') throw new AssetCatalogError(409, 'Asset unavailable: inactive, archived or deleted')
    const selected = requested.revision === undefined || requested.revision === revision(row) ? row : history(row).find(item => item.revision === requested.revision)
    if (!selected) throw new AssetCatalogError(409, 'Asset revision unavailable')
    const storage = record(selected.storage)
    if (!(row.ownerProfileId === 'default' && selected.storageVersion === 1 && storage.kind === 'managed-object') && !(record(selected.source).type === 'operator-import' && record(selected.source).actor === 'operator')) throw new AssetCatalogError(403, 'Managed object or explicit operator import required')
    const ref = validateAssetRefs([{id:row.id,revision:revision(selected),contentHash:selected.contentHash}])[0]!
    if (requested.contentHash !== undefined && requested.contentHash !== ref.contentHash) throw new AssetCatalogError(409, 'Asset hash mismatch')
    const extension = String(record(selected.source).path ?? selected.name ?? '').match(/\.([a-zA-Z0-9]{1,10})$/)?.[1]?.toLowerCase()
    return {ref, filename:'asset-'+ref.id+'-r'+ref.revision+'.'+(extension ?? 'txt')}
  }
  async resolveBytes(input: unknown): Promise<{ref:AssetRef;filename:string;bytes:Buffer}> {
    const pinned = this.resolveMetadata(input)
    const row = this.require(pinned.ref.id)
    const selected = pinned.ref.revision === revision(row) ? row : history(row).find(item=>item.revision===pinned.ref.revision)!
    const storage = record(selected.storage)
    const bytes = storage.kind === 'managed-object' && selected.storageVersion === 1 && typeof storage.objectKey === 'string'
      ? await new AssetObjects(this.stateDir).read(storage.objectKey)
      : typeof selected.content === 'string' ? Buffer.from(selected.content,'utf8') : undefined
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== pinned.ref.contentHash) throw new AssetCatalogError(409,'Asset content hash mismatch')
    // Awaiting filesystem IO is a revocation window: enforce current state and pinned identity again.
    this.resolveMetadata(pinned.ref)
    return {...pinned,bytes}
  }
  private async storedContent(row: Row) {
    if (row.deletedAt !== undefined || row.deleted !== undefined) throw new AssetCatalogError(409, 'Asset is deleted')
    const storage = record(row.storage)
    let bytes: Buffer
    if (storage.kind === 'managed-object' && row.storageVersion === 1 && typeof storage.objectKey === 'string') bytes = await new AssetObjects(this.stateDir).read(storage.objectKey)
    else if (record(row.source).type === 'operator-import' && typeof row.content === 'string') bytes = Buffer.from(row.content, 'utf8')
    else throw new AssetCatalogError(409, '此旧资产尚未独立保存，请从源任务重新归档')
    if (createHash('sha256').update(bytes).digest('hex') !== row.contentHash) throw new AssetCatalogError(409, 'Asset content hash mismatch')
    const mimeType = String(storage.mimeType ?? row.mimeType ?? 'application/octet-stream')
    const text = mimeType.startsWith('text/') || ['application/json','application/xml'].includes(mimeType)
    return { bytes, mimeType, text }
  }
  async content(id: string): Promise<{path:string; text:boolean; base64:string; mimeType:string; size:number}> {
    const row = this.require(id)
    const { bytes, mimeType, text } = await this.storedContent(row)
    return { path: String(row.name), text, base64: bytes.toString('base64'), mimeType, size: bytes.length }
  }
  async descriptionSample(id: string, expected: number) {
    const row = this.require(id)
    this.assertDescriptionRevision(id, expected, row.contentHash)
    const { bytes, text } = await this.storedContent(row)
    this.assertDescriptionRevision(id, expected, row.contentHash)
    if (!text || bytes.includes(0)) throw new AssetCatalogError(409, '仅支持文本资产的说明建议')
    const sample = new TextDecoder().decode(bytes.subarray(0, 8192), { stream: bytes.length > 8192 }).trim()
    if (!sample) throw new AssetCatalogError(409, '没有可供整理的文本')
    return { sample, revision: revision(row), contentHash: row.contentHash }
  }
  assertDescriptionRevision(id: string, expected: number, hash: unknown): void {
    const row = this.require(id)
    if (row.archived || row.deletedAt !== undefined || row.deleted !== undefined || revision(row) !== expected || row.contentHash !== hash) {
      throw new AssetCatalogError(409, '资产版本或状态已变化，请刷新后重试')
    }
  }
  /** Only explicit provenance and pinned references; no inferred use or semantic scores. */
  relations(id: string): { related: Row[]; references: Row[] } {
    const asset = this.require(id)
    if (asset.deletedAt !== undefined || asset.deleted !== undefined) throw new AssetCatalogError(409, 'Asset is deleted')
    const sourceId = record(asset.source).ticketId
    const related: Row[] = typeof sourceId === 'string' ? this.store.assets.list({ includeArchived: true, limit: 2_147_483_647 })
      .filter(row => row.id !== id && row.deletedAt === undefined && row.deleted === undefined && this.access(row) && record(row.source).ticketId === sourceId)
      .slice(0, 50).map(row => ({ id: row.id, name: row.name, revision: revision(row), kind: row.kind, reason: '同一任务产出' })) : []
    const coSelected = new Map<string, number>()
    const references = this.store.tickets.list()
      .filter(ticket => ticket.deleted === undefined && (ticket.conversationId === undefined || this.store.conversations.get(ticket.conversationId)?.profileId === 'default'))
      .flatMap(ticket => {
        const ids = new Set((ticket.assetRefs ?? []).map(ref => ref.id))
        for (const input of ticket.inputs) {
          if (input.kind === 'note') for (const ref of input.assetRefs ?? []) ids.add(ref.id)
        }
        if (!ids.has(id)) return []
        for (const peer of ids) {
          if (peer !== id) coSelected.set(peer, (coSelected.get(peer) ?? 0) + 1)
        }
        const ended = ticket.ended !== undefined
        const selected = (ticket.assetRefs ?? []).filter(ref => ref.id === id).map(ref => ({
          ticketId: ticket.id, title: ticket.title, revision: ref.revision, contentHash: ref.contentHash,
          state: 'selected', ended, reason: '任务选择了此版本；不代表已读取或使用成功',
        }))
        const additions = ticket.inputs.flatMap(input => {
          if (input.kind !== 'note' || !input.assetRefs) return []
          const state = input.deliveredAt !== undefined ? 'delivered' : ended ? 'not-delivered' : 'queued'
          const reason = state === 'delivered' ? '已送达执行端；不代表已读取或使用成功'
            : state === 'not-delivered' ? '任务结束时尚未送达' : '已保存待投递'
          return input.assetRefs.filter(ref => ref.id === id).map(ref => ({
            ticketId: ticket.id, title: ticket.title, inputId: input.id, revision: ref.revision,
            contentHash: ref.contentHash, state, ended, reason,
          }))
        })
        return [...selected, ...additions]
      })
      .slice(0, 100)
    const seen = new Set(related.map(row => row.id))
    for (const [peer, taskCount] of [...coSelected].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))) {
      if (related.length === 50) break
      if (seen.has(peer)) continue
      const row = this.store.assets.get(peer)
      if (!row || row.archived === true || row.deletedAt !== undefined || row.deleted !== undefined || !this.access(row)) continue
      if (typeof row.id !== 'string') continue
      related.push({ id: row.id, name: row.name, revision: revision(row), kind: row.kind, taskCount, reason: '曾在 ' + taskCount + ' 个任务中共同选用；不代表已使用' })
    }
    return { related, references }
  }
  get(id: string): Row { return this.view(this.require(id)) }
  revisions(id: string): Row[] { const row = this.require(id); return [...history(row), snapshot(row)].map(value => this.view(value)) }
  import(input: unknown): Row {
    const parsed = importSchema.parse(input)
    const hash = createHash('sha256').update(parsed.text, 'utf8').digest('hex')
    const fingerprint = JSON.stringify([hash, parsed.name, parsed.description, parsed.kind, parsed.tags, parsed.mimeType, parsed.contentKind])
    return this.store.atomic(() => {
      const found = this.store.assets.list({ includeArchived: true, limit: 2_147_483_647 }).find(row => record(row.source).type === 'operator-import' && row.ownerProfileId === 'default' && row.importFingerprint === fingerprint && this.access(row))
      if (found !== undefined) {
        if (found.deletedAt !== undefined || found.deleted !== undefined) throw new AssetCatalogError(409, 'Asset is deleted')
        return this.view(found)
      }
      const at = new Date().toISOString()
      const { text, ...metadata } = parsed
      const row = { ...metadata, id: 'asset-' + randomUUID(), ownerProfileId: 'default', source: { type: 'operator-import', actor: 'operator', at }, contentHash: hash, importFingerprint: fingerprint, content: text, createdAt: at, updatedAt: at, accessLevel: 'private', revision: 1, status: 'active', archived: false, usageCount: 0, revisions: [], audit: [{ action: 'import', actor: 'operator', at, revision: 1 }] }
      this.store.assets.save(row)
      return this.view(row)
    })
  }
  private change(id: string, expected: number | undefined, action: string, mutate: (row: Row, at: string) => Row): Row {
    return this.store.atomic(() => {
      const row = this.require(id)
      if (row.deletedAt !== undefined || row.deleted !== undefined) throw new AssetCatalogError(409, 'Asset is deleted')
      if (record(row.source).type !== 'operator-import' && !(row.storageVersion === 1 && record(row.storage).kind === 'managed-object')) throw new AssetCatalogError(409, 'Legacy Ticket assets are immutable here')
      if (expected !== undefined && revision(row) !== expected) throw new AssetCatalogError(409, 'Asset revision conflict')
      const at = new Date().toISOString()
      const prior = snapshot(row)
      const next = { ...mutate(row, at), revision: revision(row) + 1, updatedAt: at, revisions: [...history(row), prior], audit: [...(Array.isArray(row.audit) ? row.audit : []), { action, actor: 'operator', at, revision: revision(row) + 1 }] }
      this.store.assets.save(next as unknown as SavedAsset)
      return this.view(next)
    })
  }
  patch(id: string, input: unknown): Row {
    const { expectedRevision: expected, ...changes } = patchSchema.parse(input)
    return this.change(id, expected, 'patch', row => ({ ...row, ...changes }))
  }
  delete(id: string, input: unknown): Row {
    const parsed = z.object({ expectedRevision }).strict().parse(input)
    return this.change(id, parsed.expectedRevision, 'delete', (row, at) => {
      // Until typed assetRefs arrive, inspect explicit JSON reference fields only, recursively.
      const references = (value: unknown): boolean => {
        if (Array.isArray(value)) return value.some(references)
        const entry = record(value)
        return Object.entries(entry).some(([key, item]) => {
          if (key === 'assetId') return item === id
          if (key === 'assetRefs' || key === 'assetIds') return Array.isArray(item) && item.some(ref => ref === id || record(ref).id === id || record(ref).assetId === id)
          return typeof item === 'object' && item !== null && references(item)
        })
      }
      if (this.store.tickets.open().some(ticket => ticket.deleted === undefined && references(ticket)) || this.store.works.list().some(work => work.archivedAt === undefined && references(work))) throw new AssetCatalogError(409, 'Asset is referenced by an active Ticket or Work')
      return { ...row, archived: true, deletedAt: at, deleted: { actor: 'operator', at } }
    })
  }
}
