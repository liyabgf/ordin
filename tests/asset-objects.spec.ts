import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, realpathSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AssetObjects } from '../src/app/asset-objects.ts'
import { tempDir } from './helpers/temp.ts'

const fixture = () => realpathSync(tempDir('ordin-objects-'))
const keyFor = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

describe('managed asset objects', () => {
  it('persists exact bytes with private mode and idempotent no-clobber publication', async () => {
    const state = fixture()
    const bytes = Buffer.from([0, 1, 2, 255])
    const objects = new AssetObjects(state)
    const results = await Promise.all([objects.put(bytes), objects.put(bytes)])
    expect(results).toEqual([{ objectKey: keyFor(bytes), size: 4 }, { objectKey: keyFor(bytes), size: 4 }])
    expect(await new AssetObjects(state).read(results[0]!.objectKey)).toEqual(bytes)
    const path = join(state, 'asset-objects', results[0]!.objectKey)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(state, 'asset-objects'))).toEqual([results[0]!.objectKey])
    expect(await objects.put(Buffer.alloc(0))).toEqual({ objectKey: keyFor(Buffer.alloc(0)), size: 0 })
  })

  it.each(['', '../x', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), 'a'.repeat(64) + '/x', 'a'.repeat(64) + '\n'])('refuses invalid object key %s', async key => {
    await expect(new AssetObjects(fixture()).read(key)).rejects.toThrow(/Invalid managed object key/)
  })

  it('detects corruption both on read and on idempotent put without overwriting', async () => {
    const state = fixture()
    const objects = new AssetObjects(state)
    const bytes = Buffer.from('original')
    const { objectKey } = await objects.put(bytes)
    const path = join(state, 'asset-objects', objectKey)
    writeFileSync(path, 'tampered')
    await expect(objects.read(objectKey)).rejects.toThrow(/hash mismatch/)
    await expect(objects.put(bytes)).rejects.toThrow(/hash mismatch/)
    expect(statSync(path).size).toBe(8)
  })

  it.each(['store', 'file'])('rejects symbolic link %s', async which => {
    const base = fixture()
    const outside = fixture()
    let state = join(base, 'state')
    mkdirSync(state)
    const bytes = Buffer.from('private')
    const key = keyFor(bytes)
    if (which === 'store') symlinkSync(outside, join(state, 'asset-objects'))
    else { mkdirSync(join(state, 'asset-objects')); writeFileSync(join(outside, 'bytes'), bytes); symlinkSync(join(outside, 'bytes'), join(state, 'asset-objects', key)) }
    const objects = new AssetObjects(state)
    await expect(objects.put(bytes)).rejects.toThrow()
    await expect(objects.read(key)).rejects.toThrow()
    expect(readdirSync(outside)).toEqual(which === 'file' ? ['bytes'] : [])
  })

  it('accepts caller stateDir aliases and stores below the canonical directory', async () => {
    const parent = fixture()
    const state = join(parent, 'state')
    mkdirSync(state)
    symlinkSync(state, join(parent, 'alias'))
    const bytes = Buffer.from('alias-safe')
    const objects = new AssetObjects(join(parent, 'alias'))
    const { objectKey } = await objects.put(bytes)
    expect(await objects.read(objectKey)).toEqual(bytes)
    expect(readdirSync(join(state, 'asset-objects'))).toEqual([objectKey])
  })

  it('rejects oversized puts and oversized persisted objects before reads allocate', async () => {
    const state = fixture()
    const objects = new AssetObjects(state)
    await expect(objects.put(Buffer.alloc(32 * 1024 * 1024 + 1))).rejects.toThrow(/32 MiB/)
    mkdirSync(join(state, 'asset-objects'))
    const key = 'a'.repeat(64)
    const path = join(state, 'asset-objects', key)
    writeFileSync(path, '')
    truncateSync(path, 32 * 1024 * 1024 + 1)
    await expect(objects.read(key)).rejects.toThrow(/bounded regular/)
  })
})
