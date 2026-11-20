import { createHash } from 'node:crypto'
import { mkdir, open, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AssetCatalog } from '../src/app/asset-catalog.ts'
import { createArtifactSampleReader } from '../src/app/manager-artifact-reader.ts'
import { executeAssetRead } from '../src/app/manager-asset-reads.ts'
import { Store } from '../src/app/store.ts'
import type { Ticket } from '../src/core/model.ts'
import { tempDir } from './helpers/temp.ts'

vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: vi.fn(fs.open) }
})

const now = '2026-01-01T00:00:00.000Z'
const text = 'ab🌍 rest'
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const refusal = { status: 409, message: 'Ticket artifact sample unavailable or changed' }

async function fixture() {
  const root = tempDir('manager-artifact-reader-')
  const workRoot = join(root, 'work')
  const directory = join(workRoot, 'ticket')
  const path = 'out/sample.txt'
  const target = join(directory, path)
  await mkdir(join(directory, 'out'), { recursive: true })
  await writeFile(target, text)
  const store = new Store(join(root, 'state.db'))
  const catalog = new AssetCatalog(store, root)
  const readArtifactSample = createArtifactSampleReader({ catalog, store, workRoot })
  const ref = { id: 'legacy', revision: 1, contentHash: digest(text) }
  const conversation = { id: 'conversation', profileId: 'default', createdAt: now, lastMessageAt: now }
  const ticket = { id: 'ticket', title: 'Ticket', createdAt: now, conversationId: conversation.id, execution: { directory }, ended: { at: now, outcome: 'done' } } as Ticket
  const asset = { ...ref, kind: 'document', name: 'Legacy', status: 'active', archived: false, source: { ticketId: ticket.id, path }, createdAt: now, updatedAt: now }
  const save = (patch: Record<string, unknown> = {}) => store.assets.save({ ...asset, ...patch })
  const register = (file = path) => store.artifacts.save({ ticketId: ticket.id, path: file, at: now })
  store.conversations.save(conversation)
  store.tickets.save(ticket)
  save()
  register()
  return { root, workRoot, directory, path, target, store, catalog, ref, conversation, ticket, save, register, readArtifactSample }
}

async function check(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture()
  try { await run(f) } finally { f.store.close() }
}

describe('Manager legacy Ticket artifact samples', () => {
  it('reads only with the provider and emits a pinned UTF-8 sample without paths or tasks', () => check(async f => {
    const args = { ...f.ref, maxBytes: 4 }
    await expect(executeAssetRead('asset_read_sample', args, f.catalog)).rejects.toThrow('metadata-only')
    await expect(executeAssetRead('asset_read_sample', args, f.catalog, { readArtifactSample: f.readArtifactSample }))
      .resolves.toEqual({ ref: f.ref, sample: 'ab', bytesReturned: 2, truncated: true, untrustedContent: true })
    expect(f.store.tickets.list().map(t => t.id)).toEqual([f.ticket.id])
  }))

  it('hashes the full file even when only its unchanged prefix would be returned', () => check(async f => {
    await writeFile(f.target, text.replace('rest', 'best'))
    await expect(f.readArtifactSample(f.ref, 2)).rejects.toMatchObject(refusal)
    await expect(f.readArtifactSample({ ...f.ref, revision: 2 }, 2)).rejects.toMatchObject(refusal)
    await expect(f.readArtifactSample({ ...f.ref, contentHash: digest('other') }, 2)).rejects.toMatchObject(refusal)
  }))

  it('refuses missing ownership, non-success and deleted tickets', () => check(async f => {
    for (const ticket of [
      { ...f.ticket, conversationId: undefined },
      { ...f.ticket, conversationId: 'missing' },
      { ...f.ticket, ended: undefined },
      { ...f.ticket, ended: { ...f.ticket.ended!, outcome: 'stopped' as const } },
      { ...f.ticket, deleted: { at: now, assets: 'keep' as const } },
    ]) {
      f.store.tickets.save(ticket)
      await expect(f.readArtifactSample(f.ref, 2)).rejects.toMatchObject(refusal)
    }
    f.store.conversations.save({ ...f.conversation, id: 'foreign', profileId: 'foreign' })
    f.store.tickets.save({ ...f.ticket, conversationId: 'foreign' })
    await expect(f.readArtifactSample(f.ref, 2)).rejects.toMatchObject(refusal)
  }))

  it('refuses directory-covering registration, unsafe MIME and foreign or archived assets', () => check(async f => {
    f.register('out/')
    await writeFile(join(f.directory, 'out/other.txt'), text)
    for (const patch of [
      { source: { ticketId: f.ticket.id, path: 'out/other.txt' } }, { mimeType: 'image/png' },
      { ownerProfileId: 'foreign' }, { archived: true }, { deletedAt: now },
      { source: { ticketId: f.ticket.id, path: '../sample.txt' } },
    ]) {
      f.save(patch)
      await expect(f.readArtifactSample(f.ref, 2)).rejects.toMatchObject(refusal)
    }
  }))

  it('refuses an outside base and symlinks at the Ticket root, ancestor and leaf', () => check(async f => {
    const outside = join(f.root, 'outside')
    await rename(f.directory, outside)
    f.store.tickets.save({ ...f.ticket, execution: { ...f.ticket.execution!, directory: outside } })
    await expect(f.readArtifactSample(f.ref, 2)).rejects.toMatchObject(refusal)
    f.store.tickets.save(f.ticket)
    await symlink(outside, f.directory)
    await expect(f.readArtifactSample(f.ref, 2)).rejects.toMatchObject(refusal)
    const nested = join(f.workRoot, 'actual')
    await mkdir(nested)
    await symlink(join(outside, 'out'), join(nested, 'out'))
    f.store.tickets.save({ ...f.ticket, execution: { ...f.ticket.execution!, directory: nested } })
    await expect(f.readArtifactSample(f.ref, 2)).rejects.toMatchObject(refusal)
    const leaf = join(f.workRoot, 'leaf')
    await mkdir(join(leaf, 'out'), { recursive: true })
    await symlink(join(outside, f.path), join(leaf, f.path))
    f.store.tickets.save({ ...f.ticket, execution: { ...f.ticket.execution!, directory: leaf } })
    await expect(f.readArtifactSample(f.ref, 2)).rejects.toMatchObject(refusal)
  }))

  it('refuses oversized and nonregular files, and validates UTF-8 beyond the sample', () => check(async f => {
    // A correctly pinned, sparse but otherwise valid text file must still be refused for size.
    const large = Buffer.alloc(1024 * 1024 + 1, 0x61)
    await writeFile(f.target, large)
    const largeRef = { ...f.ref, contentHash: digest(large) }
    f.save(largeRef)
    await expect(f.readArtifactSample(largeRef, 2)).rejects.toMatchObject(refusal)
    const invalid = Buffer.from([0x61, 0x62, 0xff])
    await writeFile(f.target, invalid)
    const invalidRef = { ...f.ref, contentHash: digest(invalid) }
    f.save(invalidRef)
    await expect(f.readArtifactSample(invalidRef, 1)).rejects.toMatchObject(refusal)
    await rename(f.target, f.target + '.bak')
    await mkdir(f.target)
    await expect(f.readArtifactSample(invalidRef, 1)).rejects.toMatchObject(refusal)
  }))

  it('rejects a file replaced after bytes were read even when the content is identical', () => check(async f => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const realOpen = fs.open
    const spy = vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await realOpen(...args)
      const realRead = handle.read.bind(handle)
      handle.read = (async (...readArgs: Parameters<typeof realRead>) => {
        const result = await realRead(...readArgs)
        await fs.rename(f.target, f.target + '.previous')
        await fs.writeFile(f.target, text)
        return result
      }) as typeof handle.read
      return handle
    })
    try { await expect(f.readArtifactSample(f.ref, 2)).rejects.toMatchObject(refusal) }
    finally { spy.mockImplementation(realOpen) }
  }))

  it.each(['revoke', 'rewrite'] as const)('refuses after I/O starts: %s', action => check(async f => {
    const get = f.store.tickets.get.bind(f.store.tickets)
    const lookup = vi.spyOn(f.store.tickets, 'get').mockImplementation(id => {
      const ticket = get(id)
      if (ticket?.id === f.ticket.id && lookup.mock.calls.length === 2) {
        if (action === 'revoke') f.store.conversations.save({ ...f.conversation, archivedAt: now })
      }
      return ticket
    })
    if (action === 'rewrite') {
      // A replacement is identical in size and content hash, but has a different inode.
      const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      const realOpen = fs.open
      const spy = vi.mocked(open).mockImplementation(async (...args) => {
        const handle = await realOpen(...args)
        await rename(f.target, f.target + '.bak')
        await writeFile(f.target, text)
        return handle
      })
      try { await expect(f.readArtifactSample(f.ref, 2)).rejects.toMatchObject(refusal) } finally { spy.mockImplementation(realOpen) }
    } else {
      // Defer the revocation until the second catalog authorization, after disk I/O.
      lookup.mockRestore()
      const original = f.catalog.assertDescriptionRevision.bind(f.catalog)
      let checks = 0
      vi.spyOn(f.catalog, 'assertDescriptionRevision').mockImplementation((...args) => {
        if (++checks === 2) f.store.conversations.save({ ...f.conversation, archivedAt: now })
        return original(...args)
      })
      await expect(f.readArtifactSample(f.ref, 2)).rejects.toMatchObject(refusal)
    }
  }))
})
