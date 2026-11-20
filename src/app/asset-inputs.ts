import { z } from 'zod'
import { validateAssetRefs, type AssetRef, type Ticket } from '../core/model.ts'
import type { Engine } from '../core/engine.ts'
import type { Store } from './store.ts'
import { AssetCatalogError, type AssetCatalog } from './asset-catalog.ts'

const schema = z.object({
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  text: z.string().max(8000).default(''),
  assetRefs: z.array(z.unknown()).min(1).max(16),
}).strict()

/** Conversation scope is supplied by the server. Omit it for the local operator path. */
export async function addAssetInput(
  host: { engine: Engine; store: Store; assets?: AssetCatalog },
  ticketId: string,
  input: unknown,
  options?: { readonly conversationId: string; readonly signal?: AbortSignal },
) {
  const request = schema.parse(input)
  let refs: AssetRef[]
  try { refs = validateAssetRefs(request.assetRefs) }
  catch { throw new AssetCatalogError(400, 'Invalid pinned asset references') }

  const conversationId = options?.conversationId
  const assertAccess = () => {
    const ticket = host.engine.require(ticketId)
    if (options !== undefined) {
      if (typeof conversationId !== 'string' || !conversationId.trim() || ticket.conversationId !== conversationId) {
        throw new AssetCatalogError(403, 'Task is not owned by this conversation')
      }
      const conversation = host.store.conversations.get(conversationId)
      const owner = (ticket as Ticket & { ownerProfileId?: unknown }).ownerProfileId
      if (conversation?.profileId !== 'default' || conversation.archivedAt !== undefined || conversation.deletedAt !== undefined
        || (owner !== undefined && owner !== 'default')) {
        throw new AssetCatalogError(403, 'Task access denied')
      }
    } else if (ticket.conversationId !== undefined && host.store.conversations.get(ticket.conversationId)?.profileId !== 'default') {
      throw new AssetCatalogError(403, 'Task access denied')
    }
    return ticket
  }
  const findRequest = (ticket: Ticket) => ticket.inputs.find(item => item.kind === 'note' && item.requestId === request.requestId)
  const assertAccepting = (ticket: Ticket) => {
    if (ticket.ended || ticket.deleted || ticket.recovery) {
      throw new AssetCatalogError(409, 'Task ended, deleted or requires reconciliation')
    }
  }

  const ticket = assertAccess()
  const assets = host.assets
  const replay = findRequest(ticket) !== undefined
  if (!replay) {
    assertAccepting(ticket)
    if (!assets) throw new AssetCatalogError(409, 'Asset service unavailable')
    for (const ref of refs) await assets.resolveBytes(ref)
  }

  // Check all pins again at commit: an earlier pin may have been revoked while reading a later one.
  // Exact replays can report an existing receipt after completion or asset revocation.
  const next = host.store.atomic(() => {
    options?.signal?.throwIfAborted()
    const current = assertAccess()
    const prior = findRequest(current)
    if (current.deleted) assertAccepting(current)
    if (prior !== undefined) {
      if (prior.kind !== 'note' || prior.text !== request.text || JSON.stringify(prior.assetRefs) !== JSON.stringify(refs)) {
        throw new AssetCatalogError(409, 'Asset input requestId conflict')
      }
    } else {
      assertAccepting(current)
      if (replay) throw new AssetCatalogError(409, 'Asset input receipt changed')
      if (!assets) throw new AssetCatalogError(409, 'Asset service unavailable')
      for (const ref of refs) assets.resolveMetadata(ref)
    }
    return host.engine.assetNote(ticketId, request.requestId, refs, request.text)
  })
  const saved = findRequest(next)
  if (saved?.kind !== 'note') throw new AssetCatalogError(409, 'Asset input receipt missing')
  const deliveryState = saved.deliveredAt ? 'delivered' : next.ended ? 'not-delivered' : 'queued'
  const messages = {
    delivered: '已送达执行端，不代表已读取',
    'not-delivered': '任务已结束，未送达执行端',
    queued: '已保存待投递；由执行端能力决定下一轮接收',
  }
  return { requestId: request.requestId, inputId: saved.id, assetRefs: saved.assetRefs, deliveryState, message: messages[deliveryState] }
}
