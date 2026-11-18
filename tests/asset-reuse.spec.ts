import { it, expect } from 'vitest'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { AssetCatalog } from '../src/app/asset-catalog.ts'
import { tempDir } from './helpers/temp.ts'
import { AssetObjects } from '../src/app/asset-objects.ts'
import { writeFile, unlink } from 'node:fs/promises'

it('pins managed binary content independently, keeps old versions and refuses unavailable state', async()=>{
  const dir=tempDir('ordin-binary-reuse-'), store=new Store(join(dir,'db'))
  try {
    const bytes=Buffer.from([0,255,137,80,78,71]), objects=new AssetObjects(dir), blob=await objects.put(bytes), at=new Date().toISOString()
    const row={id:'binary-reference',ownerProfileId:'default',storageVersion:1,storage:{kind:'managed-object',...blob,mimeType:'image/png'},contentHash:blob.objectKey,name:'Friendly name',kind:'reference',status:'active',revision:1,source:{ticketId:'deleted-source',path:'result.png'},createdAt:at,updatedAt:at,archived:false}
    store.assets.save(row as any);const catalog=new AssetCatalog(store,dir)
    const pinned=await catalog.resolveBytes(row.id)
    expect(pinned.bytes).toEqual(bytes);expect(pinned.filename).toBe('asset-binary-reference-r1.png')
    catalog.patch(row.id,{name:'Renamed'});expect((await catalog.resolveBytes(pinned.ref)).bytes).toEqual(bytes)
    await expect(catalog.resolveBytes({...pinned.ref,contentHash:'0'.repeat(64)})).rejects.toThrow(/hash/i)
    const current=store.assets.get(row.id)!;store.assets.save({...current,archived:true} as any)
    await expect(catalog.resolveBytes(pinned.ref)).rejects.toThrow(/unavailable/)
    store.assets.save({...current,status:'candidate'} as any);await expect(catalog.resolveBytes(pinned.ref)).rejects.toThrow(/unavailable/)
    store.assets.save({...current,ownerProfileId:'foreign'} as any);await expect(catalog.resolveBytes(pinned.ref)).rejects.toThrow(/denied/)
    store.assets.save(current as any);await writeFile(join(dir,'asset-objects',blob.objectKey),'tampered')
    await expect(catalog.resolveBytes(pinned.ref)).rejects.toThrow(/hash/i)
    await unlink(join(dir,'asset-objects',blob.objectKey));await expect(catalog.resolveBytes(pinned.ref)).rejects.toThrow()
  } finally {store.close()}
})

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
