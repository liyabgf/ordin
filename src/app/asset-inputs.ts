import {z} from 'zod'
import {validateAssetRefs} from '../core/model.ts'
import type {Engine} from '../core/engine.ts'
import type {Store} from './store.ts'
import {AssetCatalog,AssetCatalogError} from './asset-catalog.ts'
const schema=z.object({requestId:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),text:z.string().max(8000).default(''),assetRefs:z.array(z.unknown()).min(1).max(16)}).strict()
/** Local operator only. Fixed-version authorization precedes a durable, idempotent domain input. */
export async function addAssetInput(host:{engine:Engine;store:Store;assets?:AssetCatalog},ticketId:string,input:unknown){
  const request=schema.parse(input);let refs;try{refs=validateAssetRefs(request.assetRefs)}catch{throw new AssetCatalogError(400,'Invalid pinned asset references')}
  const assertAccess=()=>{const ticket=host.engine.require(ticketId);if(ticket.conversationId!==undefined && host.store.conversations.get(ticket.conversationId)?.profileId!=='default')throw new AssetCatalogError(403,'Task access denied');return ticket}
  const ticket=assertAccess()
  // Exact replays may acknowledge a prior request after completion or asset revocation; they never enqueue again.
  const prior=ticket.inputs.find(item=>item.kind==='note' && item.requestId===request.requestId)
  if(!prior){
    if(ticket.ended||ticket.deleted||ticket.recovery)throw new AssetCatalogError(409,'Task ended, deleted or requires reconciliation')
    if(!host.assets)throw new AssetCatalogError(409,'Asset service unavailable')
    for(const ref of refs)await host.assets.resolveBytes(ref)
  }
  assertAccess()
  const next=host.engine.assetNote(ticketId,request.requestId,refs,request.text)
  const saved=next.inputs.find(item=>item.kind==='note' && item.requestId===request.requestId)!
  if(saved.kind!=='note')throw new AssetCatalogError(409,'Asset input receipt missing')
  const deliveryState = saved.deliveredAt ? 'delivered' : next.ended ? 'not-delivered' : 'queued'
  const messages = {
    delivered: '已送达执行端，不代表已读取',
    'not-delivered': '任务已结束，未送达执行端',
    queued: '已保存待投递；由执行端能力决定下一轮接收',
  }
  return {requestId:request.requestId,inputId:saved.id,assetRefs:saved.assetRefs,deliveryState,message:messages[deliveryState]}
}
