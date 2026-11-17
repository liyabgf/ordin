import { createHash } from 'node:crypto'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AssetRegistration } from '../src/app/assets.ts'
import { Store } from '../src/app/store.ts'
import type { Ticket } from '../src/core/model.ts'
import type { Asset } from '../src/types/index.ts'
import { tempDir } from './helpers/temp.ts'

function fixture() {
  const workRoot = tempDir('ordin-assets-')
  const directory = join(workRoot, 'ticket')
  mkdirSync(directory)
  const store = new Store(join(workRoot, 'state.sqlite'))
  const service = new AssetRegistration({ assets: store.assets, workRoot })
  const ticket = (id = '12345678-full-one', files = ['result.md'], status: 'accepted' | 'unverified' = 'accepted'): Ticket => ({
    id, execution: { name: 'test', directory }, ended: { outcome: 'done', at: '2026-01-01', by: 'system' },
    result: { summary: 'test', files, at: '2026-01-01' }, acceptance: { status, checkedAt: '2026-01-01' },
  } as unknown as Ticket)
  return { workRoot, directory, store, service, ticket }
}

describe('F2-B1 asset registration', () => {
  it('distinguishes sanitized path collisions and full Ticket IDs sharing eight characters', async () => {
    const f = fixture()
    try {
      for (const name of ['a-b.md', 'a_b.md']) writeFileSync(join(f.directory, name), name)
      const first = await f.service.registerTicket(f.ticket(undefined, ['a-b.md', 'a_b.md']))
      const second = await f.service.registerTicket(f.ticket('12345678-full-two', ['a-b.md']))
      expect(new Set([...first, ...second].map(a => a.id)).size).toBe(3)
      expect(first[0]!.source.ticketId).toBe('12345678-full-one')
      expect(first[0]!.source.path).toBe('a-b.md')
      const canonical = await f.service.registerTicket(f.ticket(undefined, ['./a-b.md']))
      expect(canonical[0]!.id).toBe(first[0]!.id)
    } finally { f.store.close() }
  })

  it('hashes bytes, preserves all fields on repeat, and versions changed content without overwriting', async () => {
    const f = fixture()
    try {
      const bytes = Buffer.from([0, 1, 2, 255])
      writeFileSync(join(f.directory, 'result.md'), bytes)
      const [first] = await f.service.registerTicket(f.ticket())
      expect(first).toMatchObject({ revision: 1, status: 'active', contentHash: createHash('sha256').update(bytes).digest('hex'), source: { acceptance: { status: 'accepted', checkedAt: '2026-01-01' } } })
      const edited: Asset = { ...first!, archived: true, tags: ['operator'], license: 'custom', accessLevel: 'private', usageCount: 8, name: 'operator name' }
      f.store.assets.save(edited)
      expect(await f.service.registerTicket(f.ticket())).toEqual([edited])
      writeFileSync(join(f.directory, 'result.md'), 'changed')
      const [next] = await f.service.registerTicket(f.ticket())
      expect(next).toMatchObject({ revision: 2, status: 'active' })
      expect(next!.id).not.toBe(first!.id)
      expect(next!.contentHash).not.toBe(first!.contentHash)
      expect(f.store.assets.get(first!.id)).toEqual(edited)
      writeFileSync(join(f.directory, 'result.md'), bytes)
      expect(await f.service.registerTicket(f.ticket())).toEqual([edited])
      expect(f.store.assets.list({ includeArchived: true })).toHaveLength(2)
    } finally { f.store.close() }
  })

  it('records unverified output as candidate and snapshots missing acceptance honestly', async () => {
    const f = fixture()
    try {
      writeFileSync(join(f.directory, 'result.md'), 'candidate')
      const ticket = { ...f.ticket(), acceptance: undefined }
      expect(await f.service.registerTicket(ticket)).toMatchObject([{ status: 'candidate', source: { acceptance: { status: 'unverified' } } }])
    } finally { f.store.close() }
  })

  it.each(['../outside.md', 'nested/../../outside.md', '/etc/passwd', 'outside-link.md', 'linked-dir/file.md', 'directory'])('rejects traversal, external links and nonregular file %s', async path => {
    const f = fixture()
    const outside = tempDir('ordin-assets-outside-')
    try {
      writeFileSync(join(outside, 'file.md'), 'external')
      symlinkSync(join(outside, 'file.md'), join(f.directory, 'outside-link.md'))
      symlinkSync(outside, join(f.directory, 'linked-dir'))
      mkdirSync(join(f.directory, 'directory'))
      await expect(f.service.registerTicket(f.ticket(undefined, [path]))).rejects.toThrow()
      expect(f.store.assets.list({ includeArchived: true })).toEqual([])
    } finally { f.store.close() }
  })
})
