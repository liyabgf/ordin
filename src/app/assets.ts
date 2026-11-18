import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, realpath, open } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Ticket } from '../core/model.ts'
import type { Asset, AssetKind } from '../types/index.ts'
import { AssetObjects } from './asset-objects.ts'

export interface AssetRepository {
  get(id: string): Record<string, unknown> | undefined
  save(asset: Asset): void
}
export interface AssetRegistrationOptions {
  readonly assets: AssetRepository
  readonly workRoot: string
  readonly stateDir?: string
}
const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const mimeType = (path: string): string => {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  const known: Record<string, string> = {
    md: 'text/markdown', txt: 'text/plain', log: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values',
    json: 'application/json', pdf: 'application/pdf', html: 'text/html', htm: 'text/html',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', ts: 'text/plain', tsx: 'text/plain', py: 'text/x-python', sh: 'text/x-shellscript',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zip: 'application/zip',
  }
  return Object.hasOwn(known, extension) ? known[extension]! : 'application/octet-stream'
}
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}
/** Small durable effect reference; no result content enters the queue. */
export interface AssetRegistrationPayload { readonly ticketId: string; readonly resultKey: string }
export const assetResultKey = (ticket: Ticket): string => sha256(JSON.stringify([ticket.ended, ticket.result, ticket.acceptance]))

/** One Runtime serializes registration through its durable Effects queue. */
export class AssetRegistration {
  constructor(private readonly options: AssetRegistrationOptions) {}

  async registerTicket(ticket: Ticket): Promise<readonly Asset[]> {
    if (ticket.ended?.outcome !== 'done' || (ticket.result?.files?.length ?? 0) === 0) return []
    if (ticket.execution?.directory === undefined) throw new Error('Ticket has reported assets but no execution directory')
    const acceptance = ticket.acceptance ?? { status: 'unverified' as const }
    const status = acceptance.status === 'accepted' ? 'active' : 'candidate'
    const root = resolve(ticket.execution.directory)
    const realRoot = await realpath(root)
    const realWorkRoot = await realpath(this.options.workRoot)
    if (!inside(realWorkRoot, realRoot)) throw new Error('Ticket directory is outside work root')
    const objects = this.options.stateDir === undefined ? undefined : new AssetObjects(this.options.stateDir)
    const files = ticket.result?.files ?? []
    if (objects !== undefined && files.length > 100) throw new Error('Asset task exceeds 100 files')
    let totalSize = 0
    const registered: Asset[] = []
    for (const reported of ticket.result?.files ?? []) {
      if (!reported || isAbsolute(reported) || reported.includes('\0') || reported.includes('\\') || reported.split('/').includes('..')) throw new Error('Reported asset path must be relative without traversal')
      const target = resolve(root, reported)
      if (!inside(root, target)) throw new Error('Reported asset path escapes Ticket directory')
      const rel = relative(root, target).split(sep).join('/')
      let current = root
      for (const part of rel.split('/')) {
        current = resolve(current, part)
        const info = await lstat(current)
        if (info.isSymbolicLink()) throw new Error('Reported asset uses a symbolic link')
        if (current !== target && !info.isDirectory()) throw new Error('Reported asset traverses a non-directory')
      }
      const info = await lstat(target)
      if (!info.isFile()) throw new Error('Reported asset is not a regular file')
      if (!inside(realRoot, await realpath(target))) throw new Error('Reported asset resolves outside Ticket directory')
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      let contentHash: string
      let storage: { kind: 'managed-object'; objectKey: string; size: number; mimeType: string } | undefined
      try {
        const opened = await handle.stat()
        if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error('Reported asset changed during registration')
        const hash = createHash('sha256')
        let bytes: Buffer | undefined
        if (objects !== undefined) {
          if (opened.size > 32 * 1024 * 1024) throw new Error('Asset file exceeds 32 MiB')
          if (totalSize + opened.size > 128 * 1024 * 1024) throw new Error('Asset task exceeds 128 MiB')
          totalSize += opened.size
          bytes = Buffer.alloc(opened.size)
          let offset = 0
          while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
            if (bytesRead === 0) throw new Error('Reported asset changed during copying')
            offset += bytesRead
          }
          hash.update(bytes)
        } else {
          for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
        }
        const after = await handle.stat()
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('Reported asset changed during hashing')
        contentHash = hash.digest('hex')
        if (objects !== undefined && bytes !== undefined) storage = { kind: 'managed-object', ...await objects.put(bytes), mimeType: mimeType(rel) }
      } finally { await handle.close() }
      const baseId = 'asset-' + sha256(JSON.stringify([ticket.id, rel]))
      let revision = 1
      let same: Record<string, unknown> | undefined
      for (;;) {
        const row = this.options.assets.get(revision === 1 ? baseId : baseId + '-r' + revision)
        if (row === undefined) break
        if (row.contentHash === contentHash) { same = row; break }
        revision++
      }
      if (same !== undefined) {
        if (storage !== undefined) {
          if (same.deletedAt != null || same.deleted != null || (same.ownerProfileId !== undefined && same.ownerProfileId !== 'default')) throw new Error('Cannot register deleted or foreign-owned asset')
          const upgraded = { ...same, storage, ownerProfileId: 'default', storageVersion: 1 } as unknown as Asset
          this.options.assets.save(upgraded)
          registered.push(upgraded)
        } else registered.push(same as unknown as Asset)
        continue
      }
      const id = revision === 1 ? baseId : baseId + '-r' + revision
      const at = new Date().toISOString()
      const kind: AssetKind = /\.(md|txt|log)$/i.test(rel) ? 'document'
        : /\.(csv|tsv|json)$/i.test(rel) ? 'dataset'
        : /\.(js|mjs|cjs|ts|tsx|py|sh)$/i.test(rel) ? 'code' : 'report'
      const asset: Asset = {
        id, kind, name: basename(rel), description: (ticket.result?.summary ?? '').slice(0, 200),
        source: { ticketId: ticket.id, path: rel, acceptance },
        createdAt: at, updatedAt: at, tags: [], accessLevel: 'project',
        contentHash, revision, status, archived: false, usageCount: 0,
        ...(storage === undefined ? {} : { storage, ownerProfileId: 'default', storageVersion: 1 }),
      }
      this.options.assets.save(asset)
      registered.push(asset)
    }
    return registered
  }
}
