import { isUtf8 } from 'node:buffer'
import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { validateAssetRefs, type AssetRef } from '../core/model.ts'
import { AssetCatalogError, type AssetCatalog } from './asset-catalog.ts'
import { isTextFile, resolveInside } from './files.ts'
import type { Store } from './store.ts'

const MAX_ARTIFACT_BYTES = 1024 * 1024
const MAX_SAMPLE_BYTES = 4096

type ArtifactSample = {
  ref: AssetRef
  sample: string
  bytesReturned: number
  truncated: boolean
  untrustedContent: true
}
export type ReadArtifactSample = (ref: AssetRef, maxBytes: number) => Promise<ArtifactSample>

interface ArtifactReaderOptions {
  readonly catalog: AssetCatalog
  readonly store: Store
  readonly workRoot: string
}

function unavailable(): never {
  throw new AssetCatalogError(409, 'Ticket artifact sample unavailable or changed')
}

function authorize({ catalog, store, workRoot }: ArtifactReaderOptions, ref: AssetRef) {
  // Reuse catalog access checks and its current revision/visibility fence.
  catalog.assertDescriptionRevision(ref.id, ref.revision, ref.contentHash)
  const row = store.assets.get(ref.id)
  if (row?.id !== ref.id || row.revision !== ref.revision || row.contentHash !== ref.contentHash
    || row.status !== 'active' || (row.ownerProfileId !== undefined && row.ownerProfileId !== 'default')
    || row.storageVersion !== undefined || row.storage !== undefined || row.content !== undefined) unavailable()
  const mimeType = row.mimeType
  if (mimeType !== undefined && (typeof mimeType !== 'string' || !(/^text\/[a-z\d.+-]+$/i.test(mimeType) || ['application/json', 'application/xml'].includes(mimeType)))) unavailable()

  const source = row.source as Record<string, unknown> | undefined
  const ticketId = source?.ticketId
  const path = source?.path
  if (typeof ticketId !== 'string' || ticketId.length === 0 || typeof path !== 'string' || isAbsolute(path)
    || /[\0\\]/.test(path) || path.split('/').some(part => part === '' || part === '.' || part === '..')) unavailable()
  // Legacy registration stored no MIME. Infer text only from the existing explicit text suffix allowlist.
  if (mimeType === undefined && (!isTextFile(path, 0) || extname(path).toLowerCase() === '.svg')) unavailable()
  const ticket = store.tickets.get(ticketId)
  if (ticket?.id !== ticketId || ticket.deleted !== undefined || ticket.ended?.outcome !== 'done'
    || typeof ticket.conversationId !== 'string' || ticket.conversationId.length === 0) unavailable()
  const conversation = store.conversations.get(ticket.conversationId)
  if (conversation?.id !== ticket.conversationId || conversation.profileId !== 'default'
    || conversation.deletedAt !== undefined || conversation.archivedAt !== undefined) unavailable()
  // Engine worker authorization requires a real requesting Ticket and accepts directory markers.
  // The Manager's Profile policy requires an exact registration and has no requesting Ticket.
  const artifact = store.artifacts.list(ticketId).find(entry => entry.ticketId === ticketId && entry.path === path)
  if (!artifact) unavailable()
  const directory = ticket.execution?.directory
  if (typeof directory !== 'string' || !isAbsolute(directory)) unavailable()
  const root = resolve(workRoot)
  const base = resolveInside(root, directory)
  if (!base || base === root || directory !== base || !resolveInside(base, path)) unavailable()
  return { root, base, path, mimeType, ticketId, conversationId: conversation.id, endedAt: ticket.ended.at, registeredAt: artifact.at }
}

function sameStat(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink
    && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

async function inspectPath({ root, base, path }: ReturnType<typeof authorize>) {
  const physicalRoot = await realpath(root)
  const rootStat = await lstat(root, { bigint: true })
  if (!rootStat.isDirectory()) unavailable()
  const chain = [rootStat]
  const parts = [...relative(root, base).split(sep), ...path.split('/')]
  let target = physicalRoot
  for (const [index, part] of parts.entries()) {
    target = join(target, part)
    const stat = await lstat(target, { bigint: true })
    if (index === parts.length - 1) {
      if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(MAX_ARTIFACT_BYTES)) unavailable()
    } else if (!stat.isDirectory()) unavailable()
    chain.push(stat)
  }
  if (await realpath(target) !== target) unavailable()
  return { target, chain, file: chain.at(-1)! }
}

export function createArtifactSampleReader(options: ArtifactReaderOptions): ReadArtifactSample {
  return async (input, maxBytes) => {
    try {
      const ref = validateAssetRefs([input])[0]!
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_SAMPLE_BYTES) unavailable()
      const grant = authorize(options, ref)
      const before = await inspectPath(grant)
      const handle = await open(before.target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      let bytes: Buffer
      try {
        const opened = await handle.stat({ bigint: true })
        if (!sameStat(opened, before.file)) unavailable()
        bytes = Buffer.alloc(Number(opened.size))
        for (let offset = 0; offset < bytes.length;) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
          if (bytesRead === 0) unavailable()
          offset += bytesRead
        }
        const after = await inspectPath(grant)
        if (after.target !== before.target || !before.chain.every((stat, i) => sameStat(stat, after.chain[i]!))
          || !sameStat(await handle.stat({ bigint: true }), opened)) unavailable()
      } finally {
        await handle.close()
      }
      if (createHash('sha256').update(bytes).digest('hex') !== ref.contentHash) unavailable()
      if (JSON.stringify(authorize(options, ref)) !== JSON.stringify(grant)) unavailable()
      if (bytes.includes(0) || !isUtf8(bytes)) unavailable()
      let end = Math.min(bytes.length, maxBytes)
      while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
      return { ref, sample: bytes.toString('utf8', 0, end), bytesReturned: end, truncated: end < bytes.length, untrustedContent: true }
    } catch {
      // Only the safe refusal reaches the tool caller, including on filesystem and Store failures.
      return unavailable()
    }
  }
}
