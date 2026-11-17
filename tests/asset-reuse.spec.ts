import { it, expect } from 'vitest'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { AssetCatalog } from '../src/app/asset-catalog.ts'
import { tempDir } from './helpers/temp.ts'

it('pins explicit DB import content across label revisions and rejects mutations and inactive rows', () => {
  const dir = tempDir('ordin-reuse-'), store = new Store(join(dir, 'db'))
  try {
    const catalog = new AssetCatalog(store, dir)
    const imported = catalog.import({ text: 'old\r\n中文\0', name: '../../ignored', kind: 'document' })
    const first = catalog.resolve(imported.id)
    expect(first.content).toBe('old\r\n中文\0')
    expect(first.ref).toEqual({ id: imported.id, revision: 1, contentHash: imported.contentHash })
    expect(first).not.toHaveProperty('path')
    catalog.patch(String(imported.id), { name: 'new label' })
    expect(catalog.resolve(first.ref)).toEqual(first)
    const row = store.assets.get(String(imported.id))!
    store.assets.save({ ...row, content: 'tampered' } as any)
    expect(() => catalog.resolve(String(imported.id))).toThrow(/hash/i)
    store.assets.save({ ...row, archived: true } as any)
    expect(() => catalog.resolve(first.ref)).toThrow(/unavailable|archiv/i)
    store.assets.save({ ...row, deletedAt: 'now' } as any)
    expect(() => catalog.resolve(first.ref)).toThrow(/unavailable|delet/i)
    store.assets.save({ ...row, ownerProfileId: 'foreign' } as any)
    expect(() => catalog.resolve(first.ref)).toThrow(/denied/i)
    store.assets.save({ ...row, source: { path: '/etc/passwd' } } as any)
    expect(() => catalog.resolve(first.ref)).toThrow(/import/i)
  } finally { store.close() }
})
