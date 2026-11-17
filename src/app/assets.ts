import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, realpath, open } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Ticket } from '../core/model.ts'
import type { Asset, AssetKind } from '../types/index.ts'

export interface AssetRepository {
  get(id: string): Record<string, unknown> | undefined
  save(asset: Asset): void
}
export interface AssetRegistrationOptions {
  readonly assets: AssetRepository
  readonly workRoot: string
}
const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
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
      try {
        const opened = await handle.stat()
        if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error('Reported asset changed during registration')
        const hash = createHash('sha256')
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
        const after = await handle.stat()
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('Reported asset changed during hashing')
        contentHash = hash.digest('hex')
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
      if (same !== undefined) { registered.push(same as unknown as Asset); continue }
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
      }
      this.options.assets.save(asset)
      registered.push(asset)
    }
    return registered
  }
}
