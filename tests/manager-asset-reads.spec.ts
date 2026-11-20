import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AssetCatalog, AssetCatalogError } from '../src/app/asset-catalog.ts'
import { AssetObjects } from '../src/app/asset-objects.ts'
import { ASSET_READ_TOOLS, executeAssetRead } from '../src/app/manager-asset-reads.ts'
import { Store } from '../src/app/store.ts'
import type { Ticket } from '../src/core/model.ts'
import { tempDir } from './helpers/temp.ts'

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const pin = (id: string, content: string | Buffer) => ({ id, revision: 1, contentHash: digest(content) })
const now = '2026-01-01T00:00:00.000Z'
function fixture() {
  const root = tempDir('manager-asset-reads-')
  const store = new Store(join(root, 'state.db'))
  const catalog = new AssetCatalog(store, root)
  const save = (id: string, content: string, extra: Record<string, unknown> = {}) => {
    const row = {
      ...pin(id, content), kind: 'document', name: id, description: 'A description', source: { type: 'operator-import', actor: 'operator' },
      ownerProfileId: 'default', content, createdAt: now, updatedAt: now, status: 'active', archived: false, tags: ['notes'], mimeType: 'text/plain', ...extra,
    }
    store.assets.save(row)
  }
  const ticket = (id: string, conversationId: string, assetRefs?: Ticket['assetRefs']) => {
    store.conversations.save({ id: conversationId, profileId: conversationId === 'foreign-conversation' ? 'foreign' : 'default', createdAt: now, lastMessageAt: now })
    store.tickets.save({ id, title: 'Private task title', createdAt: now, conversationId, assetRefs, inputs: [] } as unknown as Ticket)
  }
  const call = (name: string, args: unknown) => executeAssetRead(name, args, catalog)
  return { root, store, catalog, save, ticket, call, close: () => store.close() }
}

describe('manager asset read facade', () => {
  it('exports five strict schemas and projects only allowlisted metadata', async () => {
    const f = fixture()
    try {
      f.save('notes', 'PRIVATE_BODY', {
        name: 'Notes /private/work/book', description: 'from https://user:secret@example.test/v', audit: ['PRIVATE_AUDIT'],
        source: { type: 'operator-import', actor: 'operator', path: '/private/source', unrelated: 'PRIVATE_SOURCE' },
      })
      expect(ASSET_READ_TOOLS.map(tool => tool.name)).toEqual(['asset_search', 'asset_get', 'asset_read_sample', 'asset_revisions', 'asset_relations'])
      expect(ASSET_READ_TOOLS.every(tool => tool.parameters.additionalProperties === false)).toBe(true)
      expect(ASSET_READ_TOOLS[2]?.parameters.required).toEqual(['id', 'revision', 'contentHash'])
      expect(await f.call('asset_search', { query: 'Notes', limit: 1 })).toMatchObject({ assets: [{ id: 'notes' }], truncated: false })
      const dto = await f.call('asset_get', { id: 'notes' })
      expect(dto).toMatchObject({ asset: { id: 'notes', name: 'Notes [redacted]', description: 'from [redacted]', ref: pin('notes', 'PRIVATE_BODY'), source: { type: 'operator-import' }, contentAccess: 'bounded-sample' } })
      expect(JSON.stringify(dto)).not.toMatch(/PRIVATE_|\/private|user:secret/)
      await expect(f.call('asset_get', { id: 'notes', profileId: 'foreign' })).rejects.toBeInstanceOf(AssetCatalogError)
      await expect(f.call('constructor', {})).rejects.toMatchObject({ status: 400, message: 'Unknown asset read tool' })
    } finally { f.close() }
  })

  it('enforces an exact ref and a byte ceiling without returning partial UTF-8', async () => {
    const f = fixture()
    try {
      const text = 'hello 🌍 and more'
      f.save('notes', text)
      const ref = pin('notes', text)
      await expect(f.call('asset_read_sample', { ...ref, maxBytes: 8 })).resolves.toEqual({ ref, sample: 'hello ', bytesReturned: 6, truncated: true, untrustedContent: true })
      await expect(f.call('asset_read_sample', ref)).resolves.toMatchObject({ sample: text, truncated: false })
      await expect(f.call('asset_read_sample', { id: ref.id, revision: 1 })).rejects.toMatchObject({ status: 400 })
      await expect(f.call('asset_read_sample', { ...ref, maxBytes: 4097 })).rejects.toMatchObject({ status: 400 })
      await expect(f.call('asset_read_sample', { ...ref, revision: 99 })).rejects.toMatchObject({ status: 409 })
      await expect(f.call('asset_read_sample', { ...ref, contentHash: '0'.repeat(64) })).rejects.toMatchObject({ status: 409 })
      const long = 'é'.repeat(3000)
      f.save('long', long)
      await expect(f.call('asset_read_sample', pin('long', long))).resolves.toMatchObject({ sample: 'é'.repeat(2048), bytesReturned: 4096, truncated: true })
    } finally { f.close() }
  })

  it('enforces owner, source, archive and deletion for every read route', async () => {
    const f = fixture()
    try {
      f.ticket('foreign-ticket', 'foreign-conversation')
      f.save('foreign-owner', 'hidden', { ownerProfileId: 'foreign' })
      f.save('foreign-source', 'hidden', { source: { ticketId: 'foreign-ticket' } })
      f.save('archived', 'hidden', { archived: true })
      f.save('deleted', 'hidden', { deletedAt: now })
      for (const id of ['foreign-owner', 'foreign-source', 'archived', 'deleted']) {
        for (const name of ['asset_get', 'asset_revisions', 'asset_relations', 'asset_read_sample']) {
          await expect(f.call(name, name === 'asset_read_sample' ? pin(id, 'hidden') : { id })).rejects.toBeInstanceOf(AssetCatalogError)
        }
      }
      await expect(f.call('asset_search', {})).resolves.toEqual({ assets: [], truncated: false })
      await expect(f.call('asset_search', { includeArchived: true })).rejects.toMatchObject({ status: 400 })
    } finally { f.close() }
  })

  it('shows authorized legacy metadata without following a Ticket path', async () => {
    const f = fixture()
    try {
      f.ticket('source-ticket', 'local-conversation')
      const fixturePath = join(f.root, 'unregistered.txt')
      await writeFile(fixturePath, 'legacy body')
      f.save('legacy', 'legacy body', { source: { ticketId: 'source-ticket', path: fixturePath } })
      const dto = await f.call('asset_get', { id: 'legacy' })
      expect(dto).toMatchObject({ asset: { contentAccess: 'metadata-only', source: { type: 'ticket-artifact' } } })
      expect(JSON.stringify(dto)).not.toContain(fixturePath)
      const resolve = vi.spyOn(f.catalog, 'resolveBytes')
      await expect(f.call('asset_read_sample', pin('legacy', 'legacy body'))).rejects.toMatchObject({ status: 409, message: expect.stringContaining('metadata-only') })
      expect(resolve).not.toHaveBeenCalled()
    } finally { f.close() }
  })

  it('reads pinned managed text with independent ownership and rejects invalid or corrupt objects safely', async () => {
    const f = fixture()
    try {
      async function managed(id: string, bytes: Buffer) {
        const storage = await new AssetObjects(f.root).put(bytes)
        f.save(id, '', { content: undefined, contentHash: digest(bytes), storageVersion: 1, storage: { kind: 'managed-object', ...storage, mimeType: 'text/plain' }, source: { ticketId: 'gone', path: '/private/original' } })
        return storage.objectKey
      }
      const bytes = Buffer.from('managed bytes')
      const objectKey = await managed('managed', bytes)
      await expect(f.call('asset_read_sample', pin('managed', bytes))).resolves.toMatchObject({ sample: 'managed bytes' })
      await writeFile(join(f.root, 'asset-objects', objectKey), 'corrupt bytes')
      await expect(f.call('asset_read_sample', pin('managed', bytes))).rejects.toMatchObject({ status: 409, message: 'Asset data unavailable or corrupt' })
      const invalid = Buffer.from([0x61, 0xc0])
      await managed('invalid', invalid)
      await expect(f.call('asset_read_sample', { ...pin('invalid', invalid), maxBytes: 1 })).rejects.toMatchObject({ status: 409, message: 'Asset is not UTF-8 text' })
    } finally { f.close() }
  })

  it('projects authorized relations and history while preserving historical pin identity', async () => {
    const f = fixture()
    try {
      const imported = f.catalog.import({ name: 'Original', text: 'body', kind: 'document' })
      const id = String(imported.id)
      f.catalog.patch(id, { name: 'Edited' })
      const ref = pin(id, 'body')
      const current = f.store.assets.get(id)!
      const revisions = current.revisions as unknown[]
      const historical = { ...current, id, kind: 'document', name: 'Edited', createdAt: now, updatedAt: now, revisions: [...revisions, { ...ref, revision: 9, name: 'PRIVATE_HISTORY', source: { ticketId: 'unverified-source' } }] }
      f.store.assets.save(historical)
      await expect(f.call('asset_read_sample', { ...ref, revision: 9 })).rejects.toMatchObject({ status: 409 })
      await expect(f.call('asset_revisions', { id })).resolves.toMatchObject({ revisions: [{ name: 'Original', ref }, { name: 'Edited', ref: { ...ref, revision: 2 } }], truncated: false })
      await expect(f.call('asset_read_sample', ref)).resolves.toMatchObject({ ref, sample: 'body' })
      f.ticket('local-ticket', 'local-conversation', [ref, pin('peer', 'other'), pin('archived-peer', 'hide')])
      f.ticket('foreign-ticket', 'foreign-conversation', [ref, pin('foreign-peer', 'hide')])
      f.save('peer', 'other')
      f.save('archived-peer', 'hide', { archived: true })
      f.save('foreign-peer', 'hide')
      const relations = await f.call('asset_relations', { id })
      expect(relations).toMatchObject({ related: [{ asset: { id: 'peer' }, relation: 'co-selected', taskCount: 1 }], references: [{ ticketId: 'local-ticket', ref, state: 'selected' }] })
      expect(JSON.stringify(relations)).not.toMatch(/archived-peer|foreign-ticket|foreign-peer|Private task title/)
    } finally { f.close() }
  })
})
